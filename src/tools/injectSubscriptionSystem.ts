import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { z } from "zod";
import { Project } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { withMutationReport } from "../utils/mutationTracker.js";
import { enforcePathJail } from "../utils/pathJail.js";
import { WORKSPACE_ROOT } from "../utils/workspace.js";

const injectSubscriptionSchema = z.object({
  targetSrcDirectory: z.string().describe("Absolute path to the src folder"),
  dryRun: z.boolean().default(false),
});

type InjectSubscriptionParams = typeof injectSubscriptionSchema;

function updatePrismaSchema(targetSrcDirectory: string, report: { mutatedFiles: string[] }): string {
  const schemaPath = path.resolve(targetSrcDirectory, "../prisma/schema.prisma");
  if (!fs.existsSync(schemaPath)) {
    return "[WARNING] schema.prisma not found. Skipping DB sync.";
  }

  let schemaContent = fs.readFileSync(schemaPath, "utf-8");

  if (schemaContent.includes("model User") && !schemaContent.includes("isPro")) {
    const lines = schemaContent.split("\n");
    let inUser = false;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!inUser && line.match(/^model\s+User\s*\{/)) {
        inUser = true;
      }
      if (inUser) {
        braceDepth += (line.match(/\{/g) || []).length;
        braceDepth -= (line.match(/\}/g) || []).length;

        if (braceDepth === 0) {
          const newFields = `
  isPro               Boolean   @default(false)
  gatewayCustomerId   String?
  subscriptions       Subscription[]`;
          lines.splice(i, 0, newFields);
          break;
        }
      }
    }
    schemaContent = lines.join("\n");
  }

  // Check for Plan and Subscription independently — a schema that already has
  // one but not the other (e.g. from a partial prior run) must not get a
  // second, duplicate copy of the model it already has.
  if (!schemaContent.includes("model Plan")) {
    schemaContent += `
model Plan {
  id               String         @id @default(cuid())
  name             String
  priceAmount      Int            // in cents/paise
  currency         String         @default("USD")
  interval         String         @default("month")
  stripePriceId    String?
  razorpayPlanId   String?
  subscriptions    Subscription[]
}
`;
  }

  if (!schemaContent.includes("model Subscription")) {
    schemaContent += `
model Subscription {
  id                    String   @id @default(cuid())
  userId                String
  user                  User     @relation(fields: [userId], references: [id])
  planId                String
  plan                  Plan     @relation(fields: [planId], references: [id])
  gatewaySubscriptionId String   @unique
  status                String   // PENDING, ACTIVE, CANCELLED
  currentPeriodEnd      DateTime
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
}
`;
  }

  const backup = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, "utf-8") : null;
  fs.writeFileSync(schemaPath, schemaContent, "utf-8");
  report.mutatedFiles.push(schemaPath);

  try {
    execSync("npx prisma generate", { stdio: "pipe", timeout: 30000, cwd: path.resolve(targetSrcDirectory, "..") });
    return "[SUCCESS] Prisma schema updated and client generated.";
  } catch (err: unknown) {
    // Atomic rollback: a failed `prisma generate` means the schema we just
    // wrote is invalid (e.g. duplicate model). Restore it and throw so the
    // caller reports a real ERROR instead of a SUCCESS with a buried
    // warning — tsc validation on the generated .ts files has nothing to
    // catch this, since none of them reference prisma.plan/subscription.
    if (backup !== null) {
      try {
        fs.writeFileSync(schemaPath, backup, "utf-8");
      } catch {
        throw new Error(`'npx prisma generate' failed AND rollback of schema.prisma also failed. Manual intervention required. Original error: ${err}`);
      }
    }
    throw new Error(`'npx prisma generate' failed after updating schema.prisma; schema.prisma has been reverted to its previous state.\n${String(err)}`);
  }
}

function buildStrategyInterfaces(): Map<string, string> {
  const files = new Map<string, string>();
  const project = new Project({ useInMemoryFileSystem: true });

  const interfaceFile = project.createSourceFile("subscription.interface.ts", `
export interface ISubscriptionProvider {
  createCustomer(email: string, name: string): Promise<string>;
  createPlan(name: string, amount: number, currency: string, interval: string): Promise<string>;
  createSubscription(customerId: string, planId: string): Promise<{ subscriptionId: string, clientSecret?: string }>;
}
`.trimStart());

  const stripeFile = project.createSourceFile("stripe.provider.ts", `
import Stripe from "stripe";
import { env } from "../../config/env";
import { ISubscriptionProvider } from "./subscription.interface";

export class StripeProvider implements ISubscriptionProvider {
  private stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(env.STRIPE_SECRET_KEY!, {
      apiVersion: "2023-10-16",
    });
  }

  async createCustomer(email: string, name: string): Promise<string> {
    const customer = await this.stripe.customers.create({ email, name });
    return customer.id;
  }

  async createPlan(name: string, amount: number, currency: string, interval: string): Promise<string> {
    const price = await this.stripe.prices.create({
      currency,
      unit_amount: amount,
      recurring: { interval: interval as "day" | "week" | "month" | "year" },
      product_data: { name },
    });
    return price.id;
  }

  async createSubscription(customerId: string, planId: string): Promise<{ subscriptionId: string, clientSecret?: string }> {
    const subscription = await this.stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: planId }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.payment_intent"],
    });

    const invoice = subscription.latest_invoice as Stripe.Invoice | null;
    const paymentIntent = invoice?.payment_intent as Stripe.PaymentIntent | null;

    return { 
      subscriptionId: subscription.id, 
      clientSecret: paymentIntent?.client_secret || undefined 
    };
  }
}
`.trimStart());

  const razorpayFile = project.createSourceFile("razorpay.provider.ts", `
import Razorpay from "razorpay";
import { env } from "../../config/env";
import { ISubscriptionProvider } from "./subscription.interface";

interface RazorpayPlan {
  id: string;
  period: string;
  interval: number;
  item: {
    id: string;
    active: boolean;
    amount: number;
    unit_amount: number;
    currency: string;
    name: string;
    description: string;
  };
  created_at: number;
}

interface RazorpaySubscription {
  id: string;
  plan_id: string;
  status: string;
  current_start: number | null;
  current_end: number | null;
  ended_at: number | null;
  quantity: number;
  notes: Record<string, string>;
  charge_at: number;
  total_count: number;
  paid_count: number;
  remaining_count: number;
}

interface RazorpayCustomer {
  id: string;
  name: string;
  email: string;
  contact: string;
  gstin: string | null;
  created_at: number;
}

export class RazorpayProvider implements ISubscriptionProvider {
  private razorpay: Razorpay;

  constructor() {
    this.razorpay = new Razorpay({
      key_id: env.RAZORPAY_KEY_ID as string,
      key_secret: env.RAZORPAY_SECRET as string,
    });
  }

  async createCustomer(email: string, name: string): Promise<string> {
    const customer = await this.razorpay.customers.create({ email, name }) as unknown as RazorpayCustomer;
    return customer.id;
  }

  async createPlan(name: string, amount: number, currency: string, interval: string): Promise<string> {
    const plan = await this.razorpay.plans.create({
      period: interval as "daily" | "weekly" | "monthly" | "yearly",
      interval: 1,
      item: {
        name,
        amount,
        currency,
        description: name
      }
    }) as unknown as RazorpayPlan;
    return plan.id;
  }

  async createSubscription(customerId: string, planId: string): Promise<{ subscriptionId: string, clientSecret?: string }> {
    const subscription = await this.razorpay.subscriptions.create({
      plan_id: planId,
      customer_notify: 1,
      total_count: 12,
    }) as unknown as RazorpaySubscription;
    return { subscriptionId: subscription.id };
  }
}
`.trimStart());

  const serviceFile = project.createSourceFile("subscription.service.ts", `
import { env } from "../../config/env";
import { ISubscriptionProvider } from "./subscription.interface";
import { StripeProvider } from "./stripe.provider";
import { RazorpayProvider } from "./razorpay.provider";

class SubscriptionService {
  private provider: ISubscriptionProvider;

  constructor() {
    if (env.PAYMENT_PROVIDER === "razorpay") {
      this.provider = new RazorpayProvider();
    } else {
      this.provider = new StripeProvider();
    }
  }

  async createCustomer(email: string, name: string) {
    return this.provider.createCustomer(email, name);
  }

  async createPlan(name: string, amount: number, currency: string, interval: string) {
    return this.provider.createPlan(name, amount, currency, interval);
  }

  async createSubscription(customerId: string, planId: string) {
    return this.provider.createSubscription(customerId, planId);
  }
}

export const subscriptionService = new SubscriptionService();
`.trimStart());

  files.set("subscription.interface.ts", interfaceFile.getFullText());
  files.set("stripe.provider.ts", stripeFile.getFullText());
  files.set("razorpay.provider.ts", razorpayFile.getFullText());
  files.set("subscription.service.ts", serviceFile.getFullText());

  for (const [name, content] of files.entries()) {
    const anyMatches = content.match(/\bas\s+any\b/g);
    if (anyMatches && anyMatches.length > 0) {
      throw new Error(
        `[Quality Gate] Generated file "${name}" contains ` +
        `${anyMatches.length} "as any" cast(s). ` +
        `This is a generator bug — fix the template before ` +
        `writing to disk.\n\n` +
        `Offending content preview:\n` +
        content
          .split("\n")
          .filter(l => /\bas\s+any\b/.test(l))
          .map(l => `  ${l.trim()}`)
          .join("\n")
      );
    }
  }

  return files;
}

export const injectSubscriptionSystem: Tool<FastMCPSessionAuth, InjectSubscriptionParams> = {
  name: "inject_subscription_system",
  description: "Upgrades the application to support Unified Recurring Subscriptions. Mutates the Prisma DB for Plans/Subscriptions, and builds the strategy pattern implementations.",
  parameters: injectSubscriptionSchema,

  execute: async (args) => {
    const { targetSrcDirectory, dryRun } = args;
    const projectRoot = path.resolve(targetSrcDirectory, "..");

    return withMutationReport("inject_subscription_system", dryRun ? null : projectRoot, async (report) => {
      const safeSrcDir = enforcePathJail(WORKSPACE_ROOT, path.resolve(targetSrcDirectory));
      if (dryRun) {
        report.humanMessage = `[INFO] DRY RUN: Will mutate schema.prisma and generate Strategy Providers in src/services/subscription/`;
        return;
      }

      // Snapshot schema path before mutation
      const schemaPath = path.resolve(targetSrcDirectory, "../prisma/schema.prisma");
      if (fs.existsSync(schemaPath)) {
        report.snapshotFiles([schemaPath]);
      }
      const dbResult = updatePrismaSchema(targetSrcDirectory, report);

      const subscriptionDir = path.resolve(targetSrcDirectory, "services", "subscription");
      if (!fs.existsSync(subscriptionDir)) {
        fs.mkdirSync(subscriptionDir, { recursive: true });
      }

      const files = buildStrategyInterfaces();
      // Snapshot existing files before overwriting
      const filePathsToWrite: string[] = [];
      for (const [name] of files.entries()) {
        const filePath = path.join(subscriptionDir, name);
        if (fs.existsSync(filePath)) {
          throw new Error(`Guard: File already exists: "${filePath}".`);
        }
        filePathsToWrite.push(filePath);
      }
      report.snapshotFiles(filePathsToWrite);

      let fileResult = "";
      for (const [name, content] of files.entries()) {
        const filePath = path.join(subscriptionDir, name);
        fs.writeFileSync(filePath, content, "utf-8");
        report.mutatedFiles.push(filePath);
        fileResult += `\nCreated ${name}`;
      }

      report.humanMessage = `[SUCCESS] Unified Subscription System injected.\n${dbResult}${fileResult}`;
    });
  },
};

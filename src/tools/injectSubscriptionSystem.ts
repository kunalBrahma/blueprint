import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { z } from "zod";
import { Project } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";

const injectSubscriptionSchema = z.object({
  targetSrcDirectory: z.string().describe("Absolute path to the src folder"),
  dryRun: z.boolean().default(false),
});

type InjectSubscriptionParams = typeof injectSubscriptionSchema;

function updatePrismaSchema(targetSrcDirectory: string): string {
  const schemaPath = path.resolve(targetSrcDirectory, "../prisma/schema.prisma");
  if (!fs.existsSync(schemaPath)) {
    return "[WARNING] schema.prisma not found. Skipping DB sync.";
  }

  let schemaContent = fs.readFileSync(schemaPath, "utf-8");

  // Modify User model
  if (schemaContent.includes("model User")) {
    const userBlockRegex = /(model\\s+User\\s+\\{[^}]*?)(\\n\\})/;
    const match = schemaContent.match(userBlockRegex);
    if (match && !schemaContent.includes("isPro")) {
      const newFields = `
  isPro               Boolean   @default(false)
  gatewayCustomerId   String?
  subscriptions       Subscription[]`;
      schemaContent = schemaContent.replace(userBlockRegex, `\$1\${newFields}\$2`);
    }
  }

  // Add Plan and Subscription models
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

  fs.writeFileSync(schemaPath, schemaContent, "utf-8");

  try {
    execSync("npx prisma generate", { stdio: "inherit", cwd: path.resolve(targetSrcDirectory, "..") });
    return "[SUCCESS] Prisma schema updated and client generated.";
  } catch (err: unknown) {
    return `[WARNING] Prisma schema updated but 'npx prisma generate' failed: \${err}`;
  }
}

function buildStrategyInterfaces(): Map<string, string> {
  const files = new Map<string, string>();
  const project = new Project({ useInMemoryFileSystem: true });

  // 1. Interface
  const interfaceFile = project.createSourceFile("subscription.interface.ts", `
export interface ISubscriptionProvider {
  createCustomer(email: string, name: string): Promise<string>;
  createPlan(name: string, amount: number, currency: string, interval: string): Promise<string>;
  createSubscription(customerId: string, planId: string): Promise<{ subscriptionId: string, clientSecret?: string }>;
}
`.trimStart());

  // 2. Stripe Provider
  const stripeFile = project.createSourceFile("stripe.provider.ts", `
import Stripe from "stripe";
import { env } from "../../config/env";
import { ISubscriptionProvider } from "./subscription.interface";

export class StripeProvider implements ISubscriptionProvider {
  private stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(env.STRIPE_SECRET_KEY as string, {
      apiVersion: "2023-10-16" as any,
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
      recurring: { interval: interval as any },
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

    const invoice = subscription.latest_invoice as any;
    const paymentIntent = invoice?.payment_intent as Stripe.PaymentIntent;

    return { 
      subscriptionId: subscription.id, 
      clientSecret: paymentIntent?.client_secret || undefined 
    };
  }
}
`.trimStart());

  // 3. Razorpay Provider
  const razorpayFile = project.createSourceFile("razorpay.provider.ts", `
import Razorpay from "razorpay";
import { env } from "../../config/env";
import { ISubscriptionProvider } from "./subscription.interface";

export class RazorpayProvider implements ISubscriptionProvider {
  private razorpay: Razorpay;

  constructor() {
    this.razorpay = new Razorpay({
      key_id: env.RAZORPAY_KEY_ID as string,
      key_secret: env.RAZORPAY_SECRET as string,
    });
  }

  async createCustomer(email: string, name: string): Promise<string> {
    const customer = await this.razorpay.customers.create({ email, name });
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
    }) as any;
    return plan.id;
  }

  async createSubscription(customerId: string, planId: string): Promise<{ subscriptionId: string, clientSecret?: string }> {
    const subscription = await this.razorpay.subscriptions.create({
      plan_id: planId,
      customer_notify: 1,
      total_count: 12,
    });
    return { subscriptionId: subscription.id };
  }
}
`.trimStart());

  // 4. Factory Service
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

  return files;
}

export const injectSubscriptionSystem: Tool<FastMCPSessionAuth, InjectSubscriptionParams> = {
  name: "inject_subscription_system",
  description: "Upgrades the application to support Unified Recurring Subscriptions. Mutates the Prisma DB for Plans/Subscriptions, and builds the strategy pattern implementations.",
  parameters: injectSubscriptionSchema,

  execute: async (args) => {
    const { targetSrcDirectory, dryRun } = args;

    if (dryRun) {
      return `[INFO] DRY RUN: Will mutate schema.prisma and generate Strategy Providers in src/services/subscription/`;
    }

    const dbResult = updatePrismaSchema(targetSrcDirectory);

    const subscriptionDir = path.resolve(targetSrcDirectory, "services", "subscription");
    if (!fs.existsSync(subscriptionDir)) {
      fs.mkdirSync(subscriptionDir, { recursive: true });
    }

    const files = buildStrategyInterfaces();
    let fileResult = "";
    for (const [name, content] of files.entries()) {
      const filePath = path.join(subscriptionDir, name);
      fs.writeFileSync(filePath, content, "utf-8");
      fileResult += `\\nCreated \${name}`;
    }

    return `[SUCCESS] Unified Subscription System injected.\\n\${dbResult}\${fileResult}`;
  },
};

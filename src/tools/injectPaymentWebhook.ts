import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { z } from "zod";
import { Project } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { recordInstalledPackages } from "./sdkVersions.js";
import { withMutationReport } from "../utils/mutationTracker.js";
import { enforcePathJail } from "../utils/pathJail.js";
import { WORKSPACE_ROOT } from "../utils/workspace.js";

const injectPaymentWebhookSchema = z.object({
  targetSrcDirectory: z.string().describe("Absolute path to the src folder"),
  dryRun: z.boolean().default(false),
});

type InjectPaymentWebhookParams = typeof injectPaymentWebhookSchema;

function buildWebhookController(): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile("webhook.controller.ts", "", { overwrite: true });

  sourceFile.addStatements(`
import { Request, Response } from "express";
import Stripe from "stripe";
import crypto from "crypto";
import prisma from "../config/prisma";
import { env } from "../config/env";
import { socketService } from "../services/socket.service";

const stripe = new Stripe(env.STRIPE_SECRET_KEY!, {
  apiVersion: "2023-10-16",
});

interface RazorpayWebhookPayload {
  event: string;
  payload: {
    payment: {
      entity: Record<string, unknown>;
    };
    subscription: {
      entity: {
        id: string;
        current_end: number;
      };
    };
  };
}

async function handleStripeEvent(req: Request, res: Response): Promise<void> {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = env.STRIPE_WEBHOOK_SECRET as string;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig as string, endpointSecret);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).send("Webhook Error: " + msg);
    return;
  }

  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object as Stripe.Invoice;
    const subscriptionId = invoice.subscription as string | null;

    if (subscriptionId) {
      const sub = await prisma.subscription.update({
        where: { gatewaySubscriptionId: subscriptionId },
        data: {
          status: "ACTIVE",
          currentPeriodEnd: new Date((invoice.lines.data[0]?.period.end || 0) * 1000),
        },
      });

      const user = await prisma.user.findUnique({ where: { id: sub.userId } });
      if (user && user.workspaceId) {
        await prisma.workspace.update({
          where: { id: user.workspaceId },
          data: { isPro: true },
        });
      }

      socketService.emitEvent("subscription_active", { userId: sub.userId });
    }
  }

  res.send();
}

async function handleRazorpayEvent(req: Request, res: Response): Promise<void> {
  const secret = env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers["x-razorpay-signature"];

  if (!signature) {
    res.status(400).send("No signature found");
    return;
  }

  const bodyString = req.body;
  let expectedSignature;
  try {
    expectedSignature = crypto.createHmac("sha256", secret as string).update(bodyString).digest("hex");
  } catch (e) {
    res.status(400).send("Error generating signature");
    return;
  }

  const providedSignature = Array.isArray(signature) ? signature[0] : signature;
  const expectedBuffer = Buffer.from(expectedSignature, "hex");
  const providedBuffer = Buffer.from(String(providedSignature ?? ""), "hex");
  const signatureValid =
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer);

  if (!signatureValid) {
    res.status(400).send("Invalid signature");
    return;
  }

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch (err) {
    res.status(400).send("Invalid body JSON");
    return;
  }

  if (event.event === "subscription.charged") {
    const payload = event as RazorpayWebhookPayload;
    const subscriptionId = payload.payload.subscription.entity.id;
    const endAt = payload.payload.subscription.entity.current_end;

    if (subscriptionId) {
      const sub = await prisma.subscription.update({
        where: { gatewaySubscriptionId: subscriptionId },
        data: {
          status: "ACTIVE",
          currentPeriodEnd: new Date(endAt * 1000),
        },
      });

      const user = await prisma.user.findUnique({ where: { id: sub.userId } });
      if (user && user.workspaceId) {
        await prisma.workspace.update({
          where: { id: user.workspaceId },
          data: { isPro: true },
        });
      }

      socketService.emitEvent("subscription_active", { userId: sub.userId });
    }
  }

  res.json({ status: "ok" });
}

export async function paymentWebhook(req: Request, res: Response): Promise<void> {
  const providerHint = (req.params.provider as string) || (req.headers["x-provider"] as string) || "";

  if (providerHint.toLowerCase() === "stripe" || req.headers["stripe-signature"]) {
    return handleStripeEvent(req, res);
  }

  if (providerHint.toLowerCase() === "razorpay" || req.headers["x-razorpay-signature"]) {
    return handleRazorpayEvent(req, res);
  }

  res.status(400).send("Unable to determine webhook provider. Please provide a provider name in the path or x-provider header.");
}
`.trimStart());

  sourceFile.fixUnusedIdentifiers();
  sourceFile.organizeImports();

  const generated = sourceFile.getFullText();
  const anyMatches = generated.match(/\bas\s+any\b/g);
  if (anyMatches && anyMatches.length > 0) {
    throw new Error(
      `[Quality Gate] Generated file contains ` +
      `${anyMatches.length} "as any" cast(s). ` +
      `This is a generator bug — fix the template before ` +
      `writing to disk.\n\n` +
      `Offending content preview:\n` +
      generated
        .split("\n")
        .filter(l => /\bas\s+any\b/.test(l))
        .map(l => `  ${l.trim()}`)
        .join("\n")
    );
  }
  return generated;
}

function buildWebhookRoute(): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile("webhook.routes.ts", "", { overwrite: true });

  sourceFile.addStatements(`
import { Router } from "express";
import * as express from "express";
import { paymentWebhook } from "../controllers/webhook.controller";
import { env } from "../config/env";

const router = Router();

// "/:provider" already matches "/stripe" and "/razorpay" (paymentWebhook
// reads req.params.provider), so no separate explicit routes are needed —
// those would never be reached since this route is registered first and
// doesn't call next().
router.post(["/", "/:provider"], express.raw({ type: "application/json" }), paymentWebhook);

export default router;
`.trimStart());

  sourceFile.fixUnusedIdentifiers();
  sourceFile.organizeImports();
  return sourceFile.getFullText();
}

export const injectPaymentWebhook: Tool<FastMCPSessionAuth, InjectPaymentWebhookParams> = {
  name: "inject_payment_webhook",
  description: "Builds a /api/webhooks/<provider> endpoint handling checkout.completed to update Order statuses and emit Socket.io notifications. Supports Stripe and Razorpay.",
  parameters: injectPaymentWebhookSchema,

  execute: async (args) => {
    const { targetSrcDirectory, dryRun } = args;
    const srcDir = path.resolve(targetSrcDirectory);
    const projectRoot = path.resolve(srcDir, "..");

    return withMutationReport("inject_payment_webhook", dryRun ? null : projectRoot, async (report) => {
      const safeSrcDir = enforcePathJail(WORKSPACE_ROOT, path.resolve(targetSrcDirectory));
      if (!fs.existsSync(safeSrcDir)) {
        throw new Error(`Directory not found: "${safeSrcDir}"`);
      }

      const controllersDir = path.join(safeSrcDir, "controllers");
      const routesDir = path.join(safeSrcDir, "routes");

      if (!fs.existsSync(controllersDir)) fs.mkdirSync(controllersDir, { recursive: true });
      if (!fs.existsSync(routesDir)) fs.mkdirSync(routesDir, { recursive: true });

      const controllerPath = path.join(controllersDir, "webhook.controller.ts");
      const routePath = path.join(routesDir, "webhook.routes.ts");

      if (fs.existsSync(controllerPath)) throw new Error(`Guard: ${controllerPath} already exists.`);
      if (fs.existsSync(routePath)) throw new Error(`Guard: ${routePath} already exists.`);

      const controllerCode = buildWebhookController();
      const routeCode = buildWebhookRoute();

      if (dryRun) {
        report.humanMessage = `[INFO] DRY RUN\n\n--- webhook.controller.ts ---\n${controllerCode}\n\n--- webhook.routes.ts ---\n${routeCode}`;
        return;
      }

      report.snapshotFiles([controllerPath, routePath]);


      fs.writeFileSync(controllerPath, controllerCode, "utf-8");
      report.mutatedFiles.push(controllerPath);
      fs.writeFileSync(routePath, routeCode, "utf-8");
      report.mutatedFiles.push(routePath);

      let packageWarnings = "\n\n[SUCCESS] Packages automatically installed:\n";
      try {
        const cwd = projectRoot;
        if (fs.existsSync(path.join(cwd, "package.json"))) {
          execSync("npm install stripe razorpay --save-exact", { cwd, stdio: "pipe", timeout: 30000 });
          packageWarnings += "  stripe razorpay";
          try {
            recordInstalledPackages(cwd, ["stripe", "razorpay"]);
          } catch (_) { }
        }
      } catch (err: unknown) {
        packageWarnings = "\n\n[WARNING] Failed to auto-install packages. Please manually run:\n  npm install stripe razorpay";
        report.status = "PARTIAL_FAILURE";
      }

      report.humanMessage = `[SUCCESS] Unified Subscriptions Webhook injected successfully!\n\nRemember to mount the router in server.ts:\napp.use("/api/webhooks", webhookRoutes);${packageWarnings}`;
    });
  },
};

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { Project, Node } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { recordInstalledPackages } from "./sdkVersions.js";

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

const stripe = new Stripe(env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2023-10-16" as any,
});

async function handleStripeEvent(req: Request, res: Response): Promise<void> {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = env.STRIPE_WEBHOOK_SECRET as string;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig as string, endpointSecret);
  } catch (err: any) {
    res.status(400).send("Webhook Error: " + (err && (err as any).message ? (err as any).message : String(err)));
    return;
  }

  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object as any;
    const subscriptionId = invoice.subscription as string;

    if (subscriptionId) {
      const sub = await prisma.subscription.update({
        where: { gatewaySubscriptionId: subscriptionId },
        data: {
          status: "ACTIVE",
          currentPeriodEnd: new Date(invoice.lines.data[0].period.end * 1000),
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

  if (expectedSignature !== signature) {
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
    const paymentEntity = event.payload.payment.entity;
    const subscriptionId = event.payload.subscription.entity.id;
    const endAt = event.payload.subscription.entity.current_end;

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

// Unified resolver that dynamically chooses provider at runtime by inspecting headers
export async function paymentWebhook(req: Request, res: Response): Promise<void> {
  // Prefer explicit provider path or header, else fall back to signature detection
  const providerHint = (req.params.provider as string) || (req.headers["x-provider"] as string) || "";

  if (providerHint.toLowerCase() === "stripe" || req.headers["stripe-signature"]) {
    return handleStripeEvent(req, res);
  }

  if (providerHint.toLowerCase() === "razorpay" || req.headers["x-razorpay-signature"]) {
    return handleRazorpayEvent(req, res);
  }

  // Unknown provider: attempt Stripe first (most common), then Razorpay
  try {
    return await handleStripeEvent(req, res);
  } catch (e) {
    try {
      return await handleRazorpayEvent(req, res);
    } catch (err) {
      res.status(400).send("Unable to determine webhook provider or validate signature.");
    }
  }
}
`.trimStart());
  

  sourceFile.fixUnusedIdentifiers();
  sourceFile.organizeImports();
  return sourceFile.getFullText();
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

// Unified webhook endpoint. Accepts optional provider param (e.g. /stripe, /razorpay)
// and applies raw body parsing necessary for signature verification.
router.post(["/", "/:provider"], express.raw({ type: "application/json" }), paymentWebhook);

// Backwards-compatible explicit endpoints
router.post("/stripe", express.raw({ type: "application/json" }), paymentWebhook);
router.post("/razorpay", express.raw({ type: "application/json" }), paymentWebhook);

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

    if (!fs.existsSync(srcDir)) {
      return `[ERROR] Error: Directory not found: "${srcDir}"`;
    }

    const controllersDir = path.join(srcDir, "controllers");
    const routesDir = path.join(srcDir, "routes");

    if (!fs.existsSync(controllersDir)) fs.mkdirSync(controllersDir, { recursive: true });
    if (!fs.existsSync(routesDir)) fs.mkdirSync(routesDir, { recursive: true });

    const controllerPath = path.join(controllersDir, "webhook.controller.ts");
    const routePath = path.join(routesDir, "webhook.routes.ts");

    if (fs.existsSync(controllerPath)) return '[ERROR] Guard: ' + controllerPath + ' already exists.';

    const controllerCode = buildWebhookController();
    const routeCode = buildWebhookRoute();

    if (dryRun) {
      return `[INFO] DRY RUN\\n\\n--- webhook.controller.ts ---\\n` + controllerCode + '\\n\\n--- webhook.routes.ts ---\\n' + routeCode;
    }

    fs.writeFileSync(controllerPath, controllerCode, "utf-8");
    fs.writeFileSync(routePath, routeCode, "utf-8");

    let packageWarnings = "\\n\\n[SUCCESS] Packages automatically installed:\\n";
    try {
      const execSync = require("node:child_process").execSync;
      const cwd = path.resolve(srcDir, "..");
      if (fs.existsSync(path.join(cwd, "package.json"))) {
        console.log("\\n[INFO] Auto-installing dependencies for Payment Webhooks...");
        execSync("npm install stripe razorpay --no-save --save-exact", { cwd, stdio: "inherit" });
        packageWarnings += "  stripe razorpay";
        try {
          recordInstalledPackages(cwd, ["stripe", "razorpay"]);
        } catch (_) {}
      }
    } catch (err: unknown) {
      packageWarnings = "\\n\\n[WARNING] Failed to auto-install packages. Please manually run:\\n  npm install stripe razorpay";
    }

    return '[SUCCESS] Unified Subscriptions Webhook injected successfully!\\n\\nRemember to mount the router in server.ts:\\napp.use("/api/webhooks", webhookRoutes);' + packageWarnings;
  },
};

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { Project } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { withMutationReport } from "../utils/mutationTracker.js";
import { enforcePathJail } from "../utils/pathJail.js";

const injectEnvSchema = z.object({
    targetSrcDirectory: z.string().describe("Absolute path to the src folder"),
    dryRun: z.boolean().default(false),
});

type InjectEnvParams = typeof injectEnvSchema;

function buildEnvConfig(): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("env.ts", "", { overwrite: true });

    sourceFile.addStatements(`
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  // Server
  PORT: z.string().default("3000").transform(Number),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  
  // Database
  DATABASE_URL: z.string().url(),
  
  // Auth
  JWT_SECRET: z.string().min(32, "Security Warning: JWT_SECRET should be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  
  // Storage
  STORAGE_TYPE: z.enum(["local", "s3", "r2"]).default("local"),
  
  // Redis
  REDIS_URL: z.string().url(),

  // Mail
  RESEND_API_KEY: z.string().min(1),

  // Payments
  PAYMENT_PROVIDER: z.enum(["stripe", "razorpay"]).default("stripe"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // CORS
  CORS_ORIGIN: z.string().default("*"),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error("[ERROR] Invalid Environment Variables:", JSON.stringify(_env.error.format(), null, 2));
  process.exit(1);
}

export const env = _env.data;
`.trimStart());

    sourceFile.fixUnusedIdentifiers();
    sourceFile.organizeImports();
    return sourceFile.getFullText();
}

export const injectEnvValidation: Tool<FastMCPSessionAuth, InjectEnvParams> = {
    name: "inject_env_validation",
    description: "Injects a Zod-powered environment variable validator. Ensures the app crashes immediately with a clear error if required variables (like DATABASE_URL or JWT_SECRET) are missing.",
    parameters: injectEnvSchema,

    execute: async (args) => {
        const { targetSrcDirectory, dryRun } = args;
        const projectRoot = path.resolve(targetSrcDirectory, "..");

        return withMutationReport("inject_env_validation", dryRun ? null : projectRoot, async (report) => {
            const safeSrcDir = enforcePathJail(projectRoot, path.resolve(targetSrcDirectory));
            const configDir = path.resolve(safeSrcDir, "config");
            const filePath = path.join(configDir, "env.ts");
            const envFilePath = path.join(projectRoot, ".env");

            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }

            if (fs.existsSync(filePath)) {
                throw new Error("Guard: env.ts already exists.");
            }

            const code = buildEnvConfig();

            const dummyEnvContent = `PORT=3000
NODE_ENV=development
DATABASE_URL=postgresql://user:password@localhost:5432/social_saas?schema=public
JWT_SECRET=super_secret_jwt_key_that_is_at_least_32_chars_long
JWT_EXPIRES_IN=7d
STORAGE_TYPE=local
REDIS_URL=redis://localhost:6379
RESEND_API_KEY=re_dummy_key_123
PAYMENT_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_test_dummy
STRIPE_WEBHOOK_SECRET=whsec_dummy
RAZORPAY_KEY_ID=rzp_test_dummy
RAZORPAY_SECRET=secret_dummy
RAZORPAY_WEBHOOK_SECRET=whsec_dummy
CORS_ORIGIN=*
`;

            if (dryRun) {
                report.humanMessage = code;
                return;
            }

            report.snapshotFiles([filePath]);


            fs.writeFileSync(filePath, code, "utf-8");
            report.mutatedFiles.push(filePath);

            if (!fs.existsSync(envFilePath)) {
                fs.writeFileSync(envFilePath, dummyEnvContent, "utf-8");
                report.mutatedFiles.push(envFilePath);
            }

            report.humanMessage = "[SUCCESS] Environment validation injected to src/config/env.ts and .env generated. \\n\\n[INFO] Install dependency: npm install dotenv zod";
        });
    },
};
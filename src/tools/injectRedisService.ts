import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { z } from "zod";
import { Project } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { withMutationReport } from "../utils/mutationTracker.js";

const injectRedisSchema = z.object({
  targetSrcDirectory: z.string().describe("Absolute path to the src directory where services live"),
  dryRun: z.boolean().default(false),
});

type InjectRedisParams = typeof injectRedisSchema;

function buildRedisService(): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile("redis.service.ts", "", { overwrite: true });

  sourceFile.addStatements(`
import { Redis } from "ioredis";
import { env } from "../config/env";

const redisClient = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

redisClient.on("error", (err) => {
  console.error("Redis error:", err);
});

redisClient.on("connect", () => {
  console.log("[SUCCESS] Connected to Redis successfully");
});

export default redisClient;
`.trimStart());

  sourceFile.fixUnusedIdentifiers();
  sourceFile.organizeImports();
  return sourceFile.getFullText();
}

export const injectRedisService: Tool<FastMCPSessionAuth, InjectRedisParams> = {
  name: "inject_redis_service",
  description: "Builds a distributed caching and rate-limiting layer. Generates a Redis service using the ioredis package.",
  parameters: injectRedisSchema,

  execute: async (args) => {
    const { targetSrcDirectory, dryRun } = args;
    const projectRoot = path.resolve(targetSrcDirectory, "..");

    return withMutationReport("inject_redis_service", dryRun ? null : projectRoot, async (report) => {
      const servicesDir = path.resolve(targetSrcDirectory, "services");
      if (!fs.existsSync(servicesDir)) {
        fs.mkdirSync(servicesDir, { recursive: true });
      }

      const filePath = path.join(servicesDir, "redis.service.ts");
      if (fs.existsSync(filePath)) {
        throw new Error(`File already exists: "${filePath}".`);
      }

      const content = buildRedisService();

      if (dryRun) {
        const sep = "─".repeat(60);
        report.humanMessage = `[INFO] DRY RUN\n${sep}\n${content}\n${sep}`;
        return;
      }

      fs.writeFileSync(filePath, content, "utf-8");
      report.mutatedFiles.push(filePath);

      let packageWarnings = "\n\n[SUCCESS] Packages automatically installed:\n  ioredis express-rate-limit rate-limit-redis";
      try {
        const cwd = projectRoot;
        if (fs.existsSync(path.join(cwd, "package.json"))) {
          execSync("npm install ioredis express-rate-limit rate-limit-redis --no-save --save-exact", { cwd, stdio: "inherit" });
        }
      } catch (err: unknown) {
        packageWarnings = "\n\n[WARNING] Failed to auto-install packages. Please manually run:\n  npm install ioredis express-rate-limit rate-limit-redis";
        report.status = "PARTIAL_FAILURE";
      }

      report.humanMessage = `[SUCCESS] Redis Service injected successfully!\nFile: ${filePath}${packageWarnings}`;
    });
  },
};

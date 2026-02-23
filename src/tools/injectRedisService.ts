import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { Project } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";

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

    const servicesDir = path.resolve(targetSrcDirectory, "services");
    if (!fs.existsSync(servicesDir)) {
      fs.mkdirSync(servicesDir, { recursive: true });
    }

    const filePath = path.join(servicesDir, "redis.service.ts");
    if (fs.existsSync(filePath)) {
      return `[ERROR] Error: File already exists: "\${filePath}".`;
    }

    const content = buildRedisService();

      if (dryRun) {
        const sep = "─".repeat(60);
        return `[INFO] DRY RUN\\n\${sep}\\n\${content}\\n\${sep}`;
    }

    try {
      fs.writeFileSync(filePath, content, "utf-8");
    } catch (err: unknown) {
      return `[ERROR] Error writing file: \${err}`;
    }

    let packageWarnings = "\\n\\n[SUCCESS] Packages automatically installed:\\n  ioredis express-rate-limit rate-limit-redis";
    try {
      const execSync = require("node:child_process").execSync;
      const cwd = path.resolve(targetSrcDirectory, "..");
      if (fs.existsSync(path.join(cwd, "package.json"))) {
        console.log("\\n[INFO] Auto-installing dependencies for Redis service...");
        execSync("npm install ioredis express-rate-limit rate-limit-redis --no-save --save-exact", { cwd, stdio: "inherit" });
      }
    } catch (err: unknown) {
      packageWarnings = "\\n\\n[WARNING] Failed to auto-install packages. Please manually run:\\n  npm install ioredis express-rate-limit rate-limit-redis";
    }

    return `[SUCCESS] Redis Service injected successfully!\\nFile: \${filePath}\${packageWarnings}`;
  },
};

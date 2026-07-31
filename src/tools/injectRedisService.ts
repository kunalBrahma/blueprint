import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { z } from "zod";
import { Project } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { withMutationReport } from "../utils/mutationTracker.js";
import { enforcePathJail } from "../utils/pathJail.js";
import { WORKSPACE_ROOT } from "../utils/workspace.js";

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

redisClient.on("error", (err: Error) => {
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
      const safeSrcDir = enforcePathJail(WORKSPACE_ROOT, path.resolve(targetSrcDirectory));
      const servicesDir = path.resolve(safeSrcDir, "services");
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

      report.snapshotFiles([filePath]);


      fs.writeFileSync(filePath, content, "utf-8");
      report.mutatedFiles.push(filePath);

      let packageWarnings = "\n\n[SUCCESS] Packages automatically installed:\n  ioredis express-rate-limit rate-limit-redis";
      try {
        const cwd = projectRoot;
        if (fs.existsSync(path.join(cwd, "package.json"))) {
          const pkgJsonPath = path.join(cwd, "package.json");
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
          const allDeps = { ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) };

          const pkgs = ["ioredis", "express-rate-limit", "rate-limit-redis"];
          // @types/node is required by ioredis in strict TypeScript projects
          const devPkgs = ["@types/node"];

          const need = pkgs.filter(p => !allDeps[p]);
          const needDev = devPkgs.filter(p => !allDeps[p]);

          if (need.length > 0) {
            execSync(`npm install ${need.join(" ")} --save-exact`, { cwd, stdio: "pipe", timeout: 30000 });
          }
          if (needDev.length > 0) {
            execSync(`npm install -D ${needDev.join(" ")} --save-exact`, { cwd, stdio: "pipe", timeout: 30000 });
          }
        }
      } catch (err: unknown) {
        packageWarnings = "\n\n[WARNING] Failed to auto-install packages. Please manually run:\n  npm install ioredis express-rate-limit rate-limit-redis\n  npm install -D @types/node";
        report.status = "PARTIAL_FAILURE";
      }

      report.humanMessage = `[SUCCESS] Redis Service injected successfully!\nFile: ${filePath}${packageWarnings}`;
    });
  },
};

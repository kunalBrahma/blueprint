import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { FastMCPSessionAuth, Tool } from "fastmcp";

const injectApiTestsSchema = z.object({
    targetRootDirectory: z.string().describe("Absolute path to the root directory (where package.json and src/ live)"),
    dryRun: z.boolean().default(false),
});

type InjectApiTestsParams = typeof injectApiTestsSchema;

function buildVitestConfig(): string {
    return `
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["dotenv/config"],
    testTimeout: 10000,
  },
});
`.trimStart();
}

function buildAuthTest(): string {
    return `
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
// Fallback app import assumes standard entrypoint structure
import app from "../app"; 

describe("Auth Endpoints", () => {
  it("POST /api/auth/login - should return 400 for validation error", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "not-an-email" });
    
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("POST /api/auth/login - should return 401 for invalid credentials", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "test@example.com", password: "wrongpassword123" });
    
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});
`.trimStart();
}

export const injectApiTests: Tool<FastMCPSessionAuth, InjectApiTestsParams> = {
    name: "inject_api_tests",
    description: "Scaffolds automated integration tests utilizing vitest and supertest.",
    parameters: injectApiTestsSchema,

    execute: async (args) => {
        const { targetRootDirectory, dryRun } = args;

        const rootDir = path.resolve(targetRootDirectory);
        if (!fs.existsSync(rootDir)) {
            return `[ERROR] Error: Root directory not found: "\${rootDir}"`;
    }

    const testsDir = path.join(rootDir, "src", "__tests__");
    if (!fs.existsSync(testsDir)) {
      fs.mkdirSync(testsDir, { recursive: true });
    }

    const vitestConfigPath = path.join(rootDir, "vitest.config.ts");
    const authTestPath = path.join(testsDir, "auth.test.ts");

    if (fs.existsSync(authTestPath)) {
      return `[ERROR] Error: File already exists: "\${authTestPath}".`;
    }

    const vitestContent = buildVitestConfig();
    const testContent = buildAuthTest();

          if (dryRun) {
            const sep = "─".repeat(60);
            return `[INFO] DRY RUN\\n\${sep}\\n\${vitestConfigPath}\\n\${sep}\\n\${vitestContent}\\n\\n\${sep}\\n\${authTestPath}\\n\${sep}\\n\${testContent}`;
    }

    try {
      if (!fs.existsSync(vitestConfigPath)) {
        fs.writeFileSync(vitestConfigPath, vitestContent, "utf-8");
      }
      fs.writeFileSync(authTestPath, testContent, "utf-8");
    } catch (err: unknown) {
      return `[ERROR] Error writing file: \${err}`;
    }

    let packageWarnings = "\\n\\n[INFO] Packages automatically installed:\\n  vitest supertest @types/supertest";
    try {
      const execSync = require("node:child_process").execSync;
      const cwd = rootDir;
      if (fs.existsSync(path.join(cwd, "package.json"))) {
        const pkgs = ["vitest", "supertest", "@types/supertest"];
        const pkgJsonPath = path.join(cwd, "package.json");
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
        const allDeps = { ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) };
        const need = pkgs.filter(p => !allDeps[p]);
        if (need.length > 0) {
          const installCmd = `npm install -D ${need.join(" ")} --no-save --save-exact`;
          execSync(installCmd, { cwd, stdio: "inherit" });
        }

        // Add test script to package.json
        pkgJson.scripts = pkgJson.scripts || {};
        if (!pkgJson.scripts.test) {
          pkgJson.scripts.test = "vitest run";
          fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2), "utf-8");
        }
      }
    } catch (err: unknown) {
      packageWarnings = "\\n\\n[WARNING] Failed to auto-install packages. Please manually run:\\n  npm install -D vitest supertest @types/supertest";
    }

    return `[SUCCESS] API Tests scaffolded successfully!\\nTest File: \${authTestPath}\${packageWarnings}`;
  },
};

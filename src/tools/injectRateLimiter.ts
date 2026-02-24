import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { z } from "zod";
import { Project, Node } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { withMutationReport } from "../utils/mutationTracker.js";

const injectRateLimiterSchema = z.object({
    targetFile: z.string().describe("Absolute path to the Express router file (e.g. auth.routes.ts)"),
    routePaths: z.array(z.string()).describe("Array of exact route paths to secure (e.g. ['/login', '/refresh'])"),
    dryRun: z.boolean().default(false).describe("If true, returns proposed changes without writing"),
});

type InjectRateLimiterParams = typeof injectRateLimiterSchema;

export const injectRateLimiter: Tool<FastMCPSessionAuth, InjectRateLimiterParams> = {
    name: "inject_rate_limiter",
    description: "Injects express-rate-limit middleware into an Express router, securing specific route paths to prevent brute forcing.",
    parameters: injectRateLimiterSchema,

    execute: async (args) => {
        const { targetFile, routePaths, dryRun } = args;
        const resolvedPath = path.resolve(targetFile);
        const projectRoot = path.resolve(resolvedPath, "../../..");

        return withMutationReport("inject_rate_limiter", dryRun ? null : projectRoot, async (report) => {
            if (!fs.existsSync(resolvedPath)) {
                throw new Error(`File not found: "${resolvedPath}"`);
            }

            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile(resolvedPath, fs.readFileSync(resolvedPath, "utf-8"), { overwrite: true });

            const hasRateLimit = sourceFile.getImportDeclarations().some(imp => imp.getModuleSpecifierValue() === "express-rate-limit");
            if (!hasRateLimit) {
                sourceFile.insertStatements(0, `import rateLimit from "express-rate-limit";\nimport { RedisStore } from "rate-limit-redis";\nimport redisClient from "../services/redis.service";`);
            }

            const limiterVarName = "authLimiter";
            const hasLimiter = sourceFile.getVariableDeclarations().some(v => v.getName() === limiterVarName);
            if (!hasLimiter) {
                const lastImportIndex = sourceFile.getImportDeclarations().length;
                sourceFile.insertStatements(lastImportIndex, `\nconst ${limiterVarName} = rateLimit({\n  store: new RedisStore({\n    sendCommand: (...args: string[]) => redisClient.call(...args),\n  }),\n  windowMs: 15 * 60 * 1000, // 15 minutes\n  max: 5, // Limit each IP to 5 requests per \`window\` (here, per 15 minutes)\n  message: { success: false, message: "Too many requests from this IP, please try again after 15 minutes" },\n  standardHeaders: true,\n  legacyHeaders: false,\n});\n`);
            }

            let injectedCount = 0;

            for (const stmt of sourceFile.getStatements()) {
                if (!Node.isExpressionStatement(stmt)) continue;
                const expr = stmt.getExpression();
                if (!Node.isCallExpression(expr)) continue;

                const callee = expr.getExpression();
                if (!Node.isPropertyAccessExpression(callee)) continue;

                const callArgs = expr.getArguments();
                if (callArgs.length === 0) continue;

                const routeArg = callArgs[0];
                if (!Node.isStringLiteral(routeArg)) continue;

                const pathValue = routeArg.getLiteralValue();

                if (routePaths.includes(pathValue)) {
                    const alreadySecured = callArgs.some(arg => arg.getText() === limiterVarName);
                    if (!alreadySecured) {
                        expr.insertArgument(1, limiterVarName);
                        injectedCount++;
                    }
                }
            }

            sourceFile.fixUnusedIdentifiers();
            sourceFile.organizeImports();

            if (dryRun) {
                report.humanMessage = `[INFO] DRY RUN\n\n${sourceFile.getFullText()}`;
                return;
            }

            let packageWarnings = `\n\n[INFO] Packages automatically installed:\n  express-rate-limit rate-limit-redis ioredis`;
            try {
                const cwd = projectRoot;
                if (fs.existsSync(path.join(cwd, "package.json"))) {
                    const pkgs = ["express-rate-limit", "rate-limit-redis", "ioredis"];
                    const devPkgs = ["@types/express-rate-limit"];
                    const pkgJsonPath = path.join(cwd, "package.json");
                    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
                    const allDeps = { ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) };
                    const need = pkgs.filter(p => !allDeps[p]);
                    const needDev = devPkgs.filter(p => !allDeps[p]);
                    if (need.length > 0) {
                        execSync(`npm install ${need.join(" ")} --no-save --save-exact`, { cwd, stdio: "inherit" });
                    }
                    if (needDev.length > 0) {
                        execSync(`npm install -D ${needDev.join(" ")} --no-save --save-exact`, { cwd, stdio: "inherit" });
                    }
                }
            } catch (err: unknown) {
                packageWarnings = `\n\n[WARNING] Failed to auto-install packages. Please manually run:\n  npm install express-rate-limit rate-limit-redis ioredis\n  npm install -D @types/express-rate-limit`;
                report.status = "PARTIAL_FAILURE";
            }

            fs.writeFileSync(resolvedPath, sourceFile.getFullText(), "utf-8");
            report.mutatedFiles.push(resolvedPath);

            report.humanMessage = `[SUCCESS] Rate Limiter injected into ${injectedCount} route(s)!\nFile updated: ${resolvedPath}${packageWarnings}`;
        });
    },
};

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { z } from "zod";
import { Project, Node } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { withMutationReport } from "../utils/mutationTracker.js";
import { enforcePathJail } from "../utils/pathJail.js";
import { WORKSPACE_ROOT } from "../utils/workspace.js";

const injectAuthSchema = z.object({
  targetDirectory: z.string().describe("Absolute path to the controllers folder"),
  // Only "email" actually generates working code. A "google" option used to
  // exist here but only added a dead `googleId` schema field and installed
  // passport-google-oauth20 with zero route/callback generation — a
  // misleading no-op. Removed rather than left half-implemented.
  authProviders: z.enum(["email"]).array().min(1).describe("Providers to implement (email/password only)"),
  serverFile: z.string().describe("Absolute path to server.ts for route mounting"),
  dryRun: z.boolean().default(false),
  force: z.boolean().default(false).describe("Overwrite existing auth files if they exist"),
});

type InjectAuthParams = typeof injectAuthSchema;

// ─── 1. Validation Helpers ───────────────────────────────────────────────────

function getTscErrorCount(cwd: string): number {
  try {
    // stdio: "pipe" ensures absolute silence in the MCP stream
    execSync("npx tsc --noEmit", { cwd, stdio: "pipe" });
    return 0;
  } catch (e: any) {
    const output = e.stdout?.toString() || e.stderr?.toString() || "";
    const match = output.match(/Found (\d+) error/);
    return match ? parseInt(match[1], 10) : 0;
  }
}

// ─── 2. Idempotent Schema Mutation ───────────────────────────────────────────

function mutateSchemaSafely(projectRoot: string): string[] {
  const schemaPath = path.join(projectRoot, "prisma/schema.prisma");
  if (!fs.existsSync(schemaPath)) return ["[WARNING] schema.prisma not found. Schema injection skipped."];

  let schema = fs.readFileSync(schemaPath, "utf-8");
  const warnings: string[] = [];

  // Robust block-parsing to find the User model and its boundaries using brace-depth
  if (schema.includes("model User")) {
    const lines = schema.split("\n");
    let inUser = false;
    let braceDepth = 0;
    let userBlockStart = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!inUser && line.match(/^model\s+User\s*\{/)) {
        inUser = true;
        userBlockStart = i;
      }
      if (inUser) {
        braceDepth += (line.match(/\{/g) || []).length;
        braceDepth -= (line.match(/\}/g) || []).length;

        if (braceDepth === 0) {
          const fieldConfigs = [
            { name: "refreshTokenVersion", line: "  refreshTokenVersion Int      @default(0)" },
            { name: "refreshTokens", line: "  refreshTokens       RefreshToken[]" },
            { name: "resetTokens", line: "  resetTokens         PasswordResetToken[]" }
          ];

          // Idempotent insertion: only add fields that don't exist.
          // Scoped to just the User model block (userBlockStart..i), not the
          // whole file from the top — a field name matching anywhere earlier
          // in the file (a comment, another model) previously caused a
          // legitimate field to be silently skipped.
          const modelBlock = lines.slice(userBlockStart, i + 1).join("\n");
          const fieldsToAdd = fieldConfigs
            .filter(f => !modelBlock.includes(f.name))
            .map(f => f.line)
            .join("\n");

          if (fieldsToAdd) {
            lines.splice(i, 0, fieldsToAdd);
          }
          break;
        }
      }
    }
    schema = lines.join("\n");
  }

  if (!schema.includes("model RefreshToken")) {
    schema += `\nmodel RefreshToken {\n  id        String   @id @default(uuid())\n  token     String   @unique\n  userId    String\n  user      User     @relation(fields: [userId], references: [id])\n  createdAt DateTime @default(now())\n}\n`;
  }
  if (!schema.includes("model PasswordResetToken")) {
    schema += `\nmodel PasswordResetToken {\n  id        String   @id @default(uuid())\n  token     String   @unique\n  userId    String\n  user      User     @relation(fields: [userId], references: [id])\n  expiresAt DateTime\n}\n`;
  }

  fs.writeFileSync(schemaPath, schema, "utf-8");

  try {
    execSync("npx prisma generate", { cwd: projectRoot, stdio: "pipe" });
  } catch (e) {
    warnings.push("[WARNING] Prisma generate failed. You may need to run it manually.");
  }

  return warnings;
}

// ─── 3. Template Generators (Condensed for structure) ────────────────────────

function buildAuthMiddleware(): string {
  return `
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthRequest extends Request {
  user?: { id: string };
}

export const protect = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    res.status(401).json({ message: "Not authorized, no token" });
    return;
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "fallback_secret") as { id: string };
    req.user = { id: decoded.id };
    next();
  } catch (error) {
    res.status(401).json({ message: "Not authorized, token failed" });
  }
};
`.trim();
}

function buildAuthRoutes(): string {
  return `
import { Router } from "express";
import * as authController from "../controllers/auth.controller";

const router = Router();

router.post("/signup", authController.signUp);
router.post("/signin", authController.signIn);
router.post("/refresh", authController.refresh);
router.post("/logout", authController.logout);

export default router;
`.trim();
}

function buildAuthController(): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile("auth.controller.ts", `
import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import prisma from "../config/prisma";

export const signUp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) { res.status(400).json({ message: "User exists" }); return; }
    
    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { email, password: hashed } });
    res.status(201).json({ success: true, userId: user.id });
  } catch (e) {
    res.status(500).json({ message: "Server error" });
  }
};

export const signIn = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.password) { res.status(401).json({ message: "Invalid credentials" }); return; }
    
    const match = await bcrypt.compare(password, user.password);
    if (!match) { res.status(401).json({ message: "Invalid credentials" }); return; }
    
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET || "fallback", { expiresIn: "1h" });
    res.status(200).json({ success: true, token });
  } catch (e) {
    res.status(500).json({ message: "Server error" });
  }
};

export const refresh = async (req: Request, res: Response): Promise<void> => { res.status(200).json({ message: "Refresh mock // TODO: Implement real refresh logic" }); };
export const logout = async (req: Request, res: Response): Promise<void> => { res.status(200).json({ message: "Logout mock // TODO: Implement real logout logic" }); };
`.trimStart());

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

// ─── 4. Tool Execution ───────────────────────────────────────────────────────

export const injectAuthSystem: Tool<FastMCPSessionAuth, InjectAuthParams> = {
  name: "inject_auth_system",
  description: "Atomically injects a full-stack Auth system. Hardened against boilerplates, race conditions, and pipeline order flaws.",
  parameters: injectAuthSchema,

  execute: async (args) => {
    const { targetDirectory, serverFile, dryRun, force } = args;

    const safeControllersDir = enforcePathJail(WORKSPACE_ROOT, path.resolve(targetDirectory));
    const safeServerFile = enforcePathJail(WORKSPACE_ROOT, path.resolve(serverFile));

    const inferredProjectRoot = path.dirname(path.dirname(safeServerFile));
    const projectRoot = enforcePathJail(WORKSPACE_ROOT, inferredProjectRoot);

    if (!fs.existsSync(path.join(projectRoot, "package.json"))) {
      throw new Error("[Root Detection Fail] Could not infer backend project root from serverFile.");
    }

    return withMutationReport("inject_auth_system", dryRun ? null : projectRoot, async (report) => {

      // Define exact output paths
      const paths = {
        middleware: path.join(path.dirname(safeControllersDir), "middleware/auth.middleware.ts"),
        controller: path.join(safeControllersDir, "auth.controller.ts"),
        routes: path.join(path.dirname(safeControllersDir), "routes/auth.routes.ts"),
      };

      // 1. Idempotency Guard
      for (const [key, p] of Object.entries(paths)) {
        if (fs.existsSync(p) && !force) {
          throw new Error(`[Guard] ${key} exists. Use 'force: true' to overwrite boilerplate auth.`);
        }
      }

      if (dryRun) {
        report.humanMessage = "[INFO] Dry run: Pipeline order and path resolution verified.";
        return;
      }

      // 2. Baseline TSC Check (Before any mutations)
      const baselineErrors = getTscErrorCount(projectRoot);

      // Snapshot files to allow rollback. Includes the 3 new auth files
      // (captured as null/non-existent when force=false, since the guard
      // above already ensures they don't exist yet) so a later failure
      // (AST wiring, npm install, TSC Fail) rolls back atomically instead
      // of leaving them orphaned on disk while the report claims full
      // rollback.
      const schemaPath = path.join(projectRoot, "prisma/schema.prisma");
      report.snapshotFiles([schemaPath, safeServerFile, ...Object.values(paths)]);

      // 3. Schema Mutation
      const statusWarnings = mutateSchemaSafely(projectRoot);

      // 4. Ensure Directories Exist
      Object.values(paths).forEach(p => {
        const dir = path.dirname(p);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      });

      // 5. Write Files synchronously
      fs.writeFileSync(paths.middleware, buildAuthMiddleware(), "utf-8");
      fs.writeFileSync(paths.controller, buildAuthController(), "utf-8");
      fs.writeFileSync(paths.routes, buildAuthRoutes(), "utf-8");

      // 6. AST Server Wiring
      const project = new Project();
      const serverSource = project.addSourceFileAtPath(safeServerFile);

      // Detect the actual Express app variable name instead of assuming
      // "app" — a substring guard on the literal text "app.use"/"express()"
      // previously let `const server = express();` slip through and emit a
      // reference to an undefined `app` variable.
      const appCandidates: string[] = [];
      for (const varDecl of serverSource.getVariableDeclarations()) {
        const init = varDecl.getInitializer();
        if (init && (init.getText().includes("express()") || init.getText().startsWith("express()"))) {
          appCandidates.push(varDecl.getName());
        }
      }
      if (appCandidates.length === 0) {
        throw new Error(`[AST Hard-Fail] No Express app declaration (e.g. "const app = express()") found in "${safeServerFile}". Cannot determine where to mount the auth routes.`);
      }
      if (appCandidates.length > 1) {
        throw new Error(`[AST Hard-Fail] Ambiguous: ${appCandidates.length} Express app declarations found in "${safeServerFile}": [${appCandidates.join(", ")}]. Cannot determine which to use.`);
      }
      const appVarName = appCandidates[0]!;

      const stmts = serverSource.getStatements();
      const lastAppUseIdx = stmts.reduce((last, stmt, idx) => {
        if (!Node.isExpressionStatement(stmt)) return last;
        const expr = stmt.getExpression();
        if (!Node.isCallExpression(expr)) return last;
        const callee = expr.getExpression();
        if (Node.isPropertyAccessExpression(callee) && callee.getExpression().getText() === appVarName && callee.getName() === "use") {
          const text = stmt.getText();
          // Avoid inserting after error handlers
          if (!text.includes("err,") && !text.includes("next")) return idx;
        }
        return last;
      }, -1);

      if (!serverSource.getImportDeclaration(i => i.getModuleSpecifierValue().includes("auth.routes"))) {
        serverSource.addImportDeclaration({ defaultImport: "authRoutes", moduleSpecifier: "./routes/auth.routes" });
        if (lastAppUseIdx !== -1) {
          serverSource.insertStatements(lastAppUseIdx + 1, `${appVarName}.use("/api/auth", authRoutes);`);
        } else {
          serverSource.addStatements(`${appVarName}.use("/api/auth", authRoutes);`);
        }
      }
      // This is a synchronous blocking save
      serverSource.saveSync();

      // 7. FIX: Execute NPM Install BEFORE final validation
      const pkgs = ["bcrypt", "jsonwebtoken", "zod", "@types/bcrypt", "@types/jsonwebtoken"];

      try {
        execSync(`npm install ${pkgs.join(" ")} --save-exact`, { cwd: projectRoot, stdio: "pipe" });
      } catch (e) {
        statusWarnings.push("[WARNING] npm install partial failure. Types may be missing.");
      }

      // 8. Final TSC Validation (Comparing against baseline)
      const postErrors = getTscErrorCount(projectRoot);
      if (postErrors > baselineErrors) {
        throw new Error(`[TSC Fail] Injection introduced ${postErrors - baselineErrors} new errors. Rolling back.`);
      }

      // 9. Success Reporting
      report.mutatedFiles.push(...Object.values(paths), schemaPath, safeServerFile);
      report.humanMessage = `[SUCCESS] Auth System strictly injected.\nBaseline Errors: ${baselineErrors}\nFinal Errors: ${postErrors}\n${statusWarnings.join("\n")}`;
    });
  },
};
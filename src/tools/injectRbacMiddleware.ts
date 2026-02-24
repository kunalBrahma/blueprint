import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { Project, Node } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { withMutationReport } from "../utils/mutationTracker.js";

// ─── 1. Constants ──────────────────────────────────────────────────────────────

// Roles are now dynamic strings provided by the user per-project, making this a universal tool.

// ─── 2. Zod Schema ────────────────────────────────────────────────────────────

const injectRbacSchema = z.object({
    targetFile: z
        .string()
        .describe("Absolute path to the Express TypeScript router file to secure"),
    routePath: z
        .string()
        .describe('The exact route path string, e.g. "/" or "/add"'),
    method: z
        .enum(["get", "post", "put", "delete", "patch"])
        .describe("HTTP method of the route to secure"),
    allowedRoles: z
        .array(z.string())
        .min(1)
        .describe("Array of roles permitted to access this route (e.g., ['SUPERADMIN', 'EDITOR'])"),
    dryRun: z
        .boolean()
        .default(false)
        .describe("If true, returns the proposed file content WITHOUT writing to disk"),
});

type InjectRbacParams = typeof injectRbacSchema;

// ─── 3. The requireRoles Middleware Template ───────────────────────────────────

const REQUIRE_ROLES_TEMPLATE = `
export interface AuthRequest extends Request {
  user?: { role?: string; [key: string]: unknown };
}

export function requireRoles(roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthRequest;
    const userRole = authReq.user?.role; // req.user populated by auth middleware
    if (!userRole || !roles.includes(userRole)) {
      return res.status(403).json({ success: false, message: "Forbidden: Insufficient permissions" });
    }
    next();
  };
}
`.trimStart();

// ─── 4. AST Helpers ───────────────────────────────────────────────────────────

function ensureExpressTypeImports(
    sourceFile: ReturnType<InstanceType<typeof Project>["createSourceFile"]>
): void {
    const expressImport = sourceFile.getImportDeclaration(
        (imp) => imp.getModuleSpecifierValue() === "express"
    );

    const needed = ["Request", "Response", "NextFunction"];

    if (!expressImport) {
        sourceFile.addImportDeclaration({
            namedImports: needed,
            moduleSpecifier: "express",
        });
        return;
    }

    const existingNames = expressImport.getNamedImports().map((n) => n.getName());
    const missingNames = needed.filter((n) => !existingNames.includes(n));

    if (missingNames.length > 0) {
        expressImport.addNamedImports(missingNames);
    }
}

function hasRequireRoles(
    sourceFile: ReturnType<InstanceType<typeof Project>["createSourceFile"]>
): boolean {
    for (const varDecl of sourceFile.getVariableDeclarations()) {
        if (varDecl.getName() === "requireRoles") return true;
    }
    for (const imp of sourceFile.getImportDeclarations()) {
        if (imp.getNamedImports().some((n) => n.getName() === "requireRoles")) return true;
    }
    return false;
}

function findRouteCall(
    sourceFile: ReturnType<InstanceType<typeof Project>["createSourceFile"]>,
    method: string,
    routePath: string
) {
    for (const stmt of sourceFile.getStatements()) {
        if (!Node.isExpressionStatement(stmt)) continue;

        const expr = stmt.getExpression();
        if (!Node.isCallExpression(expr)) continue;

        const callee = expr.getExpression();
        if (!Node.isPropertyAccessExpression(callee)) continue;

        if (callee.getName() !== method) continue;

        const args = expr.getArguments();
        if (args.length === 0) continue;

        const firstArg = args[0]!;
        if (!Node.isStringLiteral(firstArg)) continue;
        if (firstArg.getLiteralValue() !== routePath) continue;

        return expr;
    }
    return undefined;
}

function injectRbac(
    fileContent: string,
    filePath: string,
    method: string,
    routePath: string,
    allowedRoles: string[]
): { result: string; action: string } {
    const project = new Project({
        useInMemoryFileSystem: true,
        compilerOptions: { allowJs: true },
    });

    const sourceFile = project.createSourceFile(filePath, fileContent, {
        overwrite: true,
    });

    let middlewareAction = "";
    if (!hasRequireRoles(sourceFile)) {
        ensureExpressTypeImports(sourceFile);
        sourceFile.insertStatements(0, `\n${REQUIRE_ROLES_TEMPLATE}`);
        middlewareAction = "injected requireRoles middleware into file";
    } else {
        middlewareAction = "requireRoles already present — skipped injection";
    }

    const routeCall = findRouteCall(sourceFile, method, routePath);
    if (!routeCall) {
        throw new Error(
            `Route "${method.toUpperCase()} ${routePath}" not found in "${filePath}". ` +
            `Use inject_express_route first to create the route, then secure it with this tool.`
        );
    }

    const existingArgs = routeCall.getArguments();
    const alreadySecured = existingArgs.some((arg) => {
        const text = arg.getText().replace(/\s/g, "");
        return text.startsWith("requireRoles(");
    });

    if (alreadySecured) {
        throw new Error(
            `Route "${method.toUpperCase()} ${routePath}" already has requireRoles in its middleware chain. ` +
            `Remove it manually first if you need to change the roles.`
        );
    }

    const rolesLiteral =
        `requireRoles([${allowedRoles.map((r) => `"${r}"`).join(", ")}])`;

    routeCall.insertArgument(1, rolesLiteral);

    sourceFile.fixUnusedIdentifiers();
    sourceFile.organizeImports();

    return {
        result: sourceFile.getFullText(),
        action: middlewareAction,
    };
}

// ─── 5. Tool Definition ───────────────────────────────────────────────────────

export const injectRbacMiddleware: Tool<FastMCPSessionAuth, InjectRbacParams> = {
    name: "inject_rbac_middleware",
    description:
        "Secures an Express route with Role-Based Access Control. " +
        "Injects the requireRoles([...]) middleware into the argument chain of a specific route, " +
        "and ensures the middleware function is defined in the target file. " +
        "Supports dry-run mode.",
    parameters: injectRbacSchema,

    execute: async (args) => {
        const { targetFile, routePath, method, allowedRoles, dryRun } = args;
        const resolvedPath = path.resolve(targetFile);
        const projectRoot = path.resolve(resolvedPath, "../../..");

        return withMutationReport("inject_rbac_middleware", dryRun ? null : projectRoot, async (report) => {
            if (!fs.existsSync(resolvedPath)) {
                throw new Error(`File not found: "${resolvedPath}"`);
            }

            const ext = path.extname(resolvedPath);
            if (![".ts", ".js"].includes(ext)) {
                throw new Error(`Target must be a .ts or .js file. Got: "${ext}"`);
            }

            let originalContent: string;
            try {
                originalContent = fs.readFileSync(resolvedPath, "utf-8");
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                throw new Error(`Error reading file: ${msg}`);
            }

            let modifiedContent: string;
            let action: string;

            ({ result: modifiedContent, action } = injectRbac(
                originalContent,
                resolvedPath,
                method,
                routePath,
                allowedRoles
            ));

            if (dryRun) {
                const sep = "─".repeat(60);
                report.humanMessage =
                    `[INFO] DRY RUN — No file was written.\n` +
                    `File:    ${resolvedPath}\n` +
                    `Route:   ${method.toUpperCase()} ${routePath}\n` +
                    `Roles:   [${allowedRoles.join(", ")} ]\n` +
                    `Middleware: ${action}\n\n` +
                    `${sep}\nPROPOSED FILE CONTENT:\n${sep}\n` +
                    modifiedContent +
                    `\n${sep}`;
                return;
            }

            fs.writeFileSync(resolvedPath, modifiedContent, "utf-8");
            report.mutatedFiles.push(resolvedPath);

            report.humanMessage =
                `[SUCCESS] RBAC secured successfully.\n\n` +
                `File:    ${resolvedPath}\n` +
                `Route:   ${method.toUpperCase()} ${routePath}\n` +
                `Roles:   [${allowedRoles.join(", ")}]\n\n` +
                `Middleware: ${action}\n\n` +
                `Result:\n` +
                `  router.${method}("${routePath}", requireRoles([${allowedRoles.map((r) => `"${r}"`).join(", ")}]), <handler>)`;
        });
    },
};

import * as path from "node:path";
import * as fs from "node:fs";
import { z } from "zod";
import { Project, Node, SyntaxKind } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";

// ─── 1. Zod Schema ────────────────────────────────────────────────────────────

const injectRouteSchema = z.object({
    targetFile: z
        .string()
        .describe(
            "Absolute path to the Express TypeScript router file you want to modify"
        ),
    method: z
        .enum(["get", "post", "put", "delete", "patch"])
        .describe("HTTP method for the new route"),
    routePath: z
        .string()
        .describe('Express route path string, e.g. "/users/:id"'),
    handlerBody: z
        .string()
        .describe(
            "Body of the async arrow-function handler (raw TypeScript). " +
            "Example: `res.status(200).json({ message: 'OK' });`"
        ),
    dryRun: z
        .boolean()
        .default(false)
        .describe(
            "If true, returns the proposed file content WITHOUT writing to disk"
        ),
    // ── Fix 2: Auto server.ts wiring ─────────────────────────────────────────
    serverFile: z
        .string()
        .optional()
        .describe(
            "Optional: Absolute path to server.ts. When provided together with " +
            "mountPath, the tool will automatically add app.use(mountPath, router) " +
            "and the router import to this file."
        ),
    mountPath: z
        .string()
        .optional()
        .describe(
            'Optional: The mount prefix for app.use(), e.g. "/api/bookings". ' +
            "Required when serverFile is provided."
        ),
    routerImportName: z
        .string()
        .optional()
        .describe(
            "Optional: The import name to use in server.ts, e.g. \"bookingRoutes\". " +
            "Defaults to the camelCase basename of targetFile (e.g. booking.routes.ts → bookingRoutes)."
        ),
});

type InjectRouteParams = typeof injectRouteSchema;

// ─── 2. Helpers ───────────────────────────────────────────────────────────────

/**
 * Sanitize the handler body to remove JSON-escaped quotes that arrive from
 * the MCP inspector or AI clients, which would produce invalid TypeScript.
 * e.g. res.status(200).json({ message: \"OK\" }) → res.status(200).json({ message: "OK" })
 */
function sanitizeHandlerBody(raw: string): string {
    let sanitized = raw
        .replace(/\\"/g, '"')   // unescape \" → "
        .replace(/\\'/g, "'")  // unescape \' → '
        .trim();

    // Map common AI-generated auth method names to the exact exports created by injectAuthSystem
    sanitized = sanitized.replace(/\b(?:await\s+)?login\b/g, (match) => match.includes("await") ? "await signIn" : "signIn");
    sanitized = sanitized.replace(/\b(?:await\s+)?register\b/g, (match) => match.includes("await") ? "await signUp" : "signUp");

    return sanitized;
}

/**
 * Derive a camelCase router import name from a filename.
 * "booking.routes.ts" → "bookingRoutes"
 * "auth.routes.ts"    → "authRoutes"
 * "index.ts"          → "indexRouter"
 */
function deriveImportName(filePath: string): string {
    const base = path.basename(filePath, path.extname(filePath)); // "booking.routes"
    const parts = base.split(".");
    if (parts.length >= 2) {
        // "booking.routes" → "bookingRoutes"
        return parts[0]! + parts.slice(1).map((p) => p[0]!.toUpperCase() + p.slice(1)).join("");
    }
    return base + "Router";
}

/**
 * Build the text of the new route expression statement.
 */
function buildRouteStatement(
    routerName: string,
    method: string,
    routePath: string,
    handlerBody: string
): string {
    const indentedBody = handlerBody
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n");

    const hasNext = handlerBody.includes("next");
    const params = hasNext ? "req, res, next" : "req, res";

    return (
        `${routerName}.${method}("${routePath}", async (${params}) => {\n` +
        `${indentedBody}\n` +
        `});\n`
    );
}

// ─── 3. Core AST Injection — Router File ──────────────────────────────────────

function injectRoute(
    fileContent: string,
    filePath: string,
    method: string,
    routePath: string,
    handlerBody: string
): string {
    const project = new Project({
        useInMemoryFileSystem: true,
        compilerOptions: { allowJs: true },
    });

    const sourceFile = project.createSourceFile(filePath, fileContent, {
        overwrite: true,
    });

    // ── Step A: Find the router variable name ──────────────────────────────────
    let routerVarName: string | undefined;

    for (const varDecl of sourceFile.getVariableDeclarations()) {
        const init = varDecl.getInitializer();
        if (!init) continue;

        const initText = init.getText().replace(/\s/g, "");

        if (
            initText.startsWith("express.Router(") ||
            initText.startsWith("Router(") ||
            initText.startsWith("express(")
        ) {
            routerVarName = varDecl.getName();
            break;
        }
    }

    if (!routerVarName) {
        throw new Error(
            `No Express Router declaration found in "${filePath}". ` +
            `Expected a variable initialized with express.Router(), Router(), or express().`
        );
    }

    // ── Step B: Find insertion point ──────────────────────────────────────────
    const stmts = sourceFile.getStatements();
    const routeCallIndices: number[] = [];

    stmts.forEach((stmt, i) => {
        if (!Node.isExpressionStatement(stmt)) return;

        const expr = stmt.getExpression();
        if (!Node.isCallExpression(expr)) return;

        const callee = expr.getExpression();
        if (!Node.isPropertyAccessExpression(callee)) return;

        const obj = callee.getExpression();
        if (obj.getText() !== routerVarName) return;

        const prop = callee.getName();
        if (["get", "post", "put", "delete", "patch", "use", "all"].includes(prop)) {
            routeCallIndices.push(i);
        }
    });

    const newRouteText = buildRouteStatement(
        routerVarName,
        method,
        routePath,
        handlerBody
    );

    if (routeCallIndices.length > 0) {
        const lastRouteIdx = routeCallIndices[routeCallIndices.length - 1]!;
        const lastRouteStmt = stmts[lastRouteIdx]!;
        const insertPos = lastRouteStmt.getChildIndex() + 1;
        sourceFile.insertStatements(insertPos, newRouteText);
    } else {
        let exportDefaultIdx: number | undefined;

        stmts.forEach((stmt, i) => {
            if (Node.isExportAssignment(stmt)) {
                const expr = stmt.getExpression();
                if (expr.getText() === routerVarName) exportDefaultIdx = i;
                return;
            }
            if (Node.isExpressionStatement(stmt)) {
                const text = stmt.getText().replace(/\s/g, "");
                if (
                    text === `module.exports=${routerVarName};` ||
                    text.includes(`exports.default=${routerVarName}`)
                ) {
                    exportDefaultIdx = i;
                }
            }
        });

        if (exportDefaultIdx !== undefined) {
            sourceFile.insertStatements(exportDefaultIdx, newRouteText);
        } else {
            sourceFile.addStatements(newRouteText);
        }
    }

    sourceFile.fixUnusedIdentifiers();
    sourceFile.organizeImports();
    return sourceFile.getFullText();
}

// ─── 4. Core AST Injection — server.ts Wiring (Fix 2) ────────────────────────

/**
 * Add an app.use(mountPath, importName) call to server.ts and ensure the
 * router import exists at the top of the file.
 */
function wireRouteIntoServer(
    serverContent: string,
    serverPath: string,
    routerFilePath: string,
    mountPath: string,
    importName: string,
    warnings: string[]
): string {
    const project = new Project({
        useInMemoryFileSystem: true,
        compilerOptions: { allowJs: true },
    });

    const serverFile = project.createSourceFile(serverPath, serverContent, {
        overwrite: true,
    });

    // ── Ensure the import exists ───────────────────────────────────────────────
    const relImport = (() => {
        const rel = path.relative(path.dirname(serverPath), routerFilePath);
        // strip .ts extension, use ./ prefix
        const stripped = rel.replace(/\.ts$/, "");
        return stripped.startsWith(".") ? stripped : `./${stripped}`;
    })();

    // Check for existing import with same identifier
    const existingImport = serverFile.getImportDeclarations().find(imp => {
        const def = imp.getDefaultImport();
        const named = imp.getNamedImports().some(n => n.getName() === importName);
        return (def && def.getText() === importName) || named;
    });

    if (!existingImport) {
        // Insert after the last existing import declaration
        const lastImport = serverFile.getLastChildByKind(SyntaxKind.ImportDeclaration);
        if (lastImport) {
            serverFile.insertStatements(
                lastImport.getChildIndex() + 1,
                `import ${importName} from "${relImport}";`
            );
        } else {
            serverFile.insertStatements(0, `import ${importName} from "${relImport}";`);
        }
    } else if (existingImport.getModuleSpecifierValue() !== relImport) {
        // Conflict: same symbol imported from different path; prefer existing alias and warn
        warnings.push(`[WARNING] '${importName}' is already imported from '${existingImport.getModuleSpecifierValue()}'. Skipping import from '${relImport}'.`);
    }

    // ── Ensure app.use(mountPath, importName) doesn't already exist ──────────
    const stmts = serverFile.getStatements();
    const alreadyMounted = stmts.some((stmt) => {
        if (!Node.isExpressionStatement(stmt)) return false;
        const text = stmt.getText().replace(/\s/g, "");
        return text.includes(`app.use("${mountPath}"`) || text.includes(`app.use('${mountPath}'`);
    });

    if (!alreadyMounted) {
        // Insert after the last app.use(...) call
        const appUseIndices: number[] = [];
        stmts.forEach((stmt, i) => {
            if (!Node.isExpressionStatement(stmt)) return;
            const expr = stmt.getExpression();
            if (!Node.isCallExpression(expr)) return;
            const callee = expr.getExpression();
            if (!Node.isPropertyAccessExpression(callee)) return;
            if (
                callee.getExpression().getText() === "app" &&
                callee.getName() === "use"
            ) {
                appUseIndices.push(i);
            }
        });

        const newUse = `app.use("${mountPath}", ${importName});\n`;

        if (appUseIndices.length > 0) {
            const lastUseIdx = appUseIndices[appUseIndices.length - 1]!;
            const lastUseStmt = stmts[lastUseIdx]!;
            serverFile.insertStatements(lastUseStmt.getChildIndex() + 1, newUse);
        } else {
            serverFile.addStatements(newUse);
        }
    }

    return serverFile.getFullText();
}

// ─── 5. Tool Definition ───────────────────────────────────────────────────────

export const injectExpressRoute: Tool<FastMCPSessionAuth, InjectRouteParams> = {
    name: "inject_express_route",
    description:
        "Uses ts-morph to parse an Express TypeScript router file as an AST " +
        "and surgically injects a new route handler. " +
        "Optionally auto-wires the router into server.ts via serverFile + mountPath. " +
        "Supports dry-run mode: returns the proposed file content without writing to disk.",
    parameters: injectRouteSchema,

    execute: async (args) => {
        const { targetFile, method, routePath, dryRun, serverFile, mountPath, routerImportName } = args;

        // Fix 3: sanitize handler body to remove JSON-escaped quotes
        const handlerBody = sanitizeHandlerBody(args.handlerBody);

        // ── Validate target file ───────────────────────────────────────────────
        const resolvedPath = path.resolve(targetFile);

        if (!fs.existsSync(resolvedPath)) {
            return `[ERROR] Error: File not found: "${resolvedPath}"`;
        }

        const ext = path.extname(resolvedPath);
        if (!([".ts", ".js"].includes(ext))) {
            return `[ERROR] Error: Target file must be a .ts or .js file. Got: "${ext}"`;
        }

        // ── Validate serverFile if provided ───────────────────────────────────
        let resolvedServerPath: string | undefined;
        if (serverFile) {
            if (!mountPath) {
                return `[ERROR] Error: "mountPath" is required when "serverFile" is provided.`;
            }
            resolvedServerPath = path.resolve(serverFile);
            if (!fs.existsSync(resolvedServerPath)) {
                return `[ERROR] Error: serverFile not found: "${resolvedServerPath}"`;
            }
        }

        // ── Read router file ───────────────────────────────────────────────────
        let originalContent: string;
        try {
            originalContent = fs.readFileSync(resolvedPath, "utf-8");
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `[ERROR] Error reading file: ${msg}`;
        }

        // ── Inject route ───────────────────────────────────────────────────────
        let modifiedContent: string;
        try {
            modifiedContent = injectRoute(
                originalContent,
                resolvedPath,
                method,
                routePath,
                handlerBody
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `[ERROR] AST Injection Error: ${msg}`;
        }

        // ── Wire into server.ts (if requested) ────────────────────────────────
        let modifiedServerContent: string | undefined;
        let resolvedServerContent: string | undefined;

        if (resolvedServerPath && mountPath) {
            const importName =
                routerImportName ?? deriveImportName(resolvedPath);

            try {
                resolvedServerContent = fs.readFileSync(resolvedServerPath, "utf-8");
                const warnings: string[] = [];
                modifiedServerContent = wireRouteIntoServer(
                    resolvedServerContent,
                    resolvedServerPath,
                    resolvedPath,
                    mountPath,
                    importName,
                    warnings
                );
                // attach warnings to modifiedServerContent as a header comment so callers see them in dry runs
                if (warnings.length > 0) {
                    const header = warnings.map(w => `/* ${w} */`).join("\n") + "\n\n";
                    modifiedServerContent = header + modifiedServerContent;
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return `[ERROR] Error processing server.ts: ${msg}`;
            }
        }

        // ── Dry run ───────────────────────────────────────────────────────────
        if (dryRun) {
            const sep = "─".repeat(60);
            let output =
                `[INFO] DRY RUN — No files were written.\n` +
                `Router file: ${resolvedPath}\n` +
                `Route:       ${method.toUpperCase()} ${routePath}\n\n` +
                `${sep}\nPROPOSED ROUTER FILE:\n${sep}\n` +
                modifiedContent +
                `\n${sep}`;

            if (modifiedServerContent) {
                output +=
                    `\n\n${sep}\nPROPOSED SERVER.TS:\n${sep}\n` +
                    modifiedServerContent +
                    `\n${sep}`;
            }
            return output;
        }

        // ── Write to disk ──────────────────────────────────────────────────────
        try {
            fs.writeFileSync(resolvedPath, modifiedContent, "utf-8");
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `[ERROR] Error writing router file: ${msg}`;
        }

        let serverResult = "";
        if (resolvedServerPath && modifiedServerContent) {
            try {
                fs.writeFileSync(resolvedServerPath, modifiedServerContent, "utf-8");
                serverResult = `\n[SUCCESS] server.ts updated: app.use("${mountPath}", ...) added.`;
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                serverResult = `\n[WARNING] Route injected but server.ts update failed: ${msg}`;
            }
        }

        return (
            `[SUCCESS] Route injected successfully.\n\n` +
            `File:   ${resolvedPath}\n` +
            `Route:  ${method.toUpperCase()} ${routePath}` +
            serverResult +
            `\n\nThe handler was inserted after the last existing router.${method}() call ` +
            `(or before the export if none existed).`
        );
    },
};

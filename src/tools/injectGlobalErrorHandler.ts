import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { Project, Node, SyntaxKind } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { withMutationReport } from "../utils/mutationTracker.js";
import { enforcePathJail } from "../utils/pathJail.js";
import { WORKSPACE_ROOT } from "../utils/workspace.js";

const injectGlobalErrorSchema = z.object({
    serverFile: z.string().describe("Absolute path to the main application file (e.g. server.ts or app.ts)"),
    targetSrcDirectory: z.string().describe("Absolute path to the src directory where utils and middleware live"),
    dryRun: z.boolean().default(false).describe("If true, preview changes without writing"),
});

type InjectGlobalErrorParams = typeof injectGlobalErrorSchema;

function buildAppError(): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("AppError.ts", "", { overwrite: true });

    sourceFile.addStatements(`
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}
`.trimStart());
    sourceFile.fixUnusedIdentifiers();
    sourceFile.organizeImports();
    return sourceFile.getFullText();
}

function buildErrorHandler(): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("errorHandler.ts", "", { overwrite: true });

    sourceFile.addStatements(`
import { Request, Response, NextFunction } from "express";
import { AppError } from "../utils/AppError";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const globalErrorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  let statusCode = 500;
  let message = "Internal Server Error";

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
  } else if (err instanceof Error) {
    message = err.message;
  }

    if (process.env.NODE_ENV === "development" || !(err instanceof AppError)) {
        console.error("[ERROR]:", err);
    }

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};
`.trimStart());
    sourceFile.fixUnusedIdentifiers();
    sourceFile.organizeImports();
    return sourceFile.getFullText();
}

function injectIntoServer(serverContent: string, serverPath: string, srcPath: string): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(serverPath, serverContent, { overwrite: true });

    const relImport = (() => {
        const rel = path.relative(path.dirname(serverPath), path.join(srcPath, "middleware/errorHandler"));
        const stripped = rel.replace(/\\/g, "/");
        return stripped.startsWith(".") ? stripped : `./${stripped}`;
    })();

    const alreadyImported = sourceFile.getImportDeclarations().some(
        (imp) => imp.getNamedImports().some(n => n.getName() === "globalErrorHandler")
    );

    if (!alreadyImported) {
        const lastImport = sourceFile.getLastChildByKind(SyntaxKind.ImportDeclaration);
        if (lastImport) {
            sourceFile.insertStatements(lastImport.getChildIndex() + 1, `import { globalErrorHandler } from "${relImport}";`);
        } else {
            sourceFile.insertStatements(0, `import { globalErrorHandler } from "${relImport}";`);
        }
    }

    let appVarName = "app";
    const appCandidates: string[] = [];
    for (const varDecl of sourceFile.getVariableDeclarations()) {
        const init = varDecl.getInitializer();
        if (init && (init.getText().includes("express()") || init.getText().startsWith("express()"))) {
            appCandidates.push(varDecl.getName());
        }
    }

    if (appCandidates.length === 0) {
        throw new Error(
            `[AST Hard-Fail] No Express app declaration (e.g. "const app = express()") found in "${serverPath}". ` +
            `Cannot determine where to mount the globalErrorHandler middleware.`
        );
    }
    if (appCandidates.length > 1) {
        throw new Error(
            `[AST Hard-Fail] Ambiguous: ${appCandidates.length} Express app declarations found in "${serverPath}": ` +
            `[${appCandidates.join(", ")}]. Cannot determine which to use.`
        );
    }
    appVarName = appCandidates[0]!;

    const stmts = sourceFile.getStatements();
    let lastAppUseIndex = -1;
    let listenIndex = -1;

    stmts.forEach((stmt, i) => {
        if (!Node.isExpressionStatement(stmt)) return;
        const expr = stmt.getExpression();
        if (!Node.isCallExpression(expr)) return;
        const callee = expr.getExpression();
        if (Node.isPropertyAccessExpression(callee) && 
            callee.getExpression().getText() === appVarName &&
            callee.getName() === "use") {
            lastAppUseIndex = i;
        }
        if (Node.isPropertyAccessExpression(callee) && 
            callee.getExpression().getText() === appVarName &&
            callee.getName() === "listen") {
            listenIndex = i;
        }
    });

    const useStmt = `\n// Global Error Handler must be the last middleware\n${appVarName}.use(globalErrorHandler);\n`;
    // Must check for the actual mount call, not just any statement whose text
    // contains "globalErrorHandler" — `stmts` was captured after the import
    // declaration was inserted above, and that import's own text also
    // contains the substring, which previously made this always true on the
    // very first run and silently prevented the middleware from ever being
    // mounted.
    const alreadyMounted = stmts.some(
        (stmt) => Node.isExpressionStatement(stmt) && /\.use\(\s*globalErrorHandler\s*\)/.test(stmt.getText())
    );

    if (!alreadyMounted) {
        if (listenIndex !== -1) {
            sourceFile.insertStatements(listenIndex, useStmt);
        } else if (lastAppUseIndex !== -1) {
            sourceFile.insertStatements(lastAppUseIndex + 1, useStmt);
        } else {
            sourceFile.addStatements(useStmt);
        }
    }

    sourceFile.fixUnusedIdentifiers();
    sourceFile.organizeImports();
    return sourceFile.getFullText();
}

export const injectGlobalErrorHandler: Tool<FastMCPSessionAuth, InjectGlobalErrorParams> = {
    name: "inject_global_error_handler",
    description: "Creates an AppError utility and a strictly-typed globalErrorHandler middleware. Uses ts-morph to inject it as the absolute last middleware in the Express server file to catch all errors natively.",
    parameters: injectGlobalErrorSchema,

    execute: async (args) => {
        const { serverFile, targetSrcDirectory, dryRun } = args;
        const resolvedServerPath = path.resolve(serverFile);
        const resolvedSrcDir = path.resolve(targetSrcDirectory);
        const projectRoot = path.resolve(resolvedSrcDir, "..");

        return withMutationReport("inject_global_error_handler", dryRun ? null : projectRoot, async (report) => {
            const safeServerPath = enforcePathJail(WORKSPACE_ROOT, resolvedServerPath);
            const safeSrcDir = enforcePathJail(WORKSPACE_ROOT, resolvedSrcDir);

            if (!fs.existsSync(safeServerPath)) throw new Error(`serverFile not found: "${safeServerPath}"`);
            if (!fs.existsSync(safeSrcDir)) throw new Error(`src directory not found: "${safeSrcDir}"`);

            const utilsDir = path.join(safeSrcDir, "utils");
            const middlewareDir = path.join(safeSrcDir, "middleware");
            const appErrorPath = path.join(utilsDir, "AppError.ts");
            const errHandlerPath = path.join(middlewareDir, "errorHandler.ts");

            if (fs.existsSync(appErrorPath)) throw new Error(`Guard: File exists: "${appErrorPath}"`);
            if (fs.existsSync(errHandlerPath)) throw new Error(`Guard: File exists: "${errHandlerPath}"`);

            const serverContent = fs.readFileSync(safeServerPath, "utf-8");
            const modifiedServer = injectIntoServer(serverContent, safeServerPath, safeSrcDir);
            const appErrorContent = buildAppError();
            const errHandlerContent = buildErrorHandler();

            if (dryRun) {
                report.humanMessage =
                    `[INFO] DRY RUN\n\n` +
                    `--- PROPOSED: AppError.ts ---\n${appErrorContent}\n` +
                    `--- PROPOSED: errorHandler.ts ---\n${errHandlerContent}\n` +
                    `--- PROPOSED: server.ts ---\n${modifiedServer}\n`;
                return;
            }

            if (!fs.existsSync(utilsDir)) fs.mkdirSync(utilsDir, { recursive: true });
            if (!fs.existsSync(middlewareDir)) fs.mkdirSync(middlewareDir, { recursive: true });

            report.snapshotFiles([appErrorPath, errHandlerPath, safeServerPath]);


            fs.writeFileSync(appErrorPath, appErrorContent, "utf-8");
            report.mutatedFiles.push(appErrorPath);
            fs.writeFileSync(errHandlerPath, errHandlerContent, "utf-8");
            report.mutatedFiles.push(errHandlerPath);
            fs.writeFileSync(safeServerPath, modifiedServer, "utf-8");
            report.mutatedFiles.push(safeServerPath);

            report.humanMessage = `[SUCCESS] Global Error Handler injected successfully!\nFiles Created:\n  - ${appErrorPath}\n  - ${errHandlerPath}\nServer Updated:\n  - ${safeServerPath}`;
        });
    },
};

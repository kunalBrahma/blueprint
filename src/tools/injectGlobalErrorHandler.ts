import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { Project, Node, SyntaxKind } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";

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

    // Capture stack trace, excluding the constructor call from it.
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

  // Log error in development or if it's an unhandled system error
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

    // Ensure import
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

    // Identify Express App Variable
    let appVarName = "app"; // standard fallback
    for (const varDecl of sourceFile.getVariableDeclarations()) {
        const init = varDecl.getInitializer();
        if (init && (init.getText().includes("express()") || init.getText().startsWith("express()"))) {
            appVarName = varDecl.getName();
            break;
        }
    }

    // Find all app.use / router mounts to insert AT THE VERY END
    const stmts = sourceFile.getStatements();
    let lastAppUseIndex = -1;

    stmts.forEach((stmt, i) => {
        if (!Node.isExpressionStatement(stmt)) return;
        const expr = stmt.getExpression();
        if (!Node.isCallExpression(expr)) return;
        const callee = expr.getExpression();
        if (Node.isPropertyAccessExpression(callee) && callee.getExpression().getText() === appVarName) {
            lastAppUseIndex = i; // keep updating so we find the literal last one
        }
    });

    const useStmt = `\n// Global Error Handler must be the last middleware\n${appVarName}.use(globalErrorHandler);\n`;
    const alreadyMounted = stmts.some(stmt => stmt.getText().includes("globalErrorHandler"));

    if (!alreadyMounted) {
        if (lastAppUseIndex !== -1) {
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

        if (!fs.existsSync(resolvedServerPath)) return `[ERROR] Error: serverFile not found: "${resolvedServerPath}"`;
        if (!fs.existsSync(resolvedSrcDir)) return `[ERROR] Error: src directory not found: "${resolvedSrcDir}"`;

        const utilsDir = path.join(resolvedSrcDir, "utils");
        const middlewareDir = path.join(resolvedSrcDir, "middleware");

        const appErrorPath = path.join(utilsDir, "AppError.ts");
        const errHandlerPath = path.join(middlewareDir, "errorHandler.ts");

        if (fs.existsSync(appErrorPath)) return `[ERROR] Guard: File exists: "${appErrorPath}"`;
        if (fs.existsSync(errHandlerPath)) return `[ERROR] Guard: File exists: "${errHandlerPath}"`;

        let serverContent = fs.readFileSync(resolvedServerPath, "utf-8");
        const modifiedServer = injectIntoServer(serverContent, resolvedServerPath, resolvedSrcDir);
        const appErrorContent = buildAppError();
        const errHandlerContent = buildErrorHandler();

        if (dryRun) {
            return (
                `[INFO] DRY RUN\n\n` +
                `--- PROPOSED: AppError.ts ---\n${appErrorContent}\n` +
                `--- PROPOSED: errorHandler.ts ---\n${errHandlerContent}\n` +
                `--- PROPOSED: server.ts ---\n${modifiedServer}\n`
            );
        }

        if (!fs.existsSync(utilsDir)) fs.mkdirSync(utilsDir, { recursive: true });
        if (!fs.existsSync(middlewareDir)) fs.mkdirSync(middlewareDir, { recursive: true });

        fs.writeFileSync(appErrorPath, appErrorContent, "utf-8");
        fs.writeFileSync(errHandlerPath, errHandlerContent, "utf-8");
        fs.writeFileSync(resolvedServerPath, modifiedServer, "utf-8");

        return `[SUCCESS] Global Error Handler injected successfully!\nFiles Created:\n  - ${appErrorPath}\n  - ${errHandlerPath}\nServer Updated:\n  - ${resolvedServerPath}`;
    },
};

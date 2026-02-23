import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { Project, Node } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";

// ─── 1. Zod Schema ────────────────────────────────────────────────────────────

const injectTransactionSchema = z.object({
    targetFile: z
        .string()
        .describe("Absolute path to the Express controller file"),
    functionName: z
        .string()
        .describe("The name of the exported function to create or wrap (e.g., 'checkout', 'processOrder')"),
    transactionLogic: z
        .string()
        .describe("The raw TS/JS logic to place INSIDE the prisma.$transaction((tx) => { ... }) block"),
    callbackAction: z
        .string()
        .optional()
        .describe("Optional: a TS/JS statement to run after the transaction succeeds (e.g., socketService.emitToRoom(...))."),
    dryRun: z
        .boolean()
        .default(false)
        .describe("If true, returns the proposed file content WITHOUT writing to disk"),
});

type InjectTransactionParams = typeof injectTransactionSchema;

// ─── 2. Transaction Shell Template ───────────────────────────────────────────

function buildTransactionFunction(functionName: string, transactionLogic: string, callbackAction?: string): string {
        // Indent the user's logic correctly to match the nested block of prisma.$transaction
        const indentedLogic = transactionLogic
                .split("\n")
                .map((line) => (line.trim() === "" ? "" : `      ${line}`))
                .join("\n");

        const indentedCallback = callbackAction
                ? callbackAction
                            .split("\n")
                            .map((line) => (line.trim() === "" ? "" : `    ${line}`))
                            .join("\n")
                : "";

        return `
export async function ${functionName}(req: Request, res: Response): Promise<void> {
    try {
        const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
${indentedLogic}
        });

${indentedCallback ? indentedCallback + "\n" : ""}
        res.status(200).json({
            success: true,
            data: result
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Transaction failed.";
        res.status(400).json({ success: false, message });
    }
}
`.trim();
}

// ─── 3. AST Helpers ───────────────────────────────────────────────────────────

function ensureDynamicImports(
    sourceFile: ReturnType<InstanceType<typeof Project>["createSourceFile"]>,
    transactionLogic: string,
    warnings: string[]
) {
    if (transactionLogic.includes("Stripe") || transactionLogic.includes("stripe")) {
        // Avoid adding import if symbol already exists from another module
        const existing = sourceFile.getImportDeclarations().find(imp => {
            const def = imp.getDefaultImport();
            const named = imp.getNamedImports().some(n => n.getName() === "Stripe");
            return (def && def.getText() === "Stripe") || named;
        });
        if (existing) {
            if (existing.getModuleSpecifierValue() !== "stripe") {
                warnings.push(`[WARNING] Symbol 'Stripe' already imported from '${existing.getModuleSpecifierValue()}'. Skipping new import from 'stripe' to avoid conflict.`);
            }
        } else {
            sourceFile.addImportDeclaration({ defaultImport: "Stripe", moduleSpecifier: "stripe" });
        }
    }

    if (transactionLogic.includes("paymentService")) {
        // Ensure named import 'paymentService' exists, avoid conflicts
        const paymentImport = sourceFile.getImportDeclarations().find(imp => imp.getModuleSpecifierValue() === "../services/payment.service");
        if (paymentImport) {
            const hasNamed = paymentImport.getNamedImports().some((n) => n.getName() === "paymentService");
            if (!hasNamed) paymentImport.addNamedImport("paymentService");
        } else {
            // If paymentService symbol exists from other module, warn and skip
            const existing = sourceFile.getImportDeclarations().find(imp => imp.getNamedImports().some(n => n.getName() === "paymentService") || (imp.getDefaultImport()?.getText() === "paymentService"));
            if (existing) {
                warnings.push(`[WARNING] Symbol 'paymentService' already imported from '${existing.getModuleSpecifierValue()}'. Skipping import from '../services/payment.service'.`);
            } else {
                sourceFile.addImportDeclaration({ namedImports: ["paymentService"], moduleSpecifier: "../services/payment.service" });
            }
        }
    }

    if (transactionLogic.includes("mailService")) {
        const mailImport = sourceFile.getImportDeclarations().find(imp => imp.getModuleSpecifierValue() === "../utils/mail");
        if (mailImport) {
            const hasNamed = mailImport.getNamedImports().some((n) => n.getName() === "mailService");
            if (!hasNamed) mailImport.addNamedImport("mailService");
        } else {
            const existing = sourceFile.getImportDeclarations().find(imp => imp.getNamedImports().some(n => n.getName() === "mailService") || imp.getDefaultImport()?.getText() === "mailService");
            if (existing) {
                warnings.push(`[WARNING] Symbol 'mailService' already imported from '${existing.getModuleSpecifierValue()}'. Skipping import from '../utils/mail'.`);
            } else {
                sourceFile.addImportDeclaration({ namedImports: ["mailService"], moduleSpecifier: "../utils/mail" });
            }
        }
    }

    if (transactionLogic.includes("smsService")) {
        const smsImport = sourceFile.getImportDeclarations().find(imp => imp.getModuleSpecifierValue() === "../utils/sms");
        if (smsImport) {
            const hasNamed = smsImport.getNamedImports().some((n) => n.getName() === "smsService");
            if (!hasNamed) smsImport.addNamedImport("smsService");
        } else {
            const existing = sourceFile.getImportDeclarations().find(imp => imp.getNamedImports().some(n => n.getName() === "smsService") || imp.getDefaultImport()?.getText() === "smsService");
            if (existing) {
                warnings.push(`[WARNING] Symbol 'smsService' already imported from '${existing.getModuleSpecifierValue()}'. Skipping import from '../utils/sms'.`);
            } else {
                sourceFile.addImportDeclaration({ namedImports: ["smsService"], moduleSpecifier: "../utils/sms" });
            }
        }
    }

    if (transactionLogic.includes("AppError")) {
        const existing = sourceFile.getImportDeclarations().find(imp => {
            const def = imp.getDefaultImport();
            const named = imp.getNamedImports().some(n => n.getName() === "AppError");
            return (def && def.getText() === "AppError") || named;
        });
        if (existing) {
            if (!existing.getModuleSpecifierValue().includes("AppError")) {
                warnings.push(`[WARNING] Symbol 'AppError' already imported from '${existing.getModuleSpecifierValue()}'. Skipping import from '../utils/AppError'.`);
            }
        } else {
            sourceFile.addImportDeclaration({ defaultImport: "AppError", moduleSpecifier: "../utils/AppError" });
        }
    }
}

function ensureExpressAndPrismaImports(
    sourceFile: ReturnType<InstanceType<typeof Project>["createSourceFile"]>,
    warnings: string[]
) {
    // Ensure Express
    const expressImport = sourceFile.getImportDeclaration(
        (imp) => imp.getModuleSpecifierValue() === "express"
    );
    const neededExpress = ["Request", "Response", "NextFunction"];

    if (!expressImport) {
        sourceFile.addImportDeclaration({
            namedImports: neededExpress,
            moduleSpecifier: "express",
        });
    } else {
        const existingNames = expressImport.getNamedImports().map((n) => n.getName());
        const missingNames = neededExpress.filter((n) => !existingNames.includes(n));
        if (missingNames.length > 0) {
            expressImport.addNamedImports(missingNames);
        }
    }

    // Ensure Prisma default import (prisma client instance)
    const hasPrismaInstance = sourceFile.getImportDeclarations().some(
        (imp) => imp.getDefaultImport()?.getText() === "prisma" || imp.getModuleSpecifierValue().includes("../config/prisma")
    );

    if (!hasPrismaInstance) {
        // If a symbol named 'prisma' is already imported from elsewhere, warn and skip
        const existing = sourceFile.getImportDeclarations().find(imp => imp.getDefaultImport()?.getText() === "prisma" || imp.getNamedImports().some(n => n.getName() === "prisma"));
        if (existing && !existing.getModuleSpecifierValue().includes("../config/prisma")) {
            warnings.push(`[WARNING] Symbol 'prisma' already imported from '${existing.getModuleSpecifierValue()}'. Skipping automatic import from '../config/prisma'.`);
        } else {
            sourceFile.addImportDeclaration({ defaultImport: "prisma", moduleSpecifier: "../config/prisma" });
        }
    }

    // Explicitly ensure 'Prisma' type is imported for Prisma.TransactionClient
    const prismaClientImport = sourceFile.getImportDeclaration(
        (imp) => imp.getModuleSpecifierValue() === "@prisma/client"
    );
    if (!prismaClientImport) {
        sourceFile.addImportDeclaration({
            namedImports: ["Prisma"],
            moduleSpecifier: "@prisma/client",
        });
    } else {
        const hasPrismaType = prismaClientImport.getNamedImports().some((n) => n.getName() === "Prisma");
        if (!hasPrismaType) {
            prismaClientImport.addNamedImport("Prisma");
        }
    }
}

function hasFunction(
    sourceFile: ReturnType<InstanceType<typeof Project>["createSourceFile"]>,
    functionName: string
): boolean {
    for (const fn of sourceFile.getFunctions()) {
        if (fn.getName() === functionName) return true;
    }
    for (const varDecl of sourceFile.getVariableDeclarations()) {
        if (varDecl.getName() === functionName) {
            const init = varDecl.getInitializer();
            if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
                return true;
            }
        }
    }
    return false;
}

// ─── 4. Tool Definition ───────────────────────────────────────────────────────

export const injectTransaction: Tool<FastMCPSessionAuth, InjectTransactionParams> = {
    name: "inject_transaction",
    description:
        "Universal AST Shell: Wraps AI-provided logic inside a production-grade prisma.$transaction block. " +
        "Automatically detects and injects imports for Stripe, Razorpay, Mail, and SMS services based on the provided logic. " +
        "AI must use the 'tx' variable for transaction-safe operations.",
    parameters: injectTransactionSchema,

    execute: async (args) => {
        const { targetFile, functionName, transactionLogic, callbackAction, dryRun } = args;

        const resolvedPath = path.resolve(targetFile);

        // ── 1. Read or Create File ──────────────────────────────────────────────
        let fileContent = "";
        let isNewFile = false;

        if (fs.existsSync(resolvedPath)) {
            try {
                fileContent = fs.readFileSync(resolvedPath, "utf-8");
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return `[ERROR] Error reading file: ${msg}`;
            }
        } else {
            isNewFile = true;
        }

        // ── 2. Create AST ──────────────────────────────────────────────────────
        const project = new Project({
            useInMemoryFileSystem: true,
            compilerOptions: { allowJs: true },
        });

        const sourceFile = project.createSourceFile(resolvedPath, fileContent, {
            overwrite: true,
        });

        // ── 3. Guard against overwriting ───────────────────────────────────────
        if (!isNewFile && hasFunction(sourceFile, functionName)) {
            return (
                `[ERROR] Guard Triggered: Function "${functionName}" already exists in ${resolvedPath}.\n` +
                `Refusing to overwrite. Please delete it manually or choose a different functionName.`
            );
        }

        // ── 4. Ensure Imports ──────────────────────────────────────────────────
        const warnings: string[] = [];
        ensureExpressAndPrismaImports(sourceFile, warnings);
        ensureDynamicImports(sourceFile, transactionLogic + (callbackAction ? `\n${callbackAction}` : ""), warnings);

        // ── 5. Inject the Transaction Function ─────────────────────────────────
        const functionString = buildTransactionFunction(functionName, transactionLogic, callbackAction);
        sourceFile.addStatements(`\n${functionString}`);

        // ── 6. Dry Run ─────────────────────────────────────────────────────────
        if (dryRun) {
            const sep = "─".repeat(60);
            return (
                `[INFO] DRY RUN — No file was written.\n` +
                `File:     ${resolvedPath} ${isNewFile ? "(NEW)" : "(EXISTING)"}\n` +
                `Function: ${functionName}\n\n` +
                `${sep}\nPROPOSED FILE CONTENT:\n${sep}\n` +
                sourceFile.getFullText() +
                `\n${sep}`
            );
        }

        // ── 7. Write to Disk ───────────────────────────────────────────────────
        try {
            // Ensure directory exists if new file
            if (isNewFile) {
                fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
            }
            fs.writeFileSync(resolvedPath, sourceFile.getFullText(), "utf-8");

            // Build helper service if Razorpay is detected
            if (transactionLogic.includes("paymentService") || transactionLogic.includes("Razorpay") || transactionLogic.includes("razorpay")) {
                const servicesDir = path.resolve(path.dirname(resolvedPath), "../services");
                if (!fs.existsSync(servicesDir)) fs.mkdirSync(servicesDir, { recursive: true });
                const servicePath = path.join(servicesDir, "payment.service.ts");
                if (!fs.existsSync(servicePath)) {
                    const serviceCode = `
import Razorpay from "razorpay";
import { env } from "../config/env";

const razorpay = new Razorpay({
  key_id: env.RAZORPAY_KEY_ID,
  key_secret: env.RAZORPAY_SECRET
});

export const paymentService = {
  async createRazorpayOrder(amount: number, currency = "INR", receipt = "") {
    return razorpay.orders.create({
      amount: amount * 100, // paise
      currency,
      receipt
    });
  }
};
`.trimStart();
                    fs.writeFileSync(servicePath, serviceCode, "utf-8");
                }
            }

        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `[ERROR] Error writing file: ${msg}`;
        }

        let resultMsg = (
            `[SUCCESS] Transaction shell injected successfully!\n\n` +
            `File:     ${resolvedPath}\n` +
            `Function: ${functionName}\n\n` +
            `The logic you provided has been cleanly wrapped inside a \`prisma.$transaction\` block ` +
            `with Express req/res handling.`
        );
        if (warnings.length > 0) {
            resultMsg += "\n\n" + warnings.map(w => w).join("\n");
        }
        return resultMsg;
    },
};

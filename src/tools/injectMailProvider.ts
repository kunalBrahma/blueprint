import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { z } from "zod";
import { Project, Node } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { withMutationReport } from "../utils/mutationTracker.js";

const injectMailSchema = z.object({
    targetSrcDirectory: z.string().describe("Absolute path to the src directory where services live"),
    dryRun: z.boolean().default(false),
});

type InjectMailParams = typeof injectMailSchema;

function buildMailService(): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("mail.service.ts", "", { overwrite: true });

    sourceFile.addStatements(`
import { Resend } from "resend";
import { env } from "../config/env";

const resend = new Resend(env.RESEND_API_KEY);

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

export const mailService = {
  async sendEmail({ to, subject, html }: SendEmailParams): Promise<void> {
    try {
      const { data, error } = await resend.emails.send({
        from: "Acme <onboarding@resend.dev>",
        to: [to],
        subject,
        html,
      });

      if (error) {
        console.error("Failed to send email:", error);
      } else {
        console.log("Email sent successfully:", data);
      }
    } catch (err) {
      console.error("Error in mailService.sendEmail:", err);
    }
  }
};
`.trimStart());

    sourceFile.fixUnusedIdentifiers();
    sourceFile.organizeImports();
    return sourceFile.getFullText();
}

function updateAuthController(targetSrcDirectory: string, report: { mutatedFiles: string[] }): string {
    const authControllerPath = path.resolve(targetSrcDirectory, "controllers/auth.controller.ts");
    if (!fs.existsSync(authControllerPath)) return "[WARNING] auth.controller.ts not found, skipping AST injection.";

    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(authControllerPath, fs.readFileSync(authControllerPath, "utf-8"), { overwrite: true });

    const forgotPasswordFn = sourceFile.getFunction("forgotPassword");
    if (!forgotPasswordFn) return "[WARNING] forgotPassword function not found in auth.controller.ts.";

    const hasMailImport = sourceFile.getImportDeclarations().some(imp => imp.getModuleSpecifierValue() === "../services/mail.service");
    if (!hasMailImport) {
        sourceFile.addImportDeclaration({
            namedImports: ["mailService"],
            moduleSpecifier: "../services/mail.service",
        });
    }

    for (const stmt of forgotPasswordFn.getStatements()) {
        if (Node.isExpressionStatement(stmt)) {
            const expr = stmt.getExpression();
            if (Node.isCallExpression(expr)) {
                const callee = expr.getExpression();
                if (Node.isPropertyAccessExpression(callee) && callee.getText() === "console.log" && expr.getText().includes("`Sending password reset email to")) {
                    stmt.replaceWithText(`
    await mailService.sendEmail({
      to: email,
      subject: "Password Reset Details",
      html: \`<p>You requested a password reset. Here is your token: <strong>\${resetToken}</strong></p>\`
    });
`.trim());
                    break;
                }
            }
        }
    }

    sourceFile.fixUnusedIdentifiers();
    sourceFile.organizeImports();
    fs.writeFileSync(authControllerPath, sourceFile.getFullText(), "utf-8");
    report.mutatedFiles.push(authControllerPath);
    return "[SUCCESS] AST Integration: Replaced console placeholder with actual mailService.sendEmail() in auth.controller.ts.";
}

export const injectMailProvider: Tool<FastMCPSessionAuth, InjectMailParams> = {
    name: "inject_mail_provider",
    description: "Implements real transactional emails using the resend SDK and integrates it natively into the forgotPassword function.",
    parameters: injectMailSchema,

    execute: async (args) => {
        const { targetSrcDirectory, dryRun } = args;
        const projectRoot = path.resolve(targetSrcDirectory, "..");

        return withMutationReport("inject_mail_provider", dryRun ? null : projectRoot, async (report) => {
            const servicesDir = path.resolve(targetSrcDirectory, "services");
            if (!fs.existsSync(servicesDir)) {
                fs.mkdirSync(servicesDir, { recursive: true });
            }

            const filePath = path.join(servicesDir, "mail.service.ts");
            if (fs.existsSync(filePath)) {
                throw new Error(`File already exists: "${filePath}".`);
            }

            const content = buildMailService();

            if (dryRun) {
                report.humanMessage = `[INFO] DRY RUN\n\n${content}`;
                return;
            }

            fs.writeFileSync(filePath, content, "utf-8");
            report.mutatedFiles.push(filePath);

            const astResult = updateAuthController(targetSrcDirectory, report);

            let packageWarnings = "\n\n[SUCCESS] Packages automatically installed:\n  resend";
            try {
                const cwd = projectRoot;
                if (fs.existsSync(path.join(cwd, "package.json"))) {
                    execSync("npm install resend --no-save --save-exact", { cwd, stdio: "inherit" });
                }
            } catch (err: unknown) {
                packageWarnings = "\n\n[WARNING] Failed to auto-install packages. Please manually run:\n  npm install resend";
                report.status = "PARTIAL_FAILURE";
            }

            report.humanMessage = `[SUCCESS] Mail Provider injected successfully!\nFile: ${filePath}\n${astResult}${packageWarnings}`;
        });
    },
};

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { z } from "zod";
import { Project, Node, SyntaxKind } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { withMutationReport } from "../utils/mutationTracker.js";
import { enforcePathJail } from "../utils/pathJail.js";

const generateDocsSchema = z.object({
  serverFile: z.string().describe("Absolute path to the main application file (server.ts / app.ts)"),
  targetSrcDirectory: z.string().describe("Absolute path to the src directory where config lives"),
  dryRun: z.boolean().default(false),
});

type GenerateDocsParams = typeof generateDocsSchema;

function buildSwaggerConfig(): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile("swagger.ts", "", { overwrite: true });

  sourceFile.addStatements(`
import swaggerJsdoc from "swagger-jsdoc";
import { env } from "./env";

const port = env?.PORT || process.env.PORT || 3000;

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "API Documentation",
      version: "1.0.0",
      description: "Auto-generated API documentation",
    },
    servers: [
      {
        url: \`http://localhost:\${port}\`,
        description: "Local Development Server",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  apis: ["./src/routes/*.ts", "./src/controllers/*.ts"],
};

export const swaggerSpec = swaggerJsdoc(options);
`.trimStart());

  sourceFile.fixUnusedIdentifiers();
  sourceFile.organizeImports();
  return sourceFile.getFullText();
}

function injectIntoServer(serverContent: string, serverPath: string, srcPath: string): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(serverPath, serverContent, { overwrite: true });

  const hasSwaggerUi = sourceFile.getImportDeclarations().some(imp => imp.getModuleSpecifierValue() === "swagger-ui-express");
  if (!hasSwaggerUi) {
    sourceFile.insertStatements(0, `import swaggerUi from "swagger-ui-express";`);
  }

  const relImport = (() => {
    const rel = path.relative(path.dirname(serverPath), path.join(srcPath, "config/swagger"));
    const stripped = rel.replace(/\\/g, "/");
    return stripped.startsWith(".") ? stripped : `./${stripped}`;
  })();

  const hasSwaggerSpec = sourceFile.getImportDeclarations().some(imp => imp.getNamedImports().some(n => n.getName() === "swaggerSpec"));
  if (!hasSwaggerSpec) {
    const lastImport = sourceFile.getLastChildByKind(SyntaxKind.ImportDeclaration);
    const idx = lastImport ? lastImport.getChildIndex() + 1 : 0;
    sourceFile.insertStatements(idx, `import { swaggerSpec } from "${relImport}";`);
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
      `Cannot determine where to mount the /api-docs route.`
    );
  }
  if (appCandidates.length > 1) {
    throw new Error(
      `[AST Hard-Fail] Ambiguous: ${appCandidates.length} Express app declarations found in "${serverPath}": ` +
      `[${appCandidates.join(", ")}]. Cannot determine which to use.`
    );
  }
  appVarName = appCandidates[0]!;

  const swaggerRoute = `/api-docs`;
  const useStmt = `\n// Serve Swagger API Documentation\n${appVarName}.use("${swaggerRoute}", swaggerUi.serve, swaggerUi.setup(swaggerSpec));\n`;
  const alreadyMounted = sourceFile.getStatements().some(stmt => stmt.getText().includes(swaggerRoute));

  if (!alreadyMounted) {
    let lastAppUseIndex = -1;
    const stmts = sourceFile.getStatements();
    stmts.forEach((stmt, i) => {
      if (!Node.isExpressionStatement(stmt)) return;
      const expr = stmt.getExpression();
      if (!Node.isCallExpression(expr)) return;
      const callee = expr.getExpression();
      if (Node.isPropertyAccessExpression(callee) && callee.getExpression().getText() === appVarName) {
        lastAppUseIndex = i;
      }
    });

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

export const generateApiDocs: Tool<FastMCPSessionAuth, GenerateDocsParams> = {
  name: "generate_api_docs",
  description: "Generates an OpenAPI 3.0 specification using swagger-jsdoc and automatically mounts the /api-docs route in the Express application via AST injection.",
  parameters: generateDocsSchema,

  execute: async (args) => {
    const { serverFile, targetSrcDirectory, dryRun } = args;
    const resolvedServerPath = path.resolve(serverFile);
    const resolvedSrcDir = path.resolve(targetSrcDirectory);
    const safeSrcDir = enforcePathJail(path.resolve(resolvedSrcDir, ".."), resolvedSrcDir);
    const projectRoot = path.resolve(resolvedSrcDir, "..");

    return withMutationReport("generate_api_docs", dryRun ? null : projectRoot, async (report) => {
      if (!fs.existsSync(resolvedServerPath)) throw new Error(`serverFile not found: "${resolvedServerPath}"`);
      if (!fs.existsSync(resolvedSrcDir)) throw new Error(`src directory not found: "${resolvedSrcDir}"`);

      const configDir = path.join(resolvedSrcDir, "config");
      const swaggerPath = path.join(configDir, "swagger.ts");

      if (fs.existsSync(swaggerPath)) throw new Error(`Guard: File exists: "${swaggerPath}"`);

      const serverContent = fs.readFileSync(resolvedServerPath, "utf-8");
      const modifiedServer = injectIntoServer(serverContent, resolvedServerPath, resolvedSrcDir);
      const swaggerContent = buildSwaggerConfig();

      if (dryRun) {
        report.humanMessage =
          `[INFO] DRY RUN\n\n` +
          `--- PROPOSED: swagger.ts ---\n${swaggerContent}\n` +
          `--- PROPOSED: ${serverFile} ---\n${modifiedServer}\n`;
        return;
      }

      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

      report.snapshotFiles([swaggerPath, resolvedServerPath]);


      fs.writeFileSync(swaggerPath, swaggerContent, "utf-8");
      report.mutatedFiles.push(swaggerPath);
      fs.writeFileSync(resolvedServerPath, modifiedServer, "utf-8");
      report.mutatedFiles.push(resolvedServerPath);

      let packageWarnings = `\n\n[INFO] Packages automatically installed:\n  swagger-jsdoc swagger-ui-express`;
      try {
        const cwd = projectRoot;
        if (fs.existsSync(path.join(cwd, "package.json"))) {
          const pkgs = ["swagger-jsdoc", "swagger-ui-express"];
          const devPkgs = ["@types/swagger-jsdoc", "@types/swagger-ui-express"];
          const pkgJsonPath = path.join(cwd, "package.json");
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
          const allDeps = { ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) };
          const need = pkgs.filter(p => !allDeps[p]);
          const needDev = devPkgs.filter(p => !allDeps[p]);
          if (need.length > 0) {
            execSync(`npm install ${need.join(" ")} --no-save --save-exact`, { cwd, stdio: "inherit", timeout: 30000 });
          }
          if (needDev.length > 0) {
            execSync(`npm install -D ${needDev.join(" ")} --no-save --save-exact`, { cwd, stdio: "inherit", timeout: 30000 });
          }
        }
      } catch (err: unknown) {
        packageWarnings = `\n\n[WARNING] Failed to auto-install packages. Please manually run:\n  npm install swagger-jsdoc swagger-ui-express\n  npm install -D @types/swagger-jsdoc @types/swagger-ui-express`;
        report.status = "PARTIAL_FAILURE";
      }

      report.humanMessage = `[SUCCESS] Swagger API Documentation injected successfully!` + packageWarnings;
    });
  },
};

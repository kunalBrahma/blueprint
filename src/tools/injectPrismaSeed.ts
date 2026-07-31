import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { z } from "zod";
import { Project } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { withMutationReport } from "../utils/mutationTracker.js";
import { enforcePathJail } from "../utils/pathJail.js";
import { WORKSPACE_ROOT } from "../utils/workspace.js";

const injectSeedSchema = z.object({
  prismaDirectory: z.string().describe("Absolute path to the prisma folder (where schema.prisma lives)"),
  dryRun: z.boolean().default(false),
});

type InjectSeedParams = typeof injectSeedSchema;

function buildSeedCode(schemaPath: string): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile("seed.ts", "", { overwrite: true });

  const schemaContent = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, "utf-8") : "";
  const hasRoleEnum = schemaContent.includes("enum Role");
  const hasAdminRole = schemaContent.match(/enum\s+Role\s*\{[^}]*ADMIN[^}]*\}/s);
  
  const roleField = hasRoleEnum 
    ? (hasAdminRole ? "        role: Role.ADMIN," : "        // role: Role.ADMIN, // (ADMIN not found in Role enum)")
    : "";
  const roleImport = hasRoleEnum ? 'import { PrismaClient, Role } from "@prisma/client";' : 'import { PrismaClient } from "@prisma/client";';

  sourceFile.addStatements(`
${roleImport}
import * as bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  const adminEmail = "admin@example.com";
  let admin = await prisma.user.findUnique({ where: { email: adminEmail } });
  
  if (!admin) {
    const hashedPassword = await bcrypt.hash("AdminSecret123!", 10);
    admin = await prisma.user.create({
      data: {
        email: adminEmail,
        password: hashedPassword,
        name: "Super Admin",
${roleField}
      }
    });
    console.log("[SUCCESS] Admin user created");
  } else {
    console.log("[INFO] Admin user already exists");
  }

  const products = [
    { name: "Premium Widget", description: "A high-quality widget", price: 99.99, stock: 50 },
    { name: "Basic Gadget", description: "An essential gadget for everyday use", price: 29.99, stock: 200 },
    { name: "Luxury Gizmo", description: "The ultimate gizmo", price: 499.00, stock: 10 }
  ];

  for (const p of products) {
    const existing = await prisma.product.findFirst({ where: { name: p.name } });
    if (!existing) {
      // Use unknown cast to satisfy Prisma's specific input types for products
      await prisma.product.create({ data: p as unknown as any });
      console.log(\`[SUCCESS] Product created: \${p.name}\`);
    }
  }

  console.log("Seeding finished.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
`);

  sourceFile.fixUnusedIdentifiers();
  sourceFile.organizeImports();
  
  const generated = sourceFile.getFullText();
  // We allow "as unknown as any" for complex Prisma data where we don't have the models available in the MCP server's compile time
  const anyMatches = generated.split("\n").filter(l => /\bas\s+any\b/.test(l) && !l.includes("as unknown as any"));
  if (anyMatches.length > 0) {
    throw new Error(
      `[Quality Gate] Generated file contains ` +
      `${anyMatches.length} "as any" cast(s). ` +
      `This is a generator bug — fix the template before ` +
      `writing to disk.\n\n` +
      `Offending content preview:\n` +
      anyMatches
        .map(l => `  ${l.trim()}`)
        .join("\n")
    );
  }
  return generated;
}

export const injectPrismaSeed: Tool<FastMCPSessionAuth, InjectSeedParams> = {
  name: "inject_prisma_seed",
  description: "Generates a seed.ts file to populate the database with initial Admin users and dummy products using Prisma.",
  parameters: injectSeedSchema,

  execute: async (args) => {
    const { prismaDirectory, dryRun } = args;
    const resolvedPath = path.resolve(prismaDirectory);
    const projectRoot = path.resolve(resolvedPath, "..");

    return withMutationReport("inject_prisma_seed", dryRun ? null : projectRoot, async (report) => {
      const safePath = enforcePathJail(WORKSPACE_ROOT, resolvedPath);
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Prisma directory not found: "${resolvedPath}"`);
      }

      const seedPath = path.join(resolvedPath, "seed.ts");
      const packageJsonPath = path.join(resolvedPath, "../package.json");
      const schemaPath = path.join(resolvedPath, "schema.prisma");

      if (fs.existsSync(seedPath)) {
        throw new Error(`Guard: File already exists: "${seedPath}"`);
      }

      const seedCode = buildSeedCode(schemaPath);

      if (dryRun) {
        report.humanMessage = `[INFO] DRY RUN\n\n--- seed.ts ---\n${seedCode}`;
        return;
      }

      let packageWarnings = "\n\n[INFO] Packages to manually install:\n  npm install ts-node -D";
      try {
        const cwd = projectRoot;
        if (fs.existsSync(packageJsonPath)) {
          execSync("npm install bcrypt --save-exact", { cwd, stdio: "pipe", timeout: 30000 });
          execSync("npm install -D ts-node @types/bcrypt @types/node --save-exact", { cwd, stdio: "pipe", timeout: 30000 });
          packageWarnings = "\n\n[SUCCESS] Packages automatically installed:\n  bcrypt, ts-node, @types/bcrypt";
        }
      } catch (err: unknown) {
        packageWarnings = "\n\n[WARNING] Failed to auto-install packages. Please manually run:\n  npm install bcrypt\n  npm install -D ts-node @types/bcrypt";
        report.status = "PARTIAL_FAILURE";
      }

      report.snapshotFiles([seedPath]);


      fs.writeFileSync(seedPath, seedCode, "utf-8");
      report.mutatedFiles.push(seedPath);

      if (fs.existsSync(packageJsonPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
          if (!pkg.prisma) pkg.prisma = {};
          pkg.prisma.seed = "ts-node prisma/seed.ts";
          report.snapshotFiles([packageJsonPath]);
          fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2), "utf-8");
          report.mutatedFiles.push(packageJsonPath);
        } catch (e) { }
      }

      report.humanMessage = `[SUCCESS] Prisma seed.ts generated successfully!\n\nTo run it: npx prisma db seed${packageWarnings}`;
    });
  },
};

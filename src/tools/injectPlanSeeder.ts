import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { Project, Node } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";

const injectSeederSchema = z.object({
    targetSrcDirectory: z.string().describe("Absolute path to the src folder"),
    dryRun: z.boolean().default(false),
});

type InjectSeederParams = typeof injectSeederSchema;

function buildPlanSeeder(): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("seedPlans.ts", "", { overwrite: true });

    sourceFile.addStatements(`
import prisma from "../config/prisma";
import { subscriptionService } from "../services/subscription/subscription.service";

const defaultPlans = [
  { name: "Pro", amount: 2500, currency: "USD", interval: "month" },
  { name: "Premium", amount: 5000, currency: "USD", interval: "month" }
];

async function main() {
  console.log("Seeding Subscriptions Plans...");

  for (const p of defaultPlans) {
    // 1. Create the plan in the active provider mapping
    const gatewayPlanId = await subscriptionService.createPlan(p.name, p.amount, p.currency, p.interval);
    
    // 2. Determine which ID field to store based on env constraint (or rely on generic metadata lookup)
    const isRazorpay = process.env.PAYMENT_PROVIDER === "razorpay";
    const updateData: any = {
      name: p.name,
      priceAmount: p.amount,
      currency: p.currency,
      interval: p.interval,
    };

    if (isRazorpay) {
      updateData.razorpayPlanId = gatewayPlanId;
    } else {
      updateData.stripePriceId = gatewayPlanId;
    }

    // 3. Upsert to Prisma DB (assuming plan.name is a sensible enough lookup, though realistically we might use ID)
    await prisma.plan.upsert({
       where: { id: "seed_" + p.name.toLowerCase() },
       create: { id: "seed_" + p.name.toLowerCase(), ...updateData },
       update: updateData
    });

    console.log(\`[SUCCESS] Seeded \${p.name} Plan (\${gatewayPlanId})\`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
`.trimStart());

    sourceFile.fixUnusedIdentifiers();
    sourceFile.organizeImports();
    return sourceFile.getFullText();
}

export const injectPlanSeeder: Tool<FastMCPSessionAuth, InjectSeederParams> = {
    name: "inject_plan_seeder",
    description: "Generates an auto-seeder to automatically inject Pro/Premium stripe/razorpay plans into your gateway and sync them with your database.",
    parameters: injectSeederSchema,

    execute: async (args) => {
        const { targetSrcDirectory, dryRun } = args;

        const scriptsDir = path.resolve(targetSrcDirectory, "scripts");
        if (!fs.existsSync(scriptsDir)) {
            fs.mkdirSync(scriptsDir, { recursive: true });
        }

        const scriptPath = path.join(scriptsDir, "seedPlans.ts");
        const content = buildPlanSeeder();

        if (dryRun) return `[INFO] DRY RUN:\n\${content}`;

        try {
            if (!fs.existsSync(scriptPath)) fs.writeFileSync(scriptPath, content, "utf-8");

            const pkgPath = path.resolve(targetSrcDirectory, "..", "package.json");
            if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
                pkg.scripts = pkg.scripts || {};
                pkg.scripts["seed:plans"] = "ts-node src/scripts/seedPlans.ts";
                fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf-8");
            }

        } catch (err: unknown) {
            return `[ERROR] Error writing file: \${err}`;
        }

        return `[SUCCESS] Plan Seeder auto-injected. Added "npm run seed:plans" to package.json.\\nFile: \${scriptPath}`;
    },
};

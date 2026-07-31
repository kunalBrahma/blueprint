import { z } from "zod";
import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import util from "node:util";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { withMutationReport } from "../utils/mutationTracker.js";
import { enforcePathJail } from "../utils/pathJail.js";
import { WORKSPACE_ROOT } from "../utils/workspace.js";

const execAsync = util.promisify(exec);

// 1. Zod Schema
const scaffoldProjectSchema = z.object({
    projectName: z.string().describe("The name of the project to scaffold"),
    outputDir: z
        .string()
        .describe("The absolute path to the directory where the project should be created"),
    branch: z
        .string()
        .default("v1.0.0")
        .describe("The branch to clone from the boilerplate repository"),
    installDeps: z
        .boolean()
        .default(true)
        .describe("Whether to install npm dependencies after cloning"),
});

type ScaffoldParams = typeof scaffoldProjectSchema;

// 2. Tool Execution (Cloning your Boilerplate)
export const scaffoldProject: Tool<FastMCPSessionAuth, ScaffoldParams> = {
    name: "scaffold_project",
    description: "Instantly clones Kunal's standard backend-boilerplate into a new directory, removes git history, and prepares it for development.",
    parameters: scaffoldProjectSchema,
    execute: async (args) => {
        const { projectName, outputDir, installDeps, branch } = args;
        const absoluteOutputDir = path.resolve(WORKSPACE_ROOT, outputDir);

        // The actual clone target is a sub-directory named after the project.
        // This allows the *parent* outputDir to be non-empty (e.g. a monorepo root)
        // while still guarding against overwriting an existing project directory.
        const projectRoot = enforcePathJail(
            WORKSPACE_ROOT,
            path.join(absoluteOutputDir, projectName)
        );

        return withMutationReport("scaffold_project", projectRoot, async (report) => {
            // Guard: only the specific target sub-dir must be empty or absent
            if (fs.existsSync(projectRoot) && fs.readdirSync(projectRoot).length > 0) {
                throw new Error(
                    `Target directory already exists and is not empty: ${projectRoot}\n` +
                    `Remove it or choose a different projectName before scaffolding.`
                );
            }

            // Step 1: Create the target directory so 'cwd' has a valid path
            fs.mkdirSync(projectRoot, { recursive: true });
            report.mutatedFiles.push(projectRoot);

            // Step 2: Clone the boilerplate DIRECTLY into the new folder using "."
            await execAsync(`git clone --branch ${branch} --depth 1 https://github.com/kunalBrahma/backend-boilerplate.git .`, {
                cwd: projectRoot,
                timeout: 30000,
            });

            // Step 3: Remove the original .git history
            const gitPath = path.join(projectRoot, ".git");
            if (fs.existsSync(gitPath)) {
                fs.rmSync(gitPath, { recursive: true, force: true });
            }

            // Step 4: Install dependencies if requested
            let installOutput = "";
            let installed = false;
            if (installDeps) {
                try {
                    await execAsync(`npm install`, { cwd: projectRoot, timeout: 60000 });
                    installOutput = `\n[SUCCESS] NPM dependencies installed successfully.`;
                    installed = true;
                } catch (err: unknown) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    installOutput = `\n[WARNING] NPM installation failed. Run \`npm install\` manually. Error: ${errorMessage}`;
                    report.status = "PARTIAL_FAILURE";
                }
            }

            // Step 5: Post-Clone Stability Improvements (npx prisma generate + tsc --noEmit)
            let prismaOutput = "";
            if (installed) {
                try {
                    await execAsync(`npx prisma generate`, { cwd: projectRoot, timeout: 30000 });
                    prismaOutput = `\n[SUCCESS] Prisma client generated automatically.`;

                    try {
                        await execAsync(`npx tsc --noEmit`, { cwd: projectRoot, timeout: 30000 });
                        prismaOutput += `\n[SUCCESS] TypeScript validation passed.`;
                    } catch (tscErr: unknown) {
                        prismaOutput += `\n[WARNING] TypeScript validation failed. You may need to fix type errors manually.`;
                        report.status = "PARTIAL_FAILURE";
                    }
                } catch (err: unknown) {
                    prismaOutput = `\n[WARNING] Prisma generate failed. Ensure your .env is correctly configured with DATABASE_URL and run \`npx prisma generate\` manually.`;
                    report.status = "PARTIAL_FAILURE";
                }
            }

            report.humanMessage = `[SUCCESS] Project "${projectName}" scaffolded successfully at ${projectRoot} using Kunal's backend-boilerplate.${installOutput}${prismaOutput}\n\nNext steps:\n  1. cd ${projectRoot}\n  2. Add your DATABASE_URL to the .env file\n  3. Run your Prisma migrations`;
        });
    },
};
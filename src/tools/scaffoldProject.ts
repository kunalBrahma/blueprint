import { z } from "zod";
import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import util from "node:util";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { withMutationReport } from "../utils/mutationTracker.js";

const execAsync = util.promisify(exec);

// 1. Zod Schema
const scaffoldProjectSchema = z.object({
    projectName: z.string().describe("The name of the project to scaffold"),
    outputDir: z
        .string()
        .describe("The absolute path to the directory where the project should be created"),
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
        const { projectName, outputDir, installDeps } = args;
        const projectPath = path.join(outputDir, projectName);

        return withMutationReport("scaffold_project", projectPath, async (report) => {
            // Validate output dir exists
            if (!fs.existsSync(outputDir)) {
                throw new Error(`Output directory does not exist: ${outputDir}`);
            }

            // Check if project already exists
            if (fs.existsSync(projectPath)) {
                throw new Error(`Directory already exists: ${projectPath}`);
            }

            // Step 1: Create the target directory so 'cwd' has a valid path
            fs.mkdirSync(projectPath, { recursive: true });
            report.mutatedFiles.push(projectPath);

            // Step 2: Clone the boilerplate DIRECTLY into the new folder using "."
            await execAsync(`git clone https://github.com/kunalBrahma/backend-boilerplate.git .`, {
                cwd: projectPath
            });

            // Step 3: Remove the original .git history
            const gitPath = path.join(projectPath, ".git");
            if (fs.existsSync(gitPath)) {
                fs.rmSync(gitPath, { recursive: true, force: true });
            }

            // Step 4: Install dependencies if requested
            let installOutput = "";
            if (installDeps) {
                try {
                    // Using cwd is cleaner and safer than chaining 'cd' commands
                    await execAsync(`npm install`, { cwd: projectPath });
                    installOutput = `\n[SUCCESS] NPM dependencies installed successfully.`;
                } catch (err: unknown) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    installOutput = `\n[WARNING] NPM installation failed. Run \`npm install\` manually. Error: ${errorMessage}`;
                    report.status = "PARTIAL_FAILURE";
                }
            }

            report.humanMessage = `[SUCCESS] Project "${projectName}" scaffolded successfully at ${projectPath} using Kunal's backend-boilerplate.${installOutput}\n\nNext steps:\n  1. cd ${projectPath}\n  2. Add your DATABASE_URL to the .env file\n  3. Run your Prisma migrations`;
        });
    },
};
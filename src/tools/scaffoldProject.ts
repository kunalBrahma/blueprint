import { z } from "zod";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import util from "node:util";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { withMutationReport } from "../utils/mutationTracker.js";
import { enforcePathJail } from "../utils/pathJail.js";
import { WORKSPACE_ROOT } from "../utils/workspace.js";

const execFileAsync = util.promisify(execFile);

const BOILERPLATE_REPO = "https://github.com/kunalBrahma/backend-boilerplate.git";
const PLACEHOLDER_DATABASE_URL = "postgresql://placeholder:placeholder@localhost:5432/placeholder";

// A valid git ref/branch name: no shell metacharacters, no leading "-" (which
// would otherwise be interpreted as a CLI flag by git), no ".." segments.
const GIT_REF_PATTERN = /^(?!-)(?!.*\.\.)[a-zA-Z0-9._/-]+$/;

// Standalone apps shipped in the boilerplate monorepo, one top-level folder each.
const APPS = ["backend", "frontend", "admin"] as const;
type App = (typeof APPS)[number];

// 1. Zod Schema
const scaffoldProjectSchema = z.object({
    projectName: z.string().describe("The name of the project to scaffold"),
    outputDir: z
        .string()
        .describe("The absolute path to the directory where the project should be created"),
    apps: z
        .array(z.enum(APPS))
        .min(1, "apps must include at least one of: backend, frontend, admin")
        .default(["backend"])
        .describe(
            "Which boilerplate apps to include: 'backend' (Express + Prisma API), 'frontend' (Next.js public app), " +
            "'admin' (Next.js admin dashboard). Defaults to backend only; pass all three for the full stack. " +
            "Each app lands in its own sub-folder (e.g. <project>/backend)."
        ),
    branch: z
        .string()
        .regex(GIT_REF_PATTERN, "branch must be a valid git ref (letters, digits, '.', '_', '-', '/', no leading '-', no '..')")
        .default("main")
        .describe("The branch or tag to clone from the boilerplate repository"),
    installDeps: z
        .boolean()
        .default(true)
        .describe("Whether to install npm dependencies for each selected app after cloning"),
});

type ScaffoldParams = typeof scaffoldProjectSchema;

// 2. Tool Execution (Cloning your Boilerplate)
export const scaffoldProject: Tool<FastMCPSessionAuth, ScaffoldParams> = {
    name: "scaffold_project",
    description:
        "Instantly clones Kunal's boilerplate into a new directory, removes git history, and prepares it for development. " +
        "Choose which apps to include via `apps`: backend only (default), or any mix of backend, frontend and admin for the full stack.",
    parameters: scaffoldProjectSchema,
    execute: async (args) => {
        const { projectName, outputDir, installDeps, branch } = args;
        const apps = [...new Set(args.apps)] as App[];
        const absoluteOutputDir = path.resolve(WORKSPACE_ROOT, outputDir);

        // The actual clone target is a sub-directory named after the project.
        // This allows the *parent* outputDir to be non-empty (e.g. a monorepo root)
        // while still guarding against overwriting an existing project directory.
        const projectRoot = enforcePathJail(
            WORKSPACE_ROOT,
            path.join(absoluteOutputDir, projectName)
        );

        return withMutationReport("scaffold_project", projectRoot, async (report) => {
            // Each app is type-checked below in its own folder. The wrapper's
            // generic tsc pass would start from the monorepo root, which has no
            // package.json/tsconfig and could resolve to an unrelated parent project.
            report.skipValidation = true;

            // Guard: only the specific target sub-dir must be empty or absent
            if (fs.existsSync(projectRoot) && fs.readdirSync(projectRoot).length > 0) {
                throw new Error(
                    `Target directory already exists and is not empty: ${projectRoot}\n` +
                    `Remove it or choose a different projectName before scaffolding.`
                );
            }

            // Track whether we're the ones creating this directory, so we can
            // clean up debris on failure instead of leaving a half-scaffolded
            // folder that blocks retries under the same projectName.
            const dirPreexisted = fs.existsSync(projectRoot);

            try {
                // Step 1: Create the target directory so 'cwd' has a valid path
                fs.mkdirSync(projectRoot, { recursive: true });
                report.mutatedFiles.push(projectRoot);

                // Step 2: Clone the boilerplate DIRECTLY into the new folder using ".".
                // Uses execFile (no shell) with an argument array so `branch` can never
                // be interpreted as a shell command, even though it's also validated
                // against GIT_REF_PATTERN by the zod schema above (defense in depth).
                await execFileAsync(
                    "git",
                    ["clone", "--branch", branch, "--depth", "1", BOILERPLATE_REPO, "."],
                    { cwd: projectRoot, timeout: 60000 }
                );

                // Step 3: Remove the original .git history
                const gitPath = path.join(projectRoot, ".git");
                if (fs.existsSync(gitPath)) {
                    fs.rmSync(gitPath, { recursive: true, force: true });
                }

                // Step 4: Keep only the requested apps. Older refs (e.g. v1.0.0) use a
                // flat backend-only layout with no app folders at all.
                const isMonorepo = APPS.some((app) => fs.existsSync(path.join(projectRoot, app)));
                let appDirs: { app: App; dir: string }[];

                if (isMonorepo) {
                    const missing = apps.filter((app) => !fs.existsSync(path.join(projectRoot, app)));
                    if (missing.length > 0) {
                        throw new Error(
                            `Branch "${branch}" of the boilerplate has no ${missing.join(", ")} app. ` +
                            `Available: ${APPS.filter((app) => fs.existsSync(path.join(projectRoot, app))).join(", ")}.`
                        );
                    }
                    for (const app of APPS) {
                        if (!apps.includes(app)) {
                            fs.rmSync(path.join(projectRoot, app), { recursive: true, force: true });
                        }
                    }
                    // Root docker-compose.yml only orchestrates backend + Postgres.
                    if (!apps.includes("backend")) {
                        for (const file of ["docker-compose.yml", ".env.example"]) {
                            fs.rmSync(path.join(projectRoot, file), { force: true });
                        }
                    }
                    appDirs = apps.map((app) => ({ app, dir: path.join(projectRoot, app) }));
                } else {
                    if (apps.some((app) => app !== "backend")) {
                        throw new Error(
                            `Branch "${branch}" of the boilerplate is backend-only (flat layout). ` +
                            `Use branch "main" to include frontend/admin.`
                        );
                    }
                    appDirs = [{ app: "backend", dir: projectRoot }];
                }

                // Step 5: Per-app install, then Prisma generate + tsc for the backend
                // and tsc for the Next.js apps.
                const notes: string[] = [];
                for (const { app, dir } of appDirs) {
                    if (!installDeps) continue;

                    try {
                        await execFileAsync("npm", ["install"], { cwd: dir, timeout: 300000 });
                        notes.push(`[SUCCESS] ${app}: npm dependencies installed.`);
                    } catch (err: unknown) {
                        const errorMessage = err instanceof Error ? err.message : String(err);
                        notes.push(`[WARNING] ${app}: npm install failed. Run \`npm install\` in ${dir} manually. Error: ${errorMessage}`);
                        report.status = "PARTIAL_FAILURE";
                        continue;
                    }

                    if (app === "backend") {
                        // prisma.config.ts resolves DATABASE_URL on load, but generate never
                        // connects — a placeholder lets it run before the user has a .env
                        // (same trick as the boilerplate's Dockerfile build stage).
                        try {
                            await execFileAsync("npx", ["prisma", "generate"], {
                                cwd: dir,
                                timeout: 60000,
                                env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? PLACEHOLDER_DATABASE_URL },
                            });
                            notes.push(`[SUCCESS] ${app}: Prisma client generated.`);
                        } catch {
                            notes.push(`[WARNING] ${app}: Prisma generate failed. Run \`npx prisma generate\` in ${dir} manually.`);
                            report.status = "PARTIAL_FAILURE";
                            continue;
                        }
                    } else {
                        // Next.js declares global route types (LayoutProps, PageProps)
                        // only after typegen; tsc fails on a fresh clone without them.
                        try {
                            await execFileAsync("npx", ["next", "typegen"], { cwd: dir, timeout: 60000 });
                        } catch {
                            // tsc below will surface the problem
                        }
                    }

                    try {
                        await execFileAsync("npx", ["tsc", "--noEmit"], { cwd: dir, timeout: 60000 });
                        notes.push(`[SUCCESS] ${app}: TypeScript validation passed.`);
                    } catch {
                        notes.push(`[WARNING] ${app}: TypeScript validation failed. You may need to fix type errors manually.`);
                        report.status = "PARTIAL_FAILURE";
                    }
                }

                const cdInto = (dir: string) => {
                    const rel = path.relative(projectRoot, dir);
                    return rel ? `cd ${rel} && ` : "";
                };
                const nextSteps: string[] = [];
                for (const { app, dir } of appDirs) {
                    if (app === "backend") {
                        nextSteps.push(`${cdInto(dir)}cp .env.example .env, then set DATABASE_URL and JWT_ACCESS_SECRET`);
                        nextSteps.push(`${cdInto(dir)}npx prisma migrate dev` +
                                (fs.existsSync(path.join(projectRoot, "docker-compose.yml"))
                                    ? ` (or \`docker compose up --build\` from the project root)`
                                    : ""));
                    } else {
                        nextSteps.push(`${cdInto(dir)}cp .env.local.example .env.local, then point NEXT_PUBLIC_API_URL at the backend`);
                    }
                }

                report.humanMessage =
                    `[SUCCESS] Project "${projectName}" scaffolded at ${projectRoot} with: ${apps.join(", ")} (branch "${branch}").` +
                    (notes.length ? `\n${notes.join("\n")}` : "") +
                    `\n\nNext steps (from ${projectRoot}):\n` +
                    nextSteps.map((step, i) => `  ${i + 1}. ${step}`).join("\n");
            } catch (err: unknown) {
                // Clean up a directory we created ourselves so a failed clone/install
                // doesn't leave debris blocking retries under the same projectName.
                if (!dirPreexisted) {
                    try {
                        fs.rmSync(projectRoot, { recursive: true, force: true });
                        report.mutatedFiles = report.mutatedFiles.filter((f) => f !== projectRoot);
                    } catch {
                        // best-effort cleanup only
                    }
                }
                throw err;
            }
        });
    },
};

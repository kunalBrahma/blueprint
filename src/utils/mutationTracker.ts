import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MutationResult {
    correlationId: string;
    operation: string;
    status: "SUCCESS" | "ERROR" | "PARTIAL_FAILURE";
    mutatedFiles: string[];
    validation: { passed: boolean; output: string };
    rollback: { triggered: boolean; restoredFiles: string[] };
    humanMessage: string;
}

export interface MutationReport {
    mutatedFiles: string[];
    humanMessage: string;
    status?: "SUCCESS" | "PARTIAL_FAILURE";
    skipValidation?: boolean;
    /**
     * Register file paths to snapshot BEFORE writing to them.
     * Call this before performing any fs.writeFile operations.
     * If tsc --noEmit fails later, these files will be restored.
     */
    snapshotFiles: (paths: string[]) => void;
}

// ─── Snapshot Engine ──────────────────────────────────────────────────────────

/** null = file did not exist before the mutation (newly created) */
type FileSnapshot = Map<string, Buffer | null>;

function captureSnapshots(filePaths: string[], existing: FileSnapshot): void {
    for (const fp of filePaths) {
        if (existing.has(fp)) continue; // already captured
        if (fs.existsSync(fp)) {
            existing.set(fp, fs.readFileSync(fp));
        } else {
            existing.set(fp, null);
        }
    }
}

function restoreSnapshots(snapshots: FileSnapshot): string[] {
    const restored: string[] = [];
    for (const [fp, original] of snapshots) {
        try {
            if (original === null) {
                // File was newly created by the mutation — delete it
                if (fs.existsSync(fp)) {
                    fs.unlinkSync(fp);
                    restored.push(`[DELETED] ${fp}`);
                }
            } else {
                // Restore original content
                fs.writeFileSync(fp, original);
                restored.push(`[RESTORED] ${fp}`);
            }
        } catch (err) {
            console.error(`[rollback] Failed to restore ${fp}:`, err);
            restored.push(`[FAILED] ${fp}`);
        }
    }
    return restored;
}

// ─── Utility: find tsconfig.json from a path ─────────────────────────────────

function findProjectRoot(startPath: string): string | null {
    let current = path.resolve(startPath);
    for (let i = 0; i < 10; i++) {
        if (fs.existsSync(path.join(current, "tsconfig.json"))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return null;
}

// ─── Core Wrapper ─────────────────────────────────────────────────────────────

/**
 * Universal telemetry wrapper for all Blueprint MCP tools.
 *
 * Supports atomic rollback: if a tool calls report.snapshotFiles() before
 * writing, and tsc --noEmit fails afterward, all snapshotted files are
 * automatically restored to their pre-mutation state.
 *
 * @param operationName - The tool's registered name (e.g. "inject_express_route")
 * @param projectPath   - Absolute path to the target project root (or null to skip validation)
 * @param action        - The closure containing the tool's existing logic
 * @returns Stringified JSON MutationResult
 */
export async function withMutationReport(
    operationName: string,
    projectPath: string | null,
    action: (report: MutationReport) => Promise<void>,
    skipValidation?: boolean
): Promise<string> {
    const correlationId = crypto.randomUUID();
    const snapshots: FileSnapshot = new Map();

    const report: MutationReport = {
        mutatedFiles: [],
        humanMessage: "",
        status: "SUCCESS",
        snapshotFiles: (paths: string[]) => captureSnapshots(paths, snapshots),
    };

    const result: MutationResult = {
        correlationId,
        operation: operationName,
        status: "SUCCESS",
        mutatedFiles: [],
        validation: { passed: true, output: "" },
        rollback: { triggered: false, restoredFiles: [] },
        humanMessage: "",
    };

    try {
        await action(report);
        result.mutatedFiles = report.mutatedFiles;
        result.humanMessage = report.humanMessage;
        result.status = report.status ?? "SUCCESS";
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.status = "ERROR";
        result.humanMessage = `[ERROR] ${msg}`;
        result.mutatedFiles = report.mutatedFiles;

        // Rollback on action error if snapshots exist
        if (snapshots.size > 0) {
            const restored = restoreSnapshots(snapshots);
            result.rollback = { triggered: true, restoredFiles: restored };
            result.humanMessage += `\n[ROLLBACK] ${restored.length} file(s) restored.`;
        }
    }

    // Run tsc --noEmit validation only on non-error, non-empty mutations
    const envSkip = process.env.SKIP_TSC_VALIDATION === "true" || process.env.NODE_ENV === "test";
    const finalSkip = envSkip || skipValidation || report.skipValidation;

    if (result.status !== "ERROR" && projectPath) {
        if (finalSkip) {
            // Report honestly that validation did not run, instead of
            // silently leaving the default { passed: true, output: "" },
            // which reads identically to "we checked and it passed."
            result.validation = { passed: true, output: "SKIPPED: tsc validation was explicitly disabled for this operation." };
        } else {
            const root = findProjectRoot(projectPath);
            if (root && fs.existsSync(path.join(root, "tsconfig.json"))) {
                try {
                    execSync("npx tsc --noEmit", {
                        cwd: root,
                        stdio: "pipe",
                        timeout: 30000,
                    });
                    result.validation = { passed: true, output: "tsc --noEmit passed" };
                } catch (err: unknown) {
                    const output =
                        err instanceof Error && "stdout" in err
                            ? String((err as any).stdout)
                            : String(err);
                    result.validation = { passed: false, output: output.slice(0, 2000) };

                    // Atomic rollback: tsc failed → restore all snapshots
                    if (snapshots.size > 0) {
                        const restored = restoreSnapshots(snapshots);
                        result.rollback = { triggered: true, restoredFiles: restored };
                        result.status = "ERROR";
                        result.humanMessage =
                            `[ERROR] TypeScript compilation failed after mutation. All changes have been rolled back.\n` +
                            `[ROLLBACK] ${restored.length} file(s) restored.\n` +
                            `[TSC OUTPUT] ${output.slice(0, 500)}`;
                    }
                }
            } else {
                // Systemic blind spot: no tsconfig.json found anywhere up the
                // tree from projectPath, so tsc never ran at all. Previously
                // this silently left validation.passed at its default `true`,
                // indistinguishable from an actual passing validation run.
                result.validation = {
                    passed: true,
                    output: `SKIPPED: no tsconfig.json found starting from "${projectPath}" — mutation was NOT type-checked.`,
                };
            }
        }
    }

    return JSON.stringify(result);
}

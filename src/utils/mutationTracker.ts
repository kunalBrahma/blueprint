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
    humanMessage: string;
}

export interface MutationReport {
    mutatedFiles: string[];
    humanMessage: string;
    status?: "SUCCESS" | "PARTIAL_FAILURE";
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
 * @param operationName - The tool's registered name (e.g. "inject_express_route")
 * @param projectPath   - Absolute path to the target project root (or null to skip validation)
 * @param action        - The closure containing the tool's existing logic
 * @returns Stringified JSON MutationResult
 */
export async function withMutationReport(
    operationName: string,
    projectPath: string | null,
    action: (report: MutationReport) => Promise<void>
): Promise<string> {
    const correlationId = crypto.randomUUID();

    const report: MutationReport = {
        mutatedFiles: [],
        humanMessage: "",
        status: "SUCCESS",
    };

    const result: MutationResult = {
        correlationId,
        operation: operationName,
        status: "SUCCESS",
        mutatedFiles: [],
        validation: { passed: true, output: "" },
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
    }

    // Run tsc --noEmit validation only on non-error, non-empty mutations
    if (result.status !== "ERROR" && projectPath) {
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
            }
        }
    }

    return JSON.stringify(result);
}

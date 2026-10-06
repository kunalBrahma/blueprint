import * as process from "node:process";
import * as path from "node:path";
import * as os from "node:os";

function resolveWorkspaceRoot(): string {
    const envRoot = process.env.MCP_WORKSPACE_ROOT;
    if (envRoot && envRoot.trim() !== '') {
        return path.resolve(envRoot);
    }
    return process.cwd();
}

/**
 * Global workspace root for the Blueprint Architect MCP server.
 * This determines the absolute filesystem boundary that tools cannot escape.
 */
export const WORKSPACE_ROOT = resolveWorkspaceRoot();


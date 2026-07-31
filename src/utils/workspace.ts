import * as process from "node:process";
import * as path from "node:path";
import * as os from "node:os";

function resolveWorkspaceRoot(): string {
    const envRoot = process.env.MCP_WORKSPACE_ROOT;
    if (envRoot && envRoot.trim() !== '') {
        return path.resolve(envRoot);
    }

    throw new Error(
        "[FATAL] MCP_WORKSPACE_ROOT is not set. " +
        "Blueprint MCP requires an explicit workspace root. " +
        "Set it via: export MCP_WORKSPACE_ROOT=/path/to/your/project"
    );
}

/**
 * Global workspace root for the Blueprint Architect MCP server.
 * This determines the absolute filesystem boundary that tools cannot escape.
 */
export const WORKSPACE_ROOT = resolveWorkspaceRoot();


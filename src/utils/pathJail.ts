import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Filesystem boundary enforcer — ensures a requested path
 * cannot escape the workspace root via traversal or symlinks.
 *
 * @param workspaceRoot - Trusted absolute path to the project root
 * @param requestedPath - Untrusted path from the AI agent
 * @returns The resolved, validated absolute path
 * @throws Error if the path escapes the workspace boundary
 */
export function enforcePathJail(
    workspaceRoot: string,
    requestedPath: string
): string {
    if (!path.isAbsolute(workspaceRoot)) {
        throw new Error(
            `[PathJail] workspaceRoot must be an absolute path. Got: "${workspaceRoot}"`
        );
    }

    const resolvedTarget = path.resolve(workspaceRoot, requestedPath);
    const resolvedRoot = path.resolve(workspaceRoot);

    const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(rootPrefix)) {
        throw new Error(
            `[PathJail] Path traversal blocked.\n` +
            `  Workspace: ${resolvedRoot}\n` +
            `  Requested: ${requestedPath}\n` +
            `  Resolved:  ${resolvedTarget}\n` +
            `The resolved path escapes the workspace boundary.`
        );
    }

    // Symlink check: if the path exists on disk, verify its real path
    // is also within the workspace boundary
    if (fs.existsSync(resolvedTarget)) {
        const realPath = fs.realpathSync(resolvedTarget);
        const realRoot = fs.realpathSync(resolvedRoot);

        const realPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
        if (realPath !== realRoot && !realPath.startsWith(realPrefix)) {
            throw new Error(
                `[PathJail] Symlink escape blocked.\n` +
                `  Workspace: ${realRoot}\n` +
                `  Symlink:   ${resolvedTarget}\n` +
                `  Real path: ${realPath}\n` +
                `The symlink target escapes the workspace boundary.`
            );
        }
    } else {
        // For non-existent paths, validate the nearest existing ancestor
        let ancestor = path.dirname(resolvedTarget);
        for (let depth = 0; depth < 20; depth++) {
            if (fs.existsSync(ancestor)) {
                const realAncestor = fs.realpathSync(ancestor);
                const realRoot = fs.realpathSync(resolvedRoot);
                const realPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
                if (realAncestor !== realRoot && !realAncestor.startsWith(realPrefix)) {
                    throw new Error(
                        `[PathJail] Ancestor symlink escape blocked.\n` +
                        `  Workspace:       ${realRoot}\n` +
                        `  Resolved path:   ${resolvedTarget}\n` +
                        `  Ancestor:        ${ancestor}\n` +
                        `  Real ancestor:   ${realAncestor}\n` +
                        `The nearest existing ancestor resolves outside the workspace.`
                    );
                }
                break;
            }
            const parent = path.dirname(ancestor);
            if (parent === ancestor) break; // reached filesystem root
            ancestor = parent;
        }
    }

    return resolvedTarget;
}

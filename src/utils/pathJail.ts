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

    // Resolve the requested path against the workspace root
    const resolved = path.resolve(workspaceRoot, requestedPath);
    const normalizedRoot = path.normalize(workspaceRoot);

    // Boundary check: resolved path must start with the workspace root
    if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
        throw new Error(
            `[PathJail] Path traversal blocked.\n` +
            `  Workspace: ${normalizedRoot}\n` +
            `  Requested: ${requestedPath}\n` +
            `  Resolved:  ${resolved}\n` +
            `The resolved path escapes the workspace boundary.`
        );
    }

    // Symlink check: if the path exists on disk, verify its real path
    // is also within the workspace boundary
    if (fs.existsSync(resolved)) {
        const realPath = fs.realpathSync(resolved);
        const realRoot = fs.realpathSync(normalizedRoot);

        if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
            throw new Error(
                `[PathJail] Symlink escape blocked.\n` +
                `  Workspace: ${realRoot}\n` +
                `  Symlink:   ${resolved}\n` +
                `  Real path: ${realPath}\n` +
                `The symlink target escapes the workspace boundary.`
            );
        }
    } else {
        // For non-existent paths, validate the nearest existing ancestor
        let ancestor = path.dirname(resolved);
        for (let depth = 0; depth < 20; depth++) {
            if (fs.existsSync(ancestor)) {
                const realAncestor = fs.realpathSync(ancestor);
                const realRoot = fs.realpathSync(normalizedRoot);
                if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) {
                    throw new Error(
                        `[PathJail] Ancestor symlink escape blocked.\n` +
                        `  Workspace:       ${realRoot}\n` +
                        `  Resolved path:   ${resolved}\n` +
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

    return resolved;
}

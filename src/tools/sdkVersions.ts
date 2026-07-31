import * as fs from "node:fs";
import * as path from "node:path";
import { enforcePathJail } from "../utils/pathJail.js";
import { WORKSPACE_ROOT } from "../utils/workspace.js";

export function recordInstalledPackages(projectRoot: string, packages: string[]): void {
  try {
    const pkgJsonPath = path.join(projectRoot, "package.json");
    if (!fs.existsSync(pkgJsonPath)) return;

    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    const allDeps = { ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) };

    const lines = [] as string[];
    const now = new Date().toISOString();
    lines.push(`# SDK Versions — recorded ${now}`);
    for (const p of packages) {
      const v = allDeps[p] || "<not-found>";
      lines.push(`- ${p}: ${v}`);
    }
    lines.push("");

    const outPath = path.join(projectRoot, "SDK_VERSIONS.md");
    const safeOutPath = enforcePathJail(WORKSPACE_ROOT, outPath);
    // Append to file for history
    fs.appendFileSync(safeOutPath, lines.join("\n") + "\n", "utf-8");
  } catch (err) {
    // Best-effort: do not throw from tooling
    try {
      const outPath = path.join(projectRoot, "SDK_VERSIONS.md");
      const safeOutPath = enforcePathJail(WORKSPACE_ROOT, outPath);
      fs.appendFileSync(safeOutPath, `# SDK Versions — record failed: ${String(err)}\n`, "utf-8");
    } catch (innerErr) {
      console.error("[sdkVersions] Failed to write SDK version fallback:", innerErr);
    }
  }
}

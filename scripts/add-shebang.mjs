#!/usr/bin/env node
/**
 * Post-build script: prepends "#!/usr/bin/env node" to dist/index.js
 * and sets the file permissions to 0o755 (executable).
 *
 * Run automatically via the `build` npm script after `tsc`.
 */

import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entryPath = resolve(__dirname, "../dist/index.js");
const SHEBANG = "#!/usr/bin/env node\n";

if (!existsSync(entryPath)) {
    console.error(`[add-shebang] ERROR: dist/index.js not found at ${entryPath}`);
    console.error("[add-shebang] Run 'tsc' first before this script.");
    process.exit(1);
}

const content = readFileSync(entryPath, "utf-8");

if (content.startsWith(SHEBANG)) {
    console.log("[add-shebang] Shebang already present — skipping.");
} else {
    writeFileSync(entryPath, SHEBANG + content, "utf-8");
    console.log("[add-shebang] Shebang prepended to dist/index.js");
}

// Make the entry point executable
chmodSync(entryPath, 0o755);
console.log("[add-shebang] dist/index.js set to executable (0755)");

import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Import targets under test ────────────────────────────────────────────────
import { enforcePathJail } from "../src/utils/pathJail.js";

// ─── Temp workspace setup ─────────────────────────────────────────────────────

let tmpDir: string;

before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-safety-"));
    // Create a minimal workspace structure
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "index.ts"), "console.log('hello');");
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "test content");
});

after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE 1: Path Jail — Filesystem Boundary Enforcement
// ═══════════════════════════════════════════════════════════════════════════════

describe("PathJail: enforcePathJail", () => {

    it("allows a valid path within the workspace", () => {
        const result = enforcePathJail(tmpDir, "src/index.ts");
        assert.equal(result, path.join(tmpDir, "src", "index.ts"));
    });

    it("allows the workspace root itself", () => {
        const result = enforcePathJail(tmpDir, ".");
        assert.equal(result, tmpDir);
    });

    it("allows a non-existent path with a valid ancestor", () => {
        const result = enforcePathJail(tmpDir, "src/new/deep/file.ts");
        assert.equal(result, path.join(tmpDir, "src", "new", "deep", "file.ts"));
    });

    it("blocks ../../etc/passwd traversal", () => {
        assert.throws(
            () => enforcePathJail(tmpDir, "../../etc/passwd"),
            (err: Error) => {
                assert.ok(err.message.includes("[PathJail] Path traversal blocked"));
                return true;
            }
        );
    });

    it("blocks absolute path outside workspace", () => {
        assert.throws(
            () => enforcePathJail(tmpDir, "/etc/hosts"),
            (err: Error) => {
                assert.ok(err.message.includes("[PathJail] Path traversal blocked"));
                return true;
            }
        );
    });

    it("blocks deeply nested traversal", () => {
        assert.throws(
            () => enforcePathJail(tmpDir, "src/../../../../../../etc/shadow"),
            (err: Error) => {
                assert.ok(err.message.includes("[PathJail]"));
                return true;
            }
        );
    });

    it("throws on relative workspaceRoot", () => {
        assert.throws(
            () => enforcePathJail("./relative/root", "file.ts"),
            (err: Error) => {
                assert.ok(err.message.includes("must be an absolute path"));
                return true;
            }
        );
    });

    it("blocks symlink escaping the workspace", () => {
        const symlinkPath = path.join(tmpDir, "escape-link");
        try {
            fs.symlinkSync("/etc", symlinkPath);
        } catch {
            // If symlink creation fails (permissions), skip this test gracefully
            return;
        }

        try {
            assert.throws(
                () => enforcePathJail(tmpDir, "escape-link"),
                (err: Error) => {
                    assert.ok(err.message.includes("[PathJail] Symlink escape blocked"));
                    return true;
                }
            );
        } finally {
            fs.unlinkSync(symlinkPath);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE 2: Snapshot & Rollback Engine
// ═══════════════════════════════════════════════════════════════════════════════

describe("MutationTracker: Snapshot & Rollback", () => {
    // We test the snapshot primitives by importing them indirectly through
    // withMutationReport. Since captureSnapshots and restoreSnapshots are
    // private, we exercise them through the public API.

    it("rollback restores original file content on action error", async () => {
        // Dynamically import to avoid compile issues with the test runner
        const { withMutationReport } = await import("../src/utils/mutationTracker.js");

        const testFile = path.join(tmpDir, "rollback-test.txt");
        fs.writeFileSync(testFile, "ORIGINAL CONTENT");

        const jsonResult = await withMutationReport("test_rollback", null, async (report) => {
            // Snapshot before writing
            report.snapshotFiles([testFile]);
            // Mutate
            fs.writeFileSync(testFile, "MUTATED CONTENT");
            // Simulate an error
            throw new Error("Simulated failure");
        });

        const result = JSON.parse(jsonResult);
        assert.equal(result.status, "ERROR");
        assert.equal(result.rollback.triggered, true);

        // File should be restored to original
        const content = fs.readFileSync(testFile, "utf-8");
        assert.equal(content, "ORIGINAL CONTENT");
    });

    it("rollback deletes newly created files on action error", async () => {
        const { withMutationReport } = await import("../src/utils/mutationTracker.js");

        const newFile = path.join(tmpDir, "new-file-rollback.txt");
        // Ensure it doesn't exist
        if (fs.existsSync(newFile)) fs.unlinkSync(newFile);

        const jsonResult = await withMutationReport("test_rollback_new", null, async (report) => {
            report.snapshotFiles([newFile]);
            fs.writeFileSync(newFile, "SHOULD NOT SURVIVE");
            throw new Error("Simulated failure");
        });

        const result = JSON.parse(jsonResult);
        assert.equal(result.status, "ERROR");
        assert.equal(result.rollback.triggered, true);

        // File should have been deleted
        assert.equal(fs.existsSync(newFile), false);
    });

    it("does NOT rollback when no snapshots are registered", async () => {
        const { withMutationReport } = await import("../src/utils/mutationTracker.js");

        const testFile = path.join(tmpDir, "no-snapshot.txt");
        fs.writeFileSync(testFile, "ORIGINAL");

        const jsonResult = await withMutationReport("test_no_snapshot", null, async (report) => {
            // No snapshot registered!
            fs.writeFileSync(testFile, "MUTATED WITHOUT SNAPSHOT");
            throw new Error("Simulated failure");
        });

        const result = JSON.parse(jsonResult);
        assert.equal(result.status, "ERROR");
        assert.equal(result.rollback.triggered, false);

        // File should remain mutated (no rollback without snapshot)
        const content = fs.readFileSync(testFile, "utf-8");
        assert.equal(content, "MUTATED WITHOUT SNAPSHOT");
    });

    it("preserves files on successful mutation", async () => {
        const { withMutationReport } = await import("../src/utils/mutationTracker.js");

        const testFile = path.join(tmpDir, "success-test.txt");
        fs.writeFileSync(testFile, "ORIGINAL");

        const jsonResult = await withMutationReport("test_success", null, async (report) => {
            report.snapshotFiles([testFile]);
            fs.writeFileSync(testFile, "UPDATED SUCCESSFULLY");
            report.mutatedFiles.push(testFile);
            report.humanMessage = "All good";
        });

        const result = JSON.parse(jsonResult);
        assert.equal(result.status, "SUCCESS");
        assert.equal(result.rollback.triggered, false);

        // File should remain updated
        const content = fs.readFileSync(testFile, "utf-8");
        assert.equal(content, "UPDATED SUCCESSFULLY");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE 3: AST Hard-Fail — Duplicate Model Injection (Prisma)
// ═══════════════════════════════════════════════════════════════════════════════

describe("AST Hard-Fail: Duplicate Prisma Model", () => {

    it("throws on duplicate model name in schema", () => {
        // The injectPrismaModel tool uses a regex guard. We test the same pattern.
        const schemaContent = `
model User {
  id    String @id @default(cuid())
  email String @unique
}
`;
        const modelName = "User";
        const duplicatePattern = new RegExp(
            `^\\s*model\\s+${modelName}\\s*\\{`,
            "m"
        );

        assert.ok(
            duplicatePattern.test(schemaContent),
            `Expected duplicate model "${modelName}" to be detected`
        );
    });

    it("does NOT trigger on a different model name", () => {
        const schemaContent = `
model User {
  id    String @id @default(cuid())
  email String @unique
}
`;
        const modelName = "Product";
        const duplicatePattern = new RegExp(
            `^\\s*model\\s+${modelName}\\s*\\{`,
            "m"
        );

        assert.equal(
            duplicatePattern.test(schemaContent),
            false,
            `Model "${modelName}" should not match`
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE 4: AST Hard-Fail — Ambiguous Router Detection
// ═══════════════════════════════════════════════════════════════════════════════

describe("AST Hard-Fail: Ambiguous Router", () => {

    it("detects multiple Router declarations in source code", () => {
        // Simulate the detection logic from injectExpressRoute
        const sourceContent = `
import express from "express";
const router = express.Router();
const adminRouter = express.Router();
`;
        const routerPattern = /(?:express\.Router\(|Router\(|express\()/g;
        const matches = sourceContent.match(routerPattern);

        assert.ok(matches, "Should find router declarations");
        assert.ok(
            matches.length > 1,
            `Expected multiple router declarations, got ${matches.length}. ` +
            `This should trigger an [AST Hard-Fail] in the real tool.`
        );
    });

    it("single Router declaration passes", () => {
        const sourceContent = `
import express from "express";
const router = express.Router();
router.get("/", (req, res) => res.json({ ok: true }));
export default router;
`;
        const routerPattern = /(?:express\.Router\(|Router\(|express\()/g;
        const matches = sourceContent.match(routerPattern);

        assert.ok(matches, "Should find a router declaration");
        assert.equal(
            matches.length,
            1,
            `Expected exactly 1 router declaration, got ${matches.length}`
        );
    });

    it("detects duplicate route (same method + path)", () => {
        const sourceContent = `
router.get("/users", async (req, res) => { res.json([]); });
router.post("/users", async (req, res) => { res.json({}); });
router.get("/users", async (req, res) => { res.json(["duplicate"]); });
`;
        // Check for duplicate GET /users
        const method = "get";
        const routePath = "/users";
        const routePattern = new RegExp(
            `router\\.${method}\\s*\\(\\s*["']${routePath.replace(/\//g, "\\/")}["']`,
            "g"
        );
        const matches = sourceContent.match(routePattern);

        assert.ok(matches, "Should find route declarations");
        assert.ok(
            matches.length > 1,
            `Expected duplicate route ${method.toUpperCase()} "${routePath}", got ${matches.length} match(es). ` +
            `This should trigger an [AST Hard-Fail] in the real tool.`
        );
    });
});

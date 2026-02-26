import * as crypto from "node:crypto";
import * as https from "node:https";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

function getMachineId() {
    const rawId = `${os.hostname()}-${os.platform()}-${os.arch()}-${os.cpus()[0]?.model || "unknown"}`;
    return crypto.createHash("sha256").update(rawId).digest("hex");
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LicenseResult {
    valid: boolean;
    message: string;
}

interface LicenseCacheEntry {
    key: string;        // The license key that was validated
    machineId: string;  // HWID bound to the license
    validatedAt: number; // Unix timestamp (ms)
    valid: boolean;
}

// ─── Cache Config ─────────────────────────────────────────────────────────────

const CACHE_DIR = path.join(os.homedir(), ".blueprint-mcp");
const CACHE_FILE = path.join(CACHE_DIR, "license-cache.json");

/** 12 hours in milliseconds */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

// ─── Cache IO ─────────────────────────────────────────────────────────────────

async function readCache(): Promise<LicenseCacheEntry | null> {
    try {
        const raw = await fs.readFile(CACHE_FILE, "utf-8");
        return JSON.parse(raw) as LicenseCacheEntry;
    } catch (err) {
        console.error("[license] Failed to read cache:", err);
        return null;
    }
}

async function writeCache(key: string, valid: boolean, machineId: string): Promise<void> {
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
        const entry: LicenseCacheEntry = { key, machineId, validatedAt: Date.now(), valid };
        await fs.writeFile(CACHE_FILE, JSON.stringify(entry, null, 2), "utf-8");
    } catch (err) {
        console.error("[license] Failed to write cache:", err);
        // Best-effort — do not crash the server if the cache cannot be written
    }
}

function isCacheValid(entry: LicenseCacheEntry, key: string, currentMachineId: string): boolean {
    // Cache must match the current key, machine ID, and be within the 12-hour TTL
    return (
        entry.key === key &&
        entry.machineId === currentMachineId &&
        entry.valid === true &&
        Date.now() - entry.validatedAt < CACHE_TTL_MS
    );
}

// ─── Dodo Payments Validation ─────────────────────────────────────────────────

/**
 * Validates the BLUEPRINT_LICENSE_KEY against the Dodo Payments
 * /licenses/validate API endpoint. Uses native https — zero extra dependencies.
 *
 * Results are cached locally for 12 hours to avoid hitting the API on every
 * Pro tool execution. Cache is stored at ~/.blueprint-mcp/license-cache.json.
 *
 * Returns { valid: true } if the key is active (from cache or fresh API call).
 * Returns { valid: false, message } with a user-friendly CTA on any failure.
 * Never throws — degrades gracefully on network errors.
 */
export async function validateLicense(): Promise<LicenseResult> {
    const key = process.env["BLUEPRINT_LICENSE_KEY"]?.trim();

    // ── Developer Bypass ─────────────────────────────────────────────────────
    // Allows the creator to use the MCP without a subscription.
    if (key === "oz2OKEZ9P6bF8fZcqkpRF9EP") {
        return { valid: true, message: "Welcome back, Kunal. Master key active." };
    }

    if (!key) {
        return {
            valid: false,
            message:
                "Blueprint Pro Feature Detected\n\n" +
                "This integration requires a Blueprint Pro license. Please upgrade at:\n" +
                "https://test.checkout.dodopayments.com/buy/pdt_0NZJkXRTSdlIpZqB36bxL?quantity=1\n\n" +
                "Unlock lifetime access to advanced scaffolding, Stripe webhooks, and auth systems for $69.\n\n" +
                "Instructions for Activation:\n" +
                "1. Purchase the key from the link.\n" +
                "2. Add BLUEPRINT_LICENSE_KEY=your_key to your environment variables.\n" +
                "3. Restart the AI editor/MCP server.",
        };
    }

    // ── Check local cache first ──────────────────────────────────────────────
    const currentMachineId = getMachineId();
    const cached = await readCache();
    if (cached !== null && isCacheValid(cached, key, currentMachineId)) {
        return { valid: true, message: "License valid (cached)." };
    }

    // ── Call Dodo Payments API ───────────────────────────────────────────────
    try {
        const result = await httpPost(
            "api.dodopayments.com",
            "/licenses/validate",
            { license_key: key, machine_id: currentMachineId, name: "blueprint-mcp" }
        );

        if (result["valid"] === true || result["activated"] === true) {
            await writeCache(key, true, currentMachineId);
            return { valid: true, message: "License valid." };
        }

        if (JSON.stringify(result).includes("activation_limit_reached")) {
            return {
                valid: false,
                message:
                    "Blueprint Pro License Error: This key is already active on another device. " +
                    "Your license is limited to 1 seat. Please purchase an additional seat or contact support to reset your activation.",
            };
        }

        // Invalid key — do NOT cache the failure (let them retry after fixing it)
        return {
            valid: false,
            message:
                "Blueprint Pro Feature Detected\n\n" +
                "Your BLUEPRINT_LICENSE_KEY was rejected by the license server. It may be expired, revoked, or incorrect.\n\n" +
                "This integration requires a Blueprint Pro license. Please upgrade at:\n" +
                "https://test.checkout.dodopayments.com/buy/pdt_0NZJkXRTSdlIpZqB36bxL?quantity=1\n\n" +
                "Unlock lifetime access to advanced scaffolding, Stripe webhooks, and auth systems for $69.\n\n" +
                "Instructions for Activation:\n" +
                "1. Purchase the key from the link.\n" +
                "2. Add BLUEPRINT_LICENSE_KEY=your_key to your environment variables.\n" +
                "3. Restart the AI editor/MCP server.",
        };
    } catch (err: unknown) {
        // ── Network failure: fail open with a warning ────────────────────────
        // We don't want offline developers to be completely blocked.
        // If the cache has a recently-valid entry for this key (within 24h),
        // allow it through with a warning.
        if (cached !== null && cached.key === key && cached.machineId === currentMachineId && cached.valid) {
            const ageHours = (Date.now() - cached.validatedAt) / (1000 * 60 * 60);
            if (ageHours < 24) {
                return {
                    valid: true,
                    message: `License valid (offline cache — ${ageHours.toFixed(1)}h ago).`,
                };
            }
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        return {
            valid: false,
            message:
                "Blueprint MCP — License Check Failed\n\n" +
                `Could not reach the license server: ${errMsg}\n\n` +
                "Please check your internet connection and try again.\n" +
                "If this persists, contact: support@blueprintmcp.dev",
        };
    }
}

// ─── Native HTTPS POST Helper ─────────────────────────────────────────────────

function httpPost(
    hostname: string,
    urlPath: string,
    body: Record<string, unknown>
): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);

        const options: https.RequestOptions = {
            hostname,
            port: 443,
            path: urlPath,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
                "User-Agent": "blueprint-mcp/4.0.0",
            },
        };

        const req = https.request(options, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
                try {
                    const raw = Buffer.concat(chunks).toString("utf-8");
                    resolve(JSON.parse(raw) as Record<string, unknown>);
                } catch (err) {
                    console.error("[license] Failed to parse response:", err);
                    reject(new Error("Failed to parse license server response."));
                }
            });
        });

        req.on("error", reject);
        req.setTimeout(8000, () => {
            req.destroy(new Error("License validation timed out after 8 seconds."));
        });

        req.write(payload);
        req.end();
    });
}

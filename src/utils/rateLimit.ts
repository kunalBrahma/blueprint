import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RateLimitResult {
    allowed: boolean;
    message: string;
}

interface RateLimitStore {
    date: string; // UTC date string: "YYYY-MM-DD"
    counts: Record<string, number>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STORE_DIR = path.join(os.homedir(), ".blueprint-mcp");
const STORE_FILE = path.join(STORE_DIR, "rate-limit.json");

/**
 * Max free calls per tool per rolling calendar day (UTC).
 * Override with MAX_FREE_CALLS_PER_DAY env var for testing.
 */
const MAX_CALLS = parseInt(process.env["MAX_FREE_CALLS_PER_DAY"] ?? "20", 10);

// ─── Store IO ─────────────────────────────────────────────────────────────────

function getTodayUtc(): string {
    return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function readStore(): RateLimitStore {
    try {
        if (!fs.existsSync(STORE_FILE)) {
            return { date: getTodayUtc(), counts: {} };
        }
        const raw = fs.readFileSync(STORE_FILE, "utf-8");
        const parsed = JSON.parse(raw) as RateLimitStore;

        // Reset if it's a new day
        if (parsed.date !== getTodayUtc()) {
            return { date: getTodayUtc(), counts: {} };
        }
        return parsed;
    } catch (err) {
        console.error("[rateLimit] Failed to read rate limit store:", err);
        return { date: getTodayUtc(), counts: {} };
    }
}

function writeStore(store: RateLimitStore): void {
    try {
        if (!fs.existsSync(STORE_DIR)) {
            fs.mkdirSync(STORE_DIR, { recursive: true });
        }
        fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf-8");
    } catch (err) {
        // Best-effort — do not crash the server if the store cannot be written
        console.error("[rateLimit] Failed to write rate limit store:", err);
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check and increment the daily call counter for a specific free tool.
 *
 * @param toolName - The registered MCP tool name (e.g. "scaffold_project")
 * @returns { allowed: true } if within limits, otherwise { allowed: false, message }
 */
export function checkRateLimit(toolName: string): RateLimitResult {
    const store = readStore();
    const current = store.counts[toolName] ?? 0;

    if (current >= MAX_CALLS) {
        return {
            allowed: false,
            message:
                `[Blueprint MCP — Free Tier Limit Reached]\n\n` +
                `You have used all ${MAX_CALLS} free calls for "${toolName}" today.\n` +
                `Your quota resets at midnight UTC.\n\n` +
                `Unlock unlimited calls + all Pro tools with a Blueprint MCP license:\n` +
                `  - Lifetime Deal: $69 (one-time)\n` +
                `  - Monthly: $15/mo\n` +
                `  https://dodopayments.com/buy/blueprint-mcp\n\n` +
                `After purchase, set your key:\n` +
                `  export BLUEPRINT_LICENSE_KEY=your_key_here`,
        };
    }

    // Increment and persist
    store.counts[toolName] = current + 1;
    writeStore(store);

    return { allowed: true, message: "" };
}

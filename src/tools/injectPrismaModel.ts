import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { z } from "zod";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { withMutationReport } from "../utils/mutationTracker.js";

// ─── 1. Zod Schema ────────────────────────────────────────────────────────────

const PRISMA_SCALAR_TYPES = [
    "String",
    "Int",
    "Float",
    "Boolean",
    "DateTime",
    "Json",
] as const;

const fieldSchema = z.object({
    name: z.string().min(1).describe("Field name in camelCase, e.g. 'userId'"),
    type: z
        .enum(PRISMA_SCALAR_TYPES)
        .describe("Prisma scalar type for this field"),
    isId: z
        .boolean()
        .default(false)
        .describe(
            "Whether this is the primary key. Adds @id and a sensible @default."
        ),
    isOptional: z
        .boolean()
        .default(false)
        .describe("Whether the field is optional (appends ? to the type)"),
    isUnique: z
        .boolean()
        .default(false)
        .describe("Whether the field has a @unique constraint"),
    relation: z
        .string()
        .optional()
        .describe(
            "If set, the name of the referenced model. Adds @relation(fields: [<name>], references: [id])."
        ),
});

const injectPrismaModelSchema = z.object({
    schemaPath: z
        .string()
        .describe("Absolute path to the target schema.prisma file"),
    modelName: z
        .string()
        .regex(
            /^[A-Z][a-zA-Z0-9]*$/,
            "modelName must be PascalCase (e.g. 'User', 'BlogPost')"
        )
        .describe("PascalCase name for the new Prisma model"),
    fields: z
        .array(fieldSchema)
        .min(1)
        .describe("Array of field definitions for the model"),
    dryRun: z
        .boolean()
        .default(false)
        .describe(
            "If true, returns the proposed model block as text WITHOUT writing to disk"
        ),
});

type InjectPrismaModelParams = typeof injectPrismaModelSchema;

// ─── 2. Formatting Helpers ────────────────────────────────────────────────────

type FieldDef = z.infer<typeof fieldSchema>;

/**
 * Pad a string to a minimum width using trailing spaces.
 */
function pad(str: string, width: number): string {
    return str.length >= width ? str : str + " ".repeat(width - str.length);
}

/**
 * Build the @default(...) attribute for an @id field based on its scalar type.
 */
function idDefault(type: (typeof PRISMA_SCALAR_TYPES)[number]): string {
    switch (type) {
        case "Int":
            return "@default(autoincrement())";
        case "String":
            return "@default(cuid())";
        default:
            return "@default(autoincrement())";
    }
}

/**
 * Format an array of field definitions into aligned Prisma model block lines.
 */
function formatFields(fields: FieldDef[]): string[] {
    const rows = fields.map((f) => {
        const nameCol = f.name;
        const typeStr = f.isOptional ? `${f.type}?` : f.type;

        const attributes: string[] = [];
        if (f.isId) {
            attributes.push("@id", idDefault(f.type));
        }
        if (f.isUnique && !f.isId) {
            attributes.push("@unique");
        }
        if (f.relation) {
            const fkField = `${f.name}Id`;
            attributes.push(`@relation(fields: [${fkField}], references: [id])`);
        }

        return { nameCol, typeStr, attrStr: attributes.join(" ") };
    });

    const maxName = Math.max(...rows.map((r) => r.nameCol.length));
    const maxType = Math.max(...rows.map((r) => r.typeStr.length));

    const nameWidth = maxName + 2;
    const typeWidth = maxType + 2;

    return rows.map(({ nameCol, typeStr, attrStr }) => {
        const nameP = pad(nameCol, nameWidth);
        const typeP = attrStr ? pad(typeStr, typeWidth) : typeStr;
        return `  ${nameP}${typeP}${attrStr}`.trimEnd();
    });
}

/**
 * Build the entire Prisma model block string.
 */
function buildModelBlock(modelName: string, fields: FieldDef[]): string {
    const fieldLines = formatFields(fields);
    return [`model ${modelName} {`, ...fieldLines, "}"].join("\n");
}

function toCamelCase(input: string): string {
    return input.replace(/[_-](.)/g, (_m, g1) => g1.toUpperCase());
}

function lowerFirst(str: string): string {
    return str.charAt(0).toLowerCase() + str.slice(1);
}

function toPlural(word: string): string {
    if (word.endsWith("s") || word.endsWith("x") || word.endsWith("z")) return word + "es";
    if (word.endsWith("y") && !/[aeiou]y$/i.test(word)) return word.slice(0, -1) + "ies";
    return word + "s";
}

// ─── 3. Tool Definition ───────────────────────────────────────────────────────

export const injectPrismaModel: Tool<
    FastMCPSessionAuth,
    InjectPrismaModelParams
> = {
    name: "inject_prisma_model",
    description:
        "Reads a schema.prisma file and appends a new, perfectly column-aligned model block. " +
        "Guards against duplicate model names. Supports dry-run mode.",
    parameters: injectPrismaModelSchema,

    execute: async (args) => {
        const { schemaPath, modelName, fields, dryRun } = args;
        const resolvedPath = path.resolve(schemaPath);
        const projectRoot = path.dirname(path.dirname(resolvedPath));

        return withMutationReport("inject_prisma_model", dryRun ? null : projectRoot, async (report) => {
            // ── Validate schemaPath ────────────────────────────────────────────────
            if (!fs.existsSync(resolvedPath)) {
                throw new Error(`File not found: "${resolvedPath}"`);
            }

            if (path.extname(resolvedPath) !== ".prisma") {
                throw new Error(`Expected a .prisma file, got: "${path.extname(resolvedPath)}"`);
            }

            // ── Read current schema ────────────────────────────────────────────────
            let currentContent: string;
            try {
                currentContent = fs.readFileSync(resolvedPath, "utf-8");
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                throw new Error(`Error reading file: ${msg}`);
            }

            // ── Duplicate model guard ──────────────────────────────────────────────
            const duplicatePattern = new RegExp(
                `^\\s*model\\s+${modelName}\\s*\\{`,
                "m"
            );
            if (duplicatePattern.test(currentContent)) {
                throw new Error(
                    `Duplicate model detected: A model named "${modelName}" already exists in "${resolvedPath}". ` +
                    `Remove or rename it before injecting a new one.`
                );
            }

            // ── Normalize fields ───────────────────────────────────────────────────
            const normalizedFields: FieldDef[] = fields.map((f) => {
                let name = toCamelCase(f.name);
                name = name.replace(/IdId$/i, "Id");
                name = name.charAt(0).toLowerCase() + name.slice(1);

                let relation = f.relation;
                if (!relation && /Id$/i.test(name)) {
                    const base = name.slice(0, -2);
                    relation = base.charAt(0).toUpperCase() + base.slice(1);
                }

                return { ...f, name, relation } as FieldDef;
            });

            // ── Build model block ──────────────────────────────────────────────────
            const modelBlock = buildModelBlock(modelName, normalizedFields);

            // ── Prepare warnings array ───────────────────────────────────────────────
            const warnings: string[] = [];

            // ── Dry run ────────────────────────────────────────────────────────────
            if (dryRun) {
                const sepSchema = currentContent.trimEnd() + "\n\n" + modelBlock + "\n";
                let simSchema = sepSchema;
                for (const f of normalizedFields) {
                    if (!f.relation) continue;
                    const parentModel = f.relation;
                    const modelRegex = new RegExp(`model\\s+${parentModel}\\s+\\{([\\s\\S]*?)\\n\\}`, "m");
                    const match = simSchema.match(modelRegex);
                    if (!match) {
                        warnings.push(`[WARNING] Referenced model '${parentModel}' not found in schema.prisma. Skipping inverse relation injection.`);
                        continue;
                    }

                    const parentBlock = match[0];
                    const inverseBase = lowerFirst(modelName);
                    let inverseName = toPlural(inverseBase);
                    const fieldExists = new RegExp(`^\\s*${inverseName}\\s`, "m").test(parentBlock);
                    if (fieldExists) {
                        const alt = `${inverseName}_injected`;
                        warnings.push(`[WARNING] Field name collision on parent model '${parentModel}': '${inverseName}' already exists. Using '${alt}' instead.`);
                    }
                }

                const separator = "─".repeat(60);
                const warningText = warnings.length ? `\nWARNINGS:\n${warnings.join("\n")}\n\n` : "";
                report.humanMessage =
                    `[INFO] DRY RUN — No file was written.\n` +
                    `Schema: ${resolvedPath}\n` +
                    `Model:  ${modelName} (${fields.length} field${fields.length === 1 ? "" : "s"})\n` +
                    `${warningText}\n` +
                    `${separator}\n` +
                    `PROPOSED MODEL BLOCK:\n` +
                    `${separator}\n` +
                    modelBlock +
                    `\n${separator}`;
                return;
            }

            // ── Append to schema file and inject inverse relations ──────────────────
            const trimmed = currentContent.trimEnd();
            const backup = currentContent;

            let newContent = `${trimmed}\n\n${modelBlock}\n`;

            let modifiedSchema = newContent;

            for (const f of normalizedFields) {
                if (!f.relation) continue;
                const parentModel = f.relation;
                const modelRegex = new RegExp(`model\\s+${parentModel}\\s+\\{([\\s\\S]*?)\\n\\}`, "m");
                const match = modifiedSchema.match(modelRegex);
                if (!match) {
                    warnings.push(`[WARNING] Referenced model '${parentModel}' not found in schema.prisma. Skipping inverse relation injection.`);
                    continue;
                }

                const parentBlock = match[0];
                const inverseBase = lowerFirst(modelName);
                let inverseName = toPlural(inverseBase);

                const fieldExists = new RegExp(`^\\s*${inverseName}\\s`, "m").test(parentBlock);
                if (fieldExists) {
                    const alt = `${inverseName}_injected`;
                    warnings.push(`[WARNING] Field name collision on parent model '${parentModel}': '${inverseName}' already exists. Using '${alt}' instead.`);
                    inverseName = alt;
                }

                const inverseLine = `  ${inverseName} ${modelName}[]`;
                const newParentBlock = parentBlock.replace(/\n\}$/, `\n${inverseLine}\n}`);
                modifiedSchema = modifiedSchema.replace(parentBlock, newParentBlock);
            }

            try {
                fs.writeFileSync(resolvedPath, modifiedSchema, "utf-8");
                report.mutatedFiles.push(resolvedPath);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                throw new Error(`Error writing file: ${msg}`);
            }

            let prismaWarning = "";
            try {
                execSync("npx prisma generate", { stdio: "inherit", cwd: projectRoot });
            } catch (err) {
                // Atomic rollback
                try {
                    fs.writeFileSync(resolvedPath, backup, "utf-8");
                } catch (_rollbackErr) {
                    throw new Error("Failed to run 'npx prisma generate' and rollback failed. Manual intervention required.");
                }
                prismaWarning = "\n[ERROR] Prisma generate failed; schema.prisma reverted to previous state.";
                throw new Error(`Prisma generate failed; schema.prisma was reverted.\n${String(err)}`);
            }

            const fieldSummary = normalizedFields
                .map((f) => {
                    const parts = [`${f.name}: ${f.type}${f.isOptional ? "?" : ""}`];
                    if (f.isId) parts.push("@id");
                    if (f.isUnique) parts.push("@unique");
                    if (f.relation) parts.push(`@relation(→ ${f.relation})`);
                    return `  • ${parts.join(" ")}`;
                })
                .join("\n");

            const warningsText = warnings.length ? `\n${warnings.join("\n")}` : "";

            report.humanMessage =
                `[SUCCESS] Model "${modelName}" successfully appended to:\n` +
                `   ${resolvedPath}\n\n` +
                `Fields injected:\n${fieldSummary}\n\n` +
                `Generated block:\n${"─".repeat(40)}\n${modelBlock}\n${"─".repeat(40)}` +
                warningsText +
                prismaWarning;
        });
    },
};

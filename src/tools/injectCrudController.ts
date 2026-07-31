import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { Project } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { withMutationReport } from "../utils/mutationTracker.js";
import { enforcePathJail } from "../utils/pathJail.js";
import { WORKSPACE_ROOT } from "../utils/workspace.js";

const injectCrudSchema = z.object({
  modelName: z.string().regex(/^[A-Z][a-zA-Z0-9]*$/, "modelName must be PascalCase"),
  targetDirectory: z.string().describe("Absolute path to the controllers folder"),
  dryRun: z.boolean().default(false),
});

type InjectCrudParams = typeof injectCrudSchema;

function toCamel(pascal: string): string {
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function toPlural(word: string): string {
  if (word.endsWith("s") || word.endsWith("x") || word.endsWith("z")) return word + "es";
  if (word.endsWith("y") && !/[aeiou]y$/i.test(word)) return word.slice(0, -1) + "ies";
  return word + "s";
}

interface ModelField {
  name: string;
  type: string;
  isOptional: boolean;
}

function getModelFields(targetDir: string, modelName: string): { hasCreatedAt: boolean, hasUpdatedAt: boolean, fields: ModelField[] } {
  const schemaPath = path.resolve(targetDir, "../../prisma/schema.prisma");
  let hasCreatedAt = false;
  let hasUpdatedAt = false;
  const fields: ModelField[] = [];

  if (fs.existsSync(schemaPath)) {
    const content = fs.readFileSync(schemaPath, "utf-8");
    const modelRegex = new RegExp(`model\\s+${modelName}\\s+\\{([^}]+)\\}`, "m");
    const match = content.match(modelRegex);
    if (match && match[1]) {
      const block = match[1];
      const lines = block.split("\n");
      const scalarTypes = ["String", "Int", "Float", "Boolean", "DateTime", "Json", "Decimal", "BigInt", "Bytes"];

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && !line.includes("@@") && !line.includes("//")) {
          const name = parts[0];
          let type = parts[1] as string;
          if (!name || name === "") continue;
          if (name === "createdAt") { hasCreatedAt = true; continue; }
          if (name === "updatedAt") { hasUpdatedAt = true; continue; }
          if (name === "id") continue;

          const isOptional = type.endsWith("?") || line.includes("@default");
          const cleanType = type.replace("?", "").replace("[]", "");

          const isRelation = !scalarTypes.includes(cleanType);
          if (isRelation) continue;

          fields.push({
            name,
            type: cleanType,
            isOptional
          });
        }
      }
    }
  }
  return { hasCreatedAt, hasUpdatedAt, fields };
}

function generateZodSchema(fields: ModelField[], modelName: string, storageField?: string) {
  let createSchema = `export const Create${modelName}Schema = z.object({\n`;
  let updateSchema = `export const Update${modelName}Schema = z.object({\n`;

  fields.forEach(f => {
    let zodType = "z.string()";
    if (f.type === "Int" || f.type === "Float") zodType = "z.number()";
    else if (f.type === "Decimal") zodType = "z.coerce.number()";
    else if (f.type === "Boolean") zodType = "z.boolean()";
    else if (f.type === "DateTime") zodType = "z.coerce.date()";
    else if (f.type === "Json") zodType = "z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.any()), z.record(z.any())])";
    else if (f.type === "BigInt") zodType = "z.coerce.bigint()";
    else if (f.type === "Bytes") zodType = "z.union([z.instanceof(Buffer), z.instanceof(Uint8Array)])";

    updateSchema += `  ${f.name}: ${zodType}.optional(),\n`;

    // storageField (e.g. imageUrl) is populated from req.file, not the JSON
    // body, so it must be optional on create even if Prisma requires it.
    if (f.isOptional || f.name === storageField) {
      createSchema += `  ${f.name}: ${zodType}.optional(),\n`;
    } else {
      createSchema += `  ${f.name}: ${zodType},\n`;
    }
  });

  createSchema += `});\n`;
  updateSchema += `});\n`;

  return { createSchema, updateSchema };
}

function buildCrudController(modelName: string, hasStorage: boolean, targetDir: string): string {
  const { hasCreatedAt, hasUpdatedAt, fields } = getModelFields(targetDir, modelName);
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile("controller.ts", "", { overwrite: true });

  const model = toCamel(modelName);
  const plural = toPlural(model);
  const pluralPascal = toPlural(modelName);

  sourceFile.addImportDeclaration({
    namedImports: ["Request", "Response"],
    moduleSpecifier: "express",
  });
  sourceFile.addImportDeclaration({
    namedImports: ["Prisma"],
    moduleSpecifier: "@prisma/client",
    isTypeOnly: true,
  });
  sourceFile.addImportDeclaration({
    defaultImport: "prisma",
    moduleSpecifier: "../config/prisma",
  });
  sourceFile.addImportDeclaration({
    namedImports: ["z"],
    moduleSpecifier: "zod",
  });

  const hasImageField = fields.some(f => f.name === "imageUrl");
  const useStorage = hasStorage && hasImageField;

  if (useStorage) {
    sourceFile.addImportDeclaration({
      namedImports: ["storageService"],
      moduleSpecifier: "../services/storage.service",
    });
  }

  const { createSchema, updateSchema } = generateZodSchema(fields, modelName, useStorage ? "imageUrl" : undefined);
  sourceFile.addStatements(`\n${createSchema}\n${updateSchema}\n`);

  sourceFile.addStatements(`
function buildOrderBy(field: string, order: string): Record<string, "asc" | "desc"> {
  const direction = order === "desc" ? "desc" : "asc";
  return { [field]: direction };
}
`);

  const addFn = (name: string, body: string) => {
    sourceFile.addStatements("\n");
    sourceFile.addFunction({
      isExported: true,
      isAsync: true,
      name,
      parameters: [
        { name: "req", type: "Request" },
        { name: "res", type: "Response" },
      ],
      returnType: "Promise<void>",
      statements: body.trim(),
    });
  };

  // ── 1. create<Model> ───────────────────────────────────────────────────────
  let createBody = `
    const parsed = Create${modelName}Schema.parse(req.body);
    const data = parsed;
`;
  if (useStorage) {
    createBody += `
    if (req.file) {
      data.imageUrl = await storageService.uploadFile(req.file);
    }
`;
  }
  createBody += `
    const ${model} = await prisma.${model}.create({ data: parsed });
    res.status(201).json({ success: true, data: ${model} });
`;
  addFn(`create${modelName}`, `
  try {
${createBody}
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      const formatted = error.flatten();
      res.status(400).json({ success: false, errors: formatted.fieldErrors });
      return;
    }
    if (error instanceof Error) {
      res.status(500).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: "Internal server error" });
  }
`);

  // ── 2. getAll<Model>s (Advanced Query) ──────────────────────────────────────────────────────
  const stringFields = fields.filter(f => f.type === "String" && f.name !== "id" && !f.name.endsWith("Id"));
  const defaultSort = hasCreatedAt ? "createdAt" : "id";

  let searchClause = "";
  if (stringFields.length > 0) {
    const orConditions = stringFields.map(f => `{ ${f.name}: { contains: search as string, mode: "insensitive" } }`).join(",\n        ");
    searchClause = `
    if (search) {
      where.OR = [
        ${orConditions}
      ];
    }`;
  }

  const validSortFields = ["id", ...fields.map(f => f.name)];
  if (hasCreatedAt) validSortFields.push("createdAt");
  if (hasUpdatedAt) validSortFields.push("updatedAt");
  const validSortArray = JSON.stringify(validSortFields);

  const filterableFields = fields
    .map(f => f.name)
    .filter(name => name !== "id" && name !== "createdAt" && name !== "updatedAt" && !name.endsWith("Id"));
  const filterableArray = JSON.stringify(filterableFields);

  addFn(`getAll${pluralPascal}`, `
  try {
    const { page = "1", limit = "10", search, sortBy = "${defaultSort}", sortOrder = "desc", ...filters } = req.query;
    const pageNumber = parseInt(page as string, 10);
    const limitNumber = parseInt(limit as string, 10);
    const skip = (pageNumber - 1) * limitNumber;

    const validSortFields = ${validSortArray};
    const filterableFields = ${filterableArray};
    if (!validSortFields.includes(sortBy as string)) {
      res.status(400).json({ success: false, message: \`Invalid sortBy field. Allowed fields: \${validSortFields.join(", ")}\` });
      return;
    }

    const where: Prisma.${modelName}WhereInput = {};
    for (const key in filters) {
      if (filterableFields.includes(key)) {
        let value: any = filters[key];
        
        if (value === "true") value = true;
        if (value === "false") value = false;

        (where as Record<string, unknown>)[key] = value;
      }
    }
${searchClause}

    const [${plural}, total] = await Promise.all([
      prisma.${model}.findMany({
        where,
        skip,
        take: limitNumber,
        orderBy: buildOrderBy(sortBy as string, sortOrder as string),
      }),
      prisma.${model}.count({ where })
    ]);

    res.status(200).json({ 
      success: true, 
      count: ${plural}.length,
      total,
      page: pageNumber,
      totalPages: Math.ceil(total / limitNumber),
      data: ${plural} 
    });
  } catch (error: unknown) {
    if (error instanceof Error) {
      res.status(500).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: "Internal server error" });
  }
`);

  // ── 3. get<Model>ById ─────────────────────────────────────────────────────
  addFn(`get${modelName}ById`, `
  try {
    const { id } = req.params;
    const ${model} = await prisma.${model}.findUnique({ where: { id } });
    if (!${model}) {
      res.status(404).json({ success: false, message: "${modelName} not found" });
      return;
    }
    res.status(200).json({ success: true, data: ${model} });
  } catch (error: unknown) {
    if (error instanceof Error) {
      res.status(500).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: "Internal server error" });
  }
`);

  // ── 4. update<Model> ──────────────────────────────────────────────────────
  let updateBody = `
    const { id } = req.params;
    const parsed = Update${modelName}Schema.parse(req.body);

    const existing = await prisma.${model}.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ success: false, message: "${modelName} not found" });
      return;
    }
`;
  if (useStorage) {
    updateBody += `
    if (req.file) {
      parsed.imageUrl = await storageService.uploadFile(req.file);
    }
`;
  }
  updateBody += `
    const updated = await prisma.${model}.update({ where: { id }, data: parsed });
    res.status(200).json({ success: true, data: updated });
`;

  addFn(`update${modelName}`, `
  try {
${updateBody}
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      const formatted = error.flatten();
      res.status(400).json({ success: false, errors: formatted.fieldErrors });
      return;
    }
    if (error instanceof Error) {
      res.status(500).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: "Internal server error" });
  }
`);

  // ── 5. delete<Model> ──────────────────────────────────────────────────────
  addFn(`delete${modelName}`, `
  try {
    const { id } = req.params;
    const existing = await prisma.${model}.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ success: false, message: "${modelName} not found" });
      return;
    }
    await prisma.${model}.delete({ where: { id } });
    res.status(200).json({ success: true, message: "${modelName} deleted successfully" });
  } catch (error: unknown) {
    if (error instanceof Error) {
      res.status(500).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: "Internal server error" });
  }
`);

  sourceFile.fixUnusedIdentifiers();
  sourceFile.organizeImports();
  
  const generated = sourceFile.getFullText();
  const anyMatches = generated.match(/\bas\s+any\b/g);
  if (anyMatches && anyMatches.length > 0) {
    throw new Error(
      `[Quality Gate] Generated file contains ` +
      `${anyMatches.length} "as any" cast(s). ` +
      `This is a generator bug — fix the template before ` +
      `writing to disk.\n\n` +
      `Offending content preview:\n` +
      generated
        .split("\n")
        .filter(l => /\bas\s+any\b/.test(l))
        .map(l => `  ${l.trim()}`)
        .join("\n")
    );
  }
  return generated;
}

export const injectCrudController: Tool<FastMCPSessionAuth, InjectCrudParams> = {
  name: "inject_crud_controller",
  description:
    "Generates a complete, production-grade Express CRUD controller for a given Prisma model. " +
    "Upgraded with Advanced Query support (Pagination, Search) and Storage Awareness (Multer req.file handling).",
  parameters: injectCrudSchema,

  execute: async (args) => {
    const { modelName, targetDirectory, dryRun } = args;
    const resolvedDir = path.resolve(targetDirectory);
    const projectRoot = path.resolve(resolvedDir, "../..");

    return withMutationReport("inject_crud_controller", dryRun ? null : projectRoot, async (report) => {
      report.skipValidation = true;
      const safeDir = enforcePathJail(WORKSPACE_ROOT, resolvedDir);
      if (!fs.existsSync(safeDir)) throw new Error(`Directory not found: "${safeDir}"`);

      const fileName = `${toCamel(modelName)}.controller.ts`;
      const outputPath = path.join(safeDir, fileName);

      if (fs.existsSync(outputPath)) {
        throw new Error(`File already exists: "${outputPath}".`);
      }

      const hasStorage = fs.existsSync(path.join(safeDir, "../middleware/upload.ts"));

      const content = buildCrudController(modelName, hasStorage, safeDir);

      if (dryRun) {
        const sep = "─".repeat(60);
        report.humanMessage = `[INFO] DRY RUN\n${sep}\n${content}\n${sep}`;
        return;
      }

      report.snapshotFiles([outputPath]);

      fs.writeFileSync(outputPath, content, "utf-8");
      report.mutatedFiles.push(outputPath);

      const msg = hasStorage ? "\n[INFO] Storage middleware detected! Added req.file logic." : "";
      report.humanMessage = `[SUCCESS] CRUD controller generated successfully!\nFile: ${outputPath}${msg}`;
    });
  },
};
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { Project } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { withMutationReport } from "../utils/mutationTracker.js";

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

function getModelFields(targetDir: string, modelName: string) {
  const schemaPath = path.resolve(targetDir, "../../prisma/schema.prisma");
  let hasCreatedAt = false;
  let hasUpdatedAt = false;
  const fields: { name: string, type: string, isOptional: boolean }[] = [];

  if (fs.existsSync(schemaPath)) {
    const content = fs.readFileSync(schemaPath, "utf-8");
    const modelRegex = new RegExp(`model\\s+${modelName}\\s+\\{([^}]+)\\}`, "m");
    const match = content.match(modelRegex);
    if (match && match[1]) {
      const block = match[1];
      const lines = block.split("\\n");
      for (const line of lines) {
        const parts = line.trim().split(/\\s+/);
        if (parts.length >= 2 && !line.includes("@@") && !line.includes("//")) {
          const name = parts[0];
          let type = parts[1];
          if (!name) continue;
          if (name === "createdAt") hasCreatedAt = true;
          if (name === "updatedAt") hasUpdatedAt = true;

          fields.push({
            name,
            type: type?.replace("?", "") ?? "String",
            isOptional: type?.endsWith("?") ?? false
          });
        }
      }
    }
  }
  return { hasCreatedAt, hasUpdatedAt, fields };
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
    defaultImport: "prisma",
    moduleSpecifier: "../config/prisma",
  });

  if (hasStorage) {
    sourceFile.addImportDeclaration({
      namedImports: ["storageService"],
      moduleSpecifier: "../services/storage.service",
    });
  }

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
    const data: any = { ...req.body };
`;
  fields.forEach(f => {
    if (!f.isOptional && f.name !== "id" && f.name !== "createdAt" && f.name !== "updatedAt" && f.type === "String") {
      if (f.name !== "imageUrl" && f.name !== "thumbnailPath" && !f.name.endsWith("Id")) {
        createBody += `    data.${f.name} = data.${f.name} || "Default";\n`;
      }
    }
  });
  if (hasStorage) {
    createBody += `
    if (req.file) {
      data.imageUrl = await storageService.uploadFile(req.file);
    }
`;
  }
  createBody += `
    const ${model} = await prisma.${model}.create({ data });
    res.status(201).json({ success: true, data: ${model} });
`;
  addFn(`create${modelName}`, `
  try {
${createBody}
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    res.status(400).json({ success: false, message });
  }
`);

  // ── 2. getAll<Model>s (Advanced Query) ──────────────────────────────────────────────────────
  const defaultSort = hasCreatedAt ? "createdAt" : "id";
  const selectLines = fields.map(f => `        ${f.name}: true,`).join("\\n");
  const selectBlock = fields.length > 0 ? `\n        select: {\n${selectLines}\n        },` : "";

  addFn(`getAll${pluralPascal}`, `
  try {
    const { page = "1", limit = "10", search, sortBy = "${defaultSort}", sortOrder = "desc", ...filters } = req.query;
    const pageNumber = parseInt(page as string, 10);
    const limitNumber = parseInt(limit as string, 10);
    const skip = (pageNumber - 1) * limitNumber;

    const where: any = { ...filters };
    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: "insensitive" } },
        { description: { contains: search as string, mode: "insensitive" } }
      ];
    }

    const [${plural}, total] = await Promise.all([
      prisma.${model}.findMany({
        where,
        skip,
        take: limitNumber,
        orderBy: { [sortBy as string]: sortOrder as string },${selectBlock}
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
    const message = error instanceof Error ? error.message : "Internal server error";
    res.status(500).json({ success: false, message });
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
    const message = error instanceof Error ? error.message : "Internal server error";
    res.status(500).json({ success: false, message });
  }
`);

  // ── 4. update<Model> ──────────────────────────────────────────────────────
  let updateBody = `
    const { id } = req.params;
    const data = { ...req.body };
    const existing = await prisma.${model}.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ success: false, message: "${modelName} not found" });
      return;
    }
`;
  if (hasStorage) {
    updateBody += `
    if (req.file) {
      data.imageUrl = await storageService.uploadFile(req.file);
    }
`;
  }
  updateBody += `
    const updated = await prisma.${model}.update({ where: { id }, data });
    res.status(200).json({ success: true, data: updated });
`;

  addFn(`update${modelName}`, `
  try {
${updateBody}
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    res.status(400).json({ success: false, message });
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
    const message = error instanceof Error ? error.message : "Internal server error";
    res.status(500).json({ success: false, message });
  }
`);

  sourceFile.fixUnusedIdentifiers();
  sourceFile.organizeImports();
  return sourceFile.getFullText();
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
      if (!fs.existsSync(resolvedDir)) throw new Error(`Directory not found: "${resolvedDir}"`);

      const fileName = `${toCamel(modelName)}.controller.ts`;
      const outputPath = path.join(resolvedDir, fileName);

      if (fs.existsSync(outputPath)) {
        throw new Error(`File already exists: "${outputPath}".`);
      }

      const hasStorage = fs.existsSync(path.join(resolvedDir, "../middleware/upload.ts"));

      const content = buildCrudController(modelName, hasStorage, resolvedDir);

      if (dryRun) {
        const sep = "─".repeat(60);
        report.humanMessage = `[INFO] DRY RUN\n${sep}\n${content}\n${sep}`;
        return;
      }

      fs.writeFileSync(outputPath, content, "utf-8");
      report.mutatedFiles.push(outputPath);

      const msg = hasStorage ? "\\n[INFO] Storage middleware detected! Added req.file logic." : "";
      report.humanMessage = `[SUCCESS] CRUD controller generated successfully!\nFile: ${outputPath}${msg}`;
    });
  },
};

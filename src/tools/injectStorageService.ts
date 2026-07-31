import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { z } from "zod";
import { Project } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { withMutationReport } from "../utils/mutationTracker.js";
import { enforcePathJail } from "../utils/pathJail.js";
import { WORKSPACE_ROOT } from "../utils/workspace.js";

// ─── 1. Zod Schema ────────────────────────────────────────────────────────────
const injectStorageSchema = z.object({
  targetSrcDirectory: z
    .string()
    .describe("Absolute path to the src folder of the project"),
  dryRun: z
    .boolean()
    .default(false)
    .describe("If true, returns the proposed file content WITHOUT writing to disk"),
});

type InjectStorageParams = typeof injectStorageSchema;

// ─── 2. Code Generation Templates ──────────────────────────────────────────────

function buildMulterMiddleware(): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile("upload.ts", "", { overwrite: true });

  sourceFile.addStatements(`
import * as multer from "multer";
import { FileFilterCallback } from "multer";
import { Request } from "express";
import * as path from "node:path";

const useMemoryStorage = process.env.STORAGE_TYPE === "s3" || process.env.STORAGE_TYPE === "r2";

const storage = useMemoryStorage
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => {
        // Resolved from process.cwd() (the project root the server is
        // launched from), not __dirname — a __dirname-relative traversal
        // depends on this compiled file sitting at exactly the same
        // directory depth as it does in src/, which isn't guaranteed across
        // different tsconfig outDir/rootDir setups or when running directly
        // via tsx/ts-node instead of a dist/ build.
        cb(null, path.join(process.cwd(), "public/uploads/"));
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + "-" + uniqueSuffix + ext);
      },
    });

const fileFilter = (req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
  const allowedMimeTypes = ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid file type. Only JPG, PNG, GIF, WEBP, and PDF are allowed."));
  }
};

export const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter,
});
`.trimStart());

  sourceFile.fixUnusedIdentifiers();
  sourceFile.organizeImports();
  return sourceFile.getFullText();
}

function buildStorageService(): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile("storage.service.ts", "", { overwrite: true });

  sourceFile.addStatements(`
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import * as fs from "node:fs";
import * as path from "node:path";

export interface IStorageService {
  uploadFile(file: Express.Multer.File): Promise<string>;
  deleteFile(key: string): Promise<boolean>;
}

export class StorageService implements IStorageService {
  private s3Client?: S3Client;
  private bucketName?: string;
  private isCloud: boolean;

  constructor() {
    this.isCloud = process.env.STORAGE_TYPE === "s3" || process.env.STORAGE_TYPE === "r2";
    
    if (this.isCloud) {
      if (!process.env.AWS_REGION || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.AWS_BUCKET_NAME) {
         throw new Error("Missing required AWS/S3 environment variables.");
      }
      this.bucketName = process.env.AWS_BUCKET_NAME;
      this.s3Client = new S3Client({
        region: process.env.AWS_REGION,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
        endpoint: process.env.AWS_ENDPOINT_URL,
        forcePathStyle: !!process.env.AWS_ENDPOINT_URL,
      });
    }
  }

  async uploadFile(file: Express.Multer.File): Promise<string> {
    try {
      if (this.isCloud && this.s3Client && this.bucketName) {
        if (!file.buffer) {
          throw new Error("File buffer is missing. Ensure multer is using memoryStorage for cloud uploads.");
        }
        
        const fileName = \`\${Date.now()}-\${Math.round(Math.random() * 1e9)}-\${file.originalname}\`;
        
        const command = new PutObjectCommand({
          Bucket: this.bucketName,
          Key: fileName,
          Body: file.buffer,
          ContentType: file.mimetype,
        });

        await this.s3Client.send(command);
        
        if (process.env.AWS_ENDPOINT_URL) {
            return \`\${process.env.AWS_ENDPOINT_URL}/\${this.bucketName}/\${fileName}\`;
        }
        return \`https://\${this.bucketName}.s3.\${process.env.AWS_REGION}.amazonaws.com/\${fileName}\`;
      } else {
        if (!file.filename) {
            throw new Error("File name is missing. Ensure multer is using diskStorage for local uploads.");
        }
        return \`/uploads/\${file.filename}\`;
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown upload error";
      throw new Error(\`Failed to upload file: \${msg}\`);
    }
  }

  async deleteFile(key: string): Promise<boolean> {
    try {
      if (this.isCloud && this.s3Client && this.bucketName) {
         const command = new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: key,
         });
         await this.s3Client.send(command);
         return true;
      } else {
         const filename = path.basename(key);
         const filePath = path.join(process.cwd(), "public/uploads/", filename);
         if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return true;
         }
         return false;
      }
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Unknown delete error";
        console.error("Delete file failed:", msg);
        return false;
    }
  }
}

export const storageService = new StorageService();
`.trimStart());

  sourceFile.fixUnusedIdentifiers();
  sourceFile.organizeImports();
  return sourceFile.getFullText();
}

// ─── 3. Tool Definition ───────────────────────────────────────────────────────

export const injectStorageService: Tool<FastMCPSessionAuth, InjectStorageParams> = {
  name: "inject_storage_service",
  description:
    "Injects a universal, project-agnostic storage service and Multer middleware. " +
    "Supports switching between Local (public/uploads) and Cloud (S3/R2/Spaces) via process.env.STORAGE_TYPE. " +
    "Includes Strict TypeScript compliant implementations.",
  parameters: injectStorageSchema,

  execute: async (args) => {
    const { targetSrcDirectory, dryRun } = args;
    const srcDir = path.resolve(targetSrcDirectory);
    const projectRoot = path.resolve(srcDir, "..");

    return withMutationReport("inject_storage_service", dryRun ? null : projectRoot, async (report) => {
      const safeSrcDir = enforcePathJail(WORKSPACE_ROOT, path.resolve(targetSrcDirectory));
      if (!fs.existsSync(safeSrcDir)) {
        throw new Error(`Directory not found: "${safeSrcDir}"`);
      }

      const servicesDir = path.join(safeSrcDir, "services");
      const middlewareDir = path.join(safeSrcDir, "middleware");
      const publicUploadsDir = path.resolve(safeSrcDir, "../public/uploads");

      const storageServicePath = path.join(servicesDir, "storage.service.ts");
      const multerMiddlewarePath = path.join(middlewareDir, "upload.ts");

      if (fs.existsSync(storageServicePath)) {
        throw new Error(`Guard: File already exists: "${storageServicePath}". Refusing to overwrite.`);
      }
      if (fs.existsSync(multerMiddlewarePath)) {
        throw new Error(`Guard: File already exists: "${multerMiddlewarePath}". Refusing to overwrite.`);
      }

      const storageCode = buildStorageService();
      const multerCode = buildMulterMiddleware();

      if (dryRun) {
        const sep = "─".repeat(60);
        report.humanMessage =
          `[INFO] DRY RUN — No files were written.\n\n` +
          `${sep}\nPROPOSED FILE: src/services/storage.service.ts\n${sep}\n` +
          storageCode +
          `\n${sep}\nPROPOSED FILE: src/middleware/upload.ts\n${sep}\n` +
          multerCode +
          `\n${sep}`;
        return;
      }

      if (!fs.existsSync(servicesDir)) fs.mkdirSync(servicesDir, { recursive: true });
      if (!fs.existsSync(middlewareDir)) fs.mkdirSync(middlewareDir, { recursive: true });
      if (!fs.existsSync(publicUploadsDir)) fs.mkdirSync(publicUploadsDir, { recursive: true });

      report.snapshotFiles([storageServicePath, multerMiddlewarePath]);


      fs.writeFileSync(storageServicePath, storageCode, "utf-8");
      report.mutatedFiles.push(storageServicePath);
      fs.writeFileSync(multerMiddlewarePath, multerCode, "utf-8");
      report.mutatedFiles.push(multerMiddlewarePath);

      let packageWarnings = `\n\n[INFO] Packages automatically installed:\n  multer @aws-sdk/client-s3`;
      try {
        const cwd = projectRoot;
        if (fs.existsSync(path.join(cwd, "package.json"))) {
          const pkgs = ["multer", "@aws-sdk/client-s3"];
          const devPkgs = ["@types/multer", "@types/express"];
          const pkgJsonPath = path.join(cwd, "package.json");
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
          const allDeps = { ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) };
          const need = pkgs.filter(p => !allDeps[p]);
          const needDev = devPkgs.filter(p => !allDeps[p]);
          if (need.length > 0) {
            execSync(`npm install ${need.join(" ")} --save-exact`, { cwd, stdio: "pipe", timeout: 30000 });
          }
          if (needDev.length > 0) {
            execSync(`npm install -D ${needDev.join(" ")} --save-exact`, { cwd, stdio: "pipe", timeout: 30000 });
          }
        }
      } catch (err: unknown) {
        packageWarnings = `\n\n[WARNING] Failed to auto-install packages. Please manually run:\n  npm install multer @aws-sdk/client-s3\n  npm install -D @types/multer @types/express`;
        report.status = "PARTIAL_FAILURE";
      }

      report.humanMessage =
        `[SUCCESS] Storage Service and Middleware injected successfully!\n\n` +
        `Generated Files:\n` +
        `  - ${storageServicePath}\n` +
        `  - ${multerMiddlewarePath}` +
        packageWarnings;
    });
  },
};

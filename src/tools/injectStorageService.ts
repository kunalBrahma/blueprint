import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { Project } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";

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
import multer, { FileFilterCallback } from "multer";
import { Request } from "express";
import * as path from "node:path";

// Define storage location based on environment (local vs cloud).
// For Multer, we either use memory storage (for S3) or disk storage (for local).
const useMemoryStorage = process.env.STORAGE_TYPE === "s3" || process.env.STORAGE_TYPE === "r2";

const storage = useMemoryStorage
  ? multer.memoryStorage() // Keep file in memory for streaming to S3
  : multer.diskStorage({
      destination: (req, file, cb) => {
        cb(null, path.join(__dirname, "../../public/uploads/"));
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + "-" + uniqueSuffix + ext);
      },
    });

// File filter for Images and PDFs
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
    fileSize: 5 * 1024 * 1024, // 5MB limit
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
        endpoint: process.env.AWS_ENDPOINT_URL, // Optional: for R2 or DigitalOcean
        forcePathStyle: !!process.env.AWS_ENDPOINT_URL, // Usually required for non-AWS S3-compatible APIs
      });
    }
  }

  /**
   * Universal upload method.
   * If using Multer memory storage (Cloud), it uploads the buffer to S3.
   * If using Multer disk storage (Local), the file is already saved, it just returns the local path/URL.
   */
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
          // ACL: "public-read", // Uncomment if your bucket allows ACLs and you want public objects
        });

        await this.s3Client.send(command);
        
        // Construct the URL. For AWS, it usually looks like this, but might differ for R2/Spaces.
        // You might want to use a custom domain or CloudFront URL here.
        if (process.env.AWS_ENDPOINT_URL) {
            // R2 / custom endpoint format
            return \`\${process.env.AWS_ENDPOINT_URL}/\${this.bucketName}/\${fileName}\`;
        }
        return \`https://\${this.bucketName}.s3.\${process.env.AWS_REGION}.amazonaws.com/\${fileName}\`;
      } else {
        // Local strategy: File is already saved by Multer diskStorage
        if (!file.filename) {
            throw new Error("File name is missing. Ensure multer is using diskStorage for local uploads.");
        }
        // Return a relative URL or path
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
         // Assuming 'key' might be a full URL if stored in DB, you might need to extract just the filename/key.
         // This assumes 'key' passed in is just the object key.
         const command = new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: key,
         });
         await this.s3Client.send(command);
         return true;
      } else {
         // Local delete
         // Assuming 'key' is the relative URL like '/uploads/file.png'
         const filename = path.basename(key);
         const filePath = path.join(__dirname, "../../public/uploads/", filename);
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

// Export a singleton instance
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

    if (!fs.existsSync(srcDir)) {
      return `[ERROR] Error: Source directory not found: "${srcDir}"`;
    }

    const servicesDir = path.join(srcDir, "services");
    const middlewareDir = path.join(srcDir, "middleware");

    // We also need public/uploads for local storage base structure
    const publicUploadsDir = path.join(srcDir, "../public/uploads");

    const storageServicePath = path.join(servicesDir, "storage.service.ts");
    const multerMiddlewarePath = path.join(middlewareDir, "upload.ts");

    // Guard against overwriting
    if (fs.existsSync(storageServicePath)) {
      return `[ERROR] Guard: File already exists: "${storageServicePath}". Refusing to overwrite.`;
    }
    if (fs.existsSync(multerMiddlewarePath)) {
      return `[ERROR] Guard: File already exists: "${multerMiddlewarePath}". Refusing to overwrite.`;
    }

    const storageCode = buildStorageService();
    const multerCode = buildMulterMiddleware();

    if (dryRun) {
      const sep = "─".repeat(60);
      return (
        `[INFO] DRY RUN — No files were written.\n\n` +
        `${sep}\nPROPOSED FILE: src/services/storage.service.ts\n${sep}\n` +
        storageCode +
        `\n${sep}\nPROPOSED FILE: src/middleware/upload.ts\n${sep}\n` +
        multerCode +
        `\n${sep}`
      );
    }

    // Write to disk
    try {
      if (!fs.existsSync(servicesDir)) fs.mkdirSync(servicesDir, { recursive: true });
      if (!fs.existsSync(middlewareDir)) fs.mkdirSync(middlewareDir, { recursive: true });
      if (!fs.existsSync(publicUploadsDir)) fs.mkdirSync(publicUploadsDir, { recursive: true });

      fs.writeFileSync(storageServicePath, storageCode, "utf-8");
      fs.writeFileSync(multerMiddlewarePath, multerCode, "utf-8");
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return `[ERROR] Error writing files: ${msg}`;
    }

    let packageWarnings = `\n\n[INFO] Packages automatically installed:\n  multer @aws-sdk/client-s3`;
    try {
      const execSync = require("node:child_process").execSync;
      const cwd = path.resolve(srcDir, "..");
        if (fs.existsSync(path.join(cwd, "package.json"))) {
          const pkgs = ["multer", "@aws-sdk/client-s3"];
          const devPkgs = ["@types/multer", "@types/express"];
          const pkgJsonPath = path.join(cwd, "package.json");
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
          const allDeps = { ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) };
          const need = pkgs.filter(p => !allDeps[p]);
          const needDev = devPkgs.filter(p => !allDeps[p]);
          if (need.length > 0) {
            const installCmd = `npm install ${need.join(" ")} --no-save --save-exact`;
            execSync(installCmd, { cwd, stdio: "inherit" });
          }
          if (needDev.length > 0) {
            const installCmd = `npm install -D ${needDev.join(" ")} --no-save --save-exact`;
            execSync(installCmd, { cwd, stdio: "inherit" });
          }
      }
    } catch (err: unknown) {
      packageWarnings = `\n\n[WARNING] Failed to auto-install packages. Please manually run:\n  npm install multer @aws-sdk/client-s3\n  npm install -D @types/multer @types/express`;
    }
    const prismaWarnings = `\n\n[WARNING] Prisma Model Integration:\n  Consider adding a field to your models to store the file URL/Key.\n  e.g., \`avatarUrl String?\` or \`documentUrl String\``;
    const localTestWarning = `\n\n[INFO] Remember to expose your public folder in Express for local uploads:\n  app.use("/uploads", express.static(path.join(__dirname, "../public/uploads")));`;

    return (
      `[SUCCESS] Storage Service and Middleware injected successfully!\n\n` +
      `Generated Files:\n` +
      `  • ${storageServicePath}\n` +
      `  • ${multerMiddlewarePath}` +
      packageWarnings +
      prismaWarnings +
      localTestWarning
    );
  },
};

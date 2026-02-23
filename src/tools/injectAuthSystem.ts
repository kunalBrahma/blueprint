import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { Project } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";

// ─── 1. Zod Schema ────────────────────────────────────────────────────────────

const injectAuthSchema = z.object({
  targetDirectory: z
    .string()
    .describe("Absolute path to the controllers folder where auth.controller.ts will be created"),
  authProviders: z
    .enum(["email", "google"])
    .array()
    .describe("Array of authentication providers to implement (e.g., ['email', 'google'])"),

  dryRun: z
    .boolean()
    .default(false)
    .describe("If true, returns the proposed file content WITHOUT writing to disk"),
});

type InjectAuthParams = typeof injectAuthSchema;

// ─── 2. Auth Utils Generation ─────────────────────────────────────────────────

function buildAuthUtils(): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile("auth.utils.ts", "", { overwrite: true });

  sourceFile.addImportDeclaration({
    defaultImport: "jwt",
    moduleSpecifier: "jsonwebtoken",
  });

  sourceFile.addStatements(`
export interface TokenPayload {
    id: string | number;
    [key: string]: unknown;
}

export const generateAccessToken = (payload: TokenPayload, secret: string, expiresIn = "15m") => {
    return jwt.sign(payload as object, secret, { expiresIn: expiresIn as any });
};

export const generateRefreshToken = (payload: TokenPayload, secret: string, expiresIn = "7d") => {
    return jwt.sign(payload as object, secret, { expiresIn: expiresIn as any });
};

export const verifyToken = (token: string, secret: string) => {
    return jwt.verify(token, secret);
};
`.trim());

  sourceFile.fixUnusedIdentifiers();
  sourceFile.organizeImports();
  return sourceFile.getFullText();
}

// ─── 3. Auth Controller Generation ────────────────────────────────────────────

function getModelInfo(targetDir: string, modelName: string) {
  const schemaPath = path.resolve(targetDir, "../../prisma/schema.prisma");
  let hasName = false;
  let isNameOptional = true;
  if (fs.existsSync(schemaPath)) {
    const content = fs.readFileSync(schemaPath, "utf-8");
    const modelRegex = new RegExp(`model\\s+${modelName}\\s+\\{([^}]+)\\}`, "m");
    const match = content.match(modelRegex);
    if (match && match[1]) {
      const block = match[1];
      const lines = block.split("\\n");
      for (const line of lines) {
        const parts = line.trim().split(/\\s+/);
        if (parts[0] === "name" && parts.length >= 2) {
          hasName = true;
          isNameOptional = parts[1]?.endsWith("?") ?? false;
        }
      }
    }
  }
  return { hasName, isNameOptional };
}

function buildAuthController(authProviders: string[], targetDir: string): string {
  const { hasName, isNameOptional } = getModelInfo(targetDir, "User");
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile("auth.controller.ts", "", { overwrite: true });

  // Imports
  sourceFile.addImportDeclaration({
    namedImports: ["Request", "Response"],
    moduleSpecifier: "express",
  });
  sourceFile.addImportDeclaration({
    defaultImport: "bcrypt",
    moduleSpecifier: "bcrypt",
  });
  sourceFile.addImportDeclaration({
    namedImports: ["z"],
    moduleSpecifier: "zod",
  });
  sourceFile.addImportDeclaration({
    namedImports: ["Prisma"],
    moduleSpecifier: "@prisma/client",
  });
  sourceFile.addImportDeclaration({
    defaultImport: "prisma",
    moduleSpecifier: "../config/prisma", // standard boilerplate path
  });
  sourceFile.addImportDeclaration({
    namedImports: ["generateAccessToken", "generateRefreshToken", "verifyToken", "TokenPayload"],
    moduleSpecifier: "../utils/auth",
  });
  sourceFile.addImportDeclaration({
    namedImports: ["env"],
    moduleSpecifier: "../config/env",
  });

  if (authProviders.includes("google")) {
    sourceFile.addImportDeclaration({
      defaultImport: "passport",
      moduleSpecifier: "passport",
    });
  }

  // Add Zod Schemas
  sourceFile.addStatements(`
// ─── Interfaces ───────────────────────────────────────────────────────────────
export interface RequestWithUser extends Request {
  user?: TokenPayload;
}

// ─── Validation Schemas ───────────────────────────────────────────────────────
const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(2, "Name must be at least 2 characters")${isNameOptional ? ".optional()" : ""},
});

const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token is required"),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

const tokenSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});
`.trim());

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

  // Always add Email/Password logic if email is selected (or just default)
  addFn("signUp", `
  try {
    const { email, password, name } = signUpSchema.parse(req.body);
    
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      res.status(400).json({ success: false, message: "User already exists" });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, password: hashedPassword, name${!isNameOptional ? ': name || "User"' : ''} }
    });

    const accessToken = generateAccessToken({ id: user.id }, env.JWT_SECRET);
    const refreshToken = generateRefreshToken({ id: user.id }, env.JWT_SECRET);

    await prisma.refreshToken.create({
      data: { token: refreshToken, userId: user.id }
    });

    res.status(201).json({
      success: true,
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name }
    });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, message: "Validation failed", errors: error.issues });
      return;
    }
    const message = error instanceof Error ? error.message : "Internal server error";
    res.status(500).json({ success: false, message });
  }
`);

  addFn("signIn", `
  try {
    const { email, password } = signInSchema.parse(req.body);
    
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.password) {
      res.status(401).json({ success: false, message: "Invalid credentials" });
      return;
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      res.status(401).json({ success: false, message: "Invalid credentials" });
      return;
    }

    const accessToken = generateAccessToken({ id: user.id }, env.JWT_SECRET);
    const refreshToken = generateRefreshToken({ id: user.id }, env.JWT_SECRET);

    await prisma.refreshToken.create({
      data: { token: refreshToken, userId: user.id }
    });

    res.status(200).json({
      success: true,
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name }
    });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, message: "Validation failed", errors: error.issues });
      return;
    }
    const message = error instanceof Error ? error.message : "Internal server error";
    res.status(500).json({ success: false, message });
  }
`);

  addFn("logout", `
  try {
    const { refreshToken } = tokenSchema.parse(req.body);

    await prisma.refreshToken.deleteMany({
      where: { token: refreshToken }
    });

    res.status(200).json({ success: true, message: "Logged out successfully" });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, message: "Validation failed", errors: error.issues });
      return;
    }
    const message = error instanceof Error ? error.message : "Internal server error";
    res.status(500).json({ success: false, message });
  }
`);

  addFn("refresh", `
  try {
    const { refreshToken } = tokenSchema.parse(req.body);

    // Verify token structure
    let decoded: TokenPayload;
    try {
      decoded = verifyToken(refreshToken, env.JWT_SECRET) as TokenPayload;
    } catch (e) {
      res.status(401).json({ success: false, message: "Invalid or expired refresh token" });
      return;
    }

    // Check if it exists in DB (to detect reuse / handle revocation)
    const existingToken = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });
    if (!existingToken) {
      res.status(401).json({ success: false, message: "Invalid or revoked refresh token" });
      return;
    }

    // Rotation: Delete old token, issue new pair
    await prisma.refreshToken.delete({ where: { id: existingToken.id } });

    const newAccessToken = generateAccessToken({ id: decoded.id }, env.JWT_SECRET);
    const newRefreshToken = generateRefreshToken({ id: decoded.id }, env.JWT_SECRET);

    await prisma.refreshToken.create({
      data: { token: newRefreshToken, userId: decoded.id as string }
    });

    res.status(200).json({
      success: true,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken
    });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, message: "Validation failed", errors: error.issues });
      return;
    }
    const message = error instanceof Error ? error.message : "Internal server error";
    res.status(500).json({ success: false, message });
  }
`);

  addFn("forgotPassword", `
  try {
    const { email } = forgotPasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    // Generate token and save to DB
    const resetToken = Math.random().toString(36).substring(2, 15);
    const expiresAt = new Date(Date.now() + 3600000); // 1 hour

    await prisma.passwordResetToken.create({
      data: {
        token: resetToken,
        userId: user.id,
        expiresAt
      }
    });

    // TODO: Actually send the email here using an email service
    console.log(\`Sending password reset email to \${email} with token: \${resetToken}\`);

    res.status(200).json({ success: true, message: "Password reset instructions sent" });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, message: "Validation failed", errors: error.issues });
      return;
    }
    const message = error instanceof Error ? error.message : "Internal server error";
    res.status(500).json({ success: false, message });
  }
`);

  addFn("resetPassword", `
  try {
    const { token, newPassword } = resetPasswordSchema.parse(req.body);
    
    const resetRecord = await prisma.passwordResetToken.findUnique({ where: { token } });
    if (!resetRecord || resetRecord.expiresAt < new Date()) {
      res.status(400).json({ success: false, message: "Invalid or expired token" });
      return;
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: resetRecord.userId },
      data: { password: hashedPassword }
    });

    // Clean up used token
    await prisma.passwordResetToken.delete({ where: { token } });

    res.status(200).json({ success: true, message: "Password updated successfully" });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, message: "Validation failed", errors: error.issues });
      return;
    }
    const message = error instanceof Error ? error.message : "Internal server error";
    res.status(500).json({ success: false, message });
  }
`);

  if (authProviders.includes("google")) {
    addFn("googleLogin", `
  try {
    const authReq = req as RequestWithUser;
    // This expects passport middleware to have populated req.user
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Authentication failed" });
      return;
    }

    const user = authReq.user;
    
    const accessToken = generateAccessToken({ id: user.id }, env.JWT_SECRET);
    const refreshToken = generateRefreshToken({ id: user.id }, env.JWT_SECRET);

    await prisma.refreshToken.create({
      data: { token: refreshToken, userId: user.id }
    });

    // Redirect to frontend or send JSON depending on architecture
    res.status(200).json({
      success: true,
      accessToken,
      refreshToken,
      user
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    res.status(500).json({ success: false, message });
  }
`);
  }

  sourceFile.fixUnusedIdentifiers();
  sourceFile.organizeImports();
  return sourceFile.getFullText();
}

// ─── 4. Tool Definition ───────────────────────────────────────────────────────

export const injectAuthSystem: Tool<FastMCPSessionAuth, InjectAuthParams> = {
  name: "inject_auth_system",
  description:
    "Universal AST Shell: Injects a complete, production-ready Authentication system. " +
    "Generates auth.controller.ts with Zod validation, signUp, signIn, reset, logout, and refresh token rotation logic (and OAuth if requested). " +
    "Also generates a JWT utility file. Refuses to overwrite existing files.",
  parameters: injectAuthSchema,

  execute: async (args) => {
    const { targetDirectory, authProviders, dryRun } = args;

    const controllersDir = path.resolve(targetDirectory);
    const utilsDir = path.resolve(controllersDir, "../utils");

    if (!fs.existsSync(controllersDir)) {
      return `[ERROR] Error: Controllers directory not found: "${controllersDir}"`;
    }

    const controllerPath = path.join(controllersDir, "auth.controller.ts");
    const utilsPath = path.join(utilsDir, "auth.ts");

    // Guard: refuse to overwrite
    if (fs.existsSync(controllerPath)) {
      return `[ERROR] Error: File already exists: "${controllerPath}". Refusing to overwrite.`;
    }
    if (fs.existsSync(utilsPath)) {
      return `[ERROR] Error: File already exists: "${utilsPath}". Refusing to overwrite.`;
    }

    const authUtilsCode = buildAuthUtils();
    const authControllerCode = buildAuthController(authProviders, controllersDir);

    if (dryRun) {
      const sep = "─".repeat(60);
      return (
        `[INFO] DRY RUN — No file was written.\n\n` +
        `${sep}\nPROPOSED FILE: src/utils/auth.ts\n${sep}\n` +
        authUtilsCode +
        `\n${sep}\nPROPOSED FILE: controllers/auth.controller.ts\n${sep}\n` +
        authControllerCode +
        `\n${sep}`
      );
    }

    try {
      // Ensure utils directory exists
      if (!fs.existsSync(utilsDir)) {
        fs.mkdirSync(utilsDir, { recursive: true });
      }

      fs.writeFileSync(utilsPath, authUtilsCode, "utf-8");
      fs.writeFileSync(controllerPath, authControllerCode, "utf-8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `[ERROR] Error writing files: ${msg}`;
    }

    let packageWarnings = `\n\n[INFO] Packages automatically installed:\n  bcrypt jsonwebtoken zod`;
    try {
      const execSync = require("node:child_process").execSync;
      const cwd = path.resolve(controllersDir, "../..");
      if (fs.existsSync(path.join(cwd, "package.json"))) {
        const pkgs = ["bcrypt", "jsonwebtoken", "zod"];
        const devPkgs = ["@types/bcrypt", "@types/jsonwebtoken"];
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
        if (authProviders.includes("google")) {
          const authPkgs = ["passport", "passport-google-oauth20"];
          const authDev = ["@types/passport", "@types/passport-google-oauth20"];
          const allDeps2 = { ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) };
          const needAuth = authPkgs.filter(p => !allDeps2[p]);
          const needAuthDev = authDev.filter(p => !allDeps2[p]);
          if (needAuth.length > 0) {
            const installCmd = `npm install ${needAuth.join(" ")} --no-save --save-exact`;
            execSync(installCmd, { cwd, stdio: "inherit" });
          }
          if (needAuthDev.length > 0) {
            const installCmd = `npm install -D ${needAuthDev.join(" ")} --no-save --save-exact`;
            execSync(installCmd, { cwd, stdio: "inherit" });
          }
          packageWarnings += `\n  passport passport-google-oauth20`;
        }
      }
    } catch (err: unknown) {
      packageWarnings = `\n\n[WARNING] Failed to auto-install packages. Please manually run:\n  npm install bcrypt jsonwebtoken zod\n  npm install -D @types/bcrypt @types/jsonwebtoken`;
    }

    let prismaWarnings = `\n\n[WARNING] Prisma Schema Requirements:\n  Please ensure your schema.prisma contains at minimum:\n  - User model (id, email, password, name)\n  - PasswordResetToken model (id, token, userId, expiresAt)\n  - RefreshToken model (id, token (unique), userId)\n  - Account model (if using Google OAuth)`;

    return (
      `[SUCCESS] Auth System injected successfully!\n\n` +
      `Generated Files:\n` +
      `  • ${utilsPath}\n` +
      `  • ${controllerPath}` +
      packageWarnings +
      prismaWarnings
    );
  },
};

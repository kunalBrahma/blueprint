import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { Project, Node, SyntaxKind } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { recordInstalledPackages } from "./sdkVersions.js";

const injectSocketSchema = z.object({
  serverFile: z.string().describe("Absolute path to the main application file (server.ts / app.ts)"),
  targetSrcDirectory: z.string().describe("Absolute path to the src directory where services live"),
  dryRun: z.boolean().default(false),
});

type InjectSocketParams = typeof injectSocketSchema;

function buildSocketService(): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile("socket.service.ts", "", { overwrite: true });

  sourceFile.addStatements(`
import { Server as HttpServer } from "node:http";
import { Server, Socket } from "socket.io";

export class SocketService {
  private io?: Server;
  // Queue holds actions requested before init() is called to avoid circular dependency
  private queuedActions: Array<() => void> = [];

  public init(server: HttpServer): void {
    this.io = new Server(server, {
      cors: {
        origin: process.env.CORS_ORIGIN || "*",
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
      },
    });

    this.io.on("connection", (socket: Socket) => {
      console.log("[INFO] Client connected [ID: " + socket.id + "]");

      socket.on("disconnect", () => {
        console.log("[INFO] Client disconnected [ID: " + socket.id + "]");
      });
      
      // Add custom event listeners here
    });

    // Drain queued actions after initialization
    while (this.queuedActions.length > 0) {
      const act = this.queuedActions.shift();
      try {
        act && act();
      } catch (err) {
        console.warn("[WARNING] Error executing queued socket action:", err);
      }
    }
  }

  private getIOOrNull(): Server | undefined {
    return this.io;
  }

  public emitEvent(event: string, data: unknown): void {
    const io = this.getIOOrNull();
    if (io) {
      io.emit(event, data);
      return;
    }
    // Queue emit until init
    this.queuedActions.push(() => {
      const i = this.getIOOrNull();
      if (i) i.emit(event, data);
    });
  }

  public emitToRoom(room: string, event: string, data: unknown): void {
    const io = this.getIOOrNull();
    if (io) {
      io.to(room).emit(event, data);
      return;
    }
    this.queuedActions.push(() => {
      const i = this.getIOOrNull();
      if (i) i.to(room).emit(event, data);
    });
  }

  public joinRoom(socketId: string, room: string): void {
    const io = this.getIOOrNull();
    if (io) {
      const sock = io.sockets.sockets.get(socketId as any) as Socket | undefined;
      sock?.join(room);
      return;
    }
    // Joining a room before init is not critical; enqueue a best-effort action
    this.queuedActions.push(() => {
      const i = this.getIOOrNull();
      if (i) {
        const s = i.sockets.sockets.get(socketId as any) as Socket | undefined;
        s?.join(room);
      }
    });
  }
}

export const socketService = new SocketService();
`.trimStart());

  sourceFile.fixUnusedIdentifiers();
  sourceFile.organizeImports();
  return sourceFile.getFullText();
}

function injectIntoServer(serverContent: string, serverPath: string, srcPath: string): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(serverPath, serverContent, { overwrite: true });

  // Ensure Imports
  const hasHttp = sourceFile.getImportDeclarations().some(imp => imp.getModuleSpecifierValue() === "node:http" || imp.getModuleSpecifierValue() === "http");
  if (!hasHttp) {
    sourceFile.insertStatements(0, `import * as http from "node:http";`);
  }

  const relImport = (() => {
    const rel = path.relative(path.dirname(serverPath), path.join(srcPath, "services/socket.service"));
    const stripped = rel.replace(/\\/g, "/");
    return stripped.startsWith(".") ? stripped : `./${stripped}`;
  })();

  const hasSocketSvc = sourceFile.getImportDeclarations().some(imp => imp.getNamedImports().some(n => n.getName() === "socketService"));
  if (!hasSocketSvc) {
    const lastImport = sourceFile.getLastChildByKind(SyntaxKind.ImportDeclaration);
    const idx = lastImport ? lastImport.getChildIndex() + 1 : 0;
    sourceFile.insertStatements(idx, `import { socketService } from "${relImport}";`);
  }

  // Find expressive app initialization usually `const app = express();`
  let appVarName = "app";
  let appInitIndex = -1;
  const stmts = sourceFile.getStatements();

  stmts.forEach((stmt, i) => {
    if (Node.isVariableStatement(stmt)) {
      stmt.getDeclarations().forEach(decl => {
        const init = decl.getInitializer();
        if (init && (init.getText().includes("express()") || init.getText().startsWith("express()"))) {
          appVarName = decl.getName();
          appInitIndex = i;
        }
      });
    }
  });

  // Check if `http.createServer` already exists
  const hasHttpCreate = stmts.some(stmt => stmt.getText().includes("http.createServer"));

  if (!hasHttpCreate && appInitIndex !== -1) {
    // We inject the http server wrapping immediately after `const app = express();`
    sourceFile.insertStatements(appInitIndex + 1, `\n// Wrap Express app with HTTP server to support WebSockets\nconst server = http.createServer(${appVarName});\nsocketService.init(server);\n`);
  }

  // Replace app.listen with server.listen
  stmts.forEach((stmt) => {
    if (!Node.isExpressionStatement(stmt)) return;
    const expr = stmt.getExpression();
    if (!Node.isCallExpression(expr)) return;
    const callee = expr.getExpression();

    if (Node.isPropertyAccessExpression(callee) &&
      callee.getExpression().getText() === appVarName &&
      callee.getName() === "listen") {

      // Replace `app.listen` with `server.listen`
      callee.getExpression().replaceWithText("server");
    }
  });

  sourceFile.fixUnusedIdentifiers();
  sourceFile.organizeImports();
  return sourceFile.getFullText();
}

export const injectSocketService: Tool<FastMCPSessionAuth, InjectSocketParams> = {
  name: "inject_socket_service",
  description: "Builds a production-ready Socket.io service utilizing singleton architecture. Leverages AST wrapping to instantly configure the Express application over an HTTP server, automatically parsing 'app.listen' to 'server.listen'.",
  parameters: injectSocketSchema,

  execute: async (args) => {
    const { serverFile, targetSrcDirectory, dryRun } = args;

    const resolvedServerPath = path.resolve(serverFile);
    const resolvedSrcDir = path.resolve(targetSrcDirectory);

    if (!fs.existsSync(resolvedServerPath)) return `[ERROR] Error: serverFile not found: "${resolvedServerPath}"`;
    if (!fs.existsSync(resolvedSrcDir)) return `[ERROR] Error: src directory not found: "${resolvedSrcDir}"`;

    const servicesDir = path.join(resolvedSrcDir, "services");
    const socketPath = path.join(servicesDir, "socket.service.ts");

    if (fs.existsSync(socketPath)) return `[ERROR] Guard: File exists: "${socketPath}"`;

    let serverContent = fs.readFileSync(resolvedServerPath, "utf-8");
    const modifiedServer = injectIntoServer(serverContent, resolvedServerPath, resolvedSrcDir);
    const socketContent = buildSocketService();

    if (dryRun) {
      return (
        `[INFO] DRY RUN\n\n` +
        `--- PROPOSED: socket.service.ts ---\n${socketContent}\n` +
        `--- PROPOSED: ${serverFile} ---\n${modifiedServer}\n`
      );
    }

    if (!fs.existsSync(servicesDir)) fs.mkdirSync(servicesDir, { recursive: true });

    fs.writeFileSync(socketPath, socketContent, "utf-8");
    fs.writeFileSync(resolvedServerPath, modifiedServer, "utf-8");

    let packageWarnings = `\n\n[INFO] Packages automatically installed:\n  socket.io`;
    try {
      const execSync = require("node:child_process").execSync;
      const cwd = path.resolve(resolvedSrcDir, "..");
      if (fs.existsSync(path.join(cwd, "package.json"))) {
        const pkgs = ["socket.io"];
        const devPkgs = ["@types/socket.io"];
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

        // Record versions of installed SDKs for reproducibility
        try {
          recordInstalledPackages(cwd, [...pkgs, ...devPkgs]);
        } catch (_) {
          // best-effort
        }
      }
    } catch (err: unknown) {
      packageWarnings = `\n\n[WARNING] Failed to auto-install packages. Please manually run:\n  npm install socket.io\n  npm install -D @types/socket.io`;
    }

    return `[SUCCESS] Socket Service injected successfully!` + packageWarnings;
  },
};

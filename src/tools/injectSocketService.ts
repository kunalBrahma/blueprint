import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { z } from "zod";
import { Project, Node, SyntaxKind } from "ts-morph";
import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { recordInstalledPackages } from "./sdkVersions.js";
import { withMutationReport } from "../utils/mutationTracker.js";
import { enforcePathJail } from "../utils/pathJail.js";
import { WORKSPACE_ROOT } from "../utils/workspace.js";

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
    });

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
      const sock = io.sockets.sockets.get(socketId) as Socket | undefined;
      sock?.join(room);
      return;
    }
    this.queuedActions.push(() => {
      const i = this.getIOOrNull();
      if (i) {
        const s = i.sockets.sockets.get(socketId) as Socket | undefined;
        s?.join(room);
      }
    });
  }
}

export const socketService = new SocketService();
`.trimStart());

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

function injectIntoServer(serverContent: string, serverPath: string, srcPath: string): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(serverPath, serverContent, { overwrite: true });

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

  let appVarName = "app";
  let appInitIndex = -1;
  const appCandidates: { name: string; index: number }[] = [];
  const stmts = sourceFile.getStatements();

  stmts.forEach((stmt, i) => {
    if (Node.isVariableStatement(stmt)) {
      stmt.getDeclarations().forEach(decl => {
        const init = decl.getInitializer();
        if (init && (init.getText().includes("express()") || init.getText().startsWith("express()"))) {
          appCandidates.push({ name: decl.getName(), index: i });
        }
      });
    }
  });

  if (appCandidates.length === 0) {
    throw new Error(
      `[AST Hard-Fail] No Express app declaration (e.g. "const app = express()") found in "${serverPath}". ` +
      `Cannot determine where to inject HTTP server wrapping.`
    );
  }
  if (appCandidates.length > 1) {
    throw new Error(
      `[AST Hard-Fail] Ambiguous: ${appCandidates.length} Express app declarations found in "${serverPath}": ` +
      `[${appCandidates.map(c => c.name).join(", ")}]. Cannot determine which to use.`
    );
  }
  appVarName = appCandidates[0]!.name;
  appInitIndex = appCandidates[0]!.index;

  const hasHttpCreate = stmts.some(stmt => stmt.getText().includes("http.createServer"));

  if (!hasHttpCreate && appInitIndex !== -1) {
    // Case A: No HTTP server exists yet — create one and initialise socket service.
    sourceFile.insertStatements(
      appInitIndex + 1,
      `\n// Wrap Express app with HTTP server to support WebSockets\nconst server = http.createServer(${appVarName});\nsocketService.init(server);\n`
    );
  } else if (hasHttpCreate) {
    // Case B: An http.createServer(...) already exists —
    // just ensure socketService.init(server) is called after it.
    const alreadyInited = sourceFile.getStatements().some(s =>
      s.getText().includes("socketService.init")
    );
    if (!alreadyInited) {
      const httpCreateStmt = sourceFile.getStatements().find(s =>
        s.getText().includes("http.createServer")
      );
      if (httpCreateStmt) {
        sourceFile.insertStatements(
          httpCreateStmt.getChildIndex() + 1,
          `socketService.init(server);`
        );
      }
    }
  }

  // Replace app.listen with server.listen on a fresh statement scan
  sourceFile.getStatements().forEach((stmt) => {
    if (!Node.isExpressionStatement(stmt)) return;
    const expr = stmt.getExpression();
    if (!Node.isCallExpression(expr)) return;
    const callee = expr.getExpression();

    if (Node.isPropertyAccessExpression(callee) &&
      callee.getExpression().getText() === appVarName &&
      callee.getName() === "listen") {
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

    // STRICT PATH JAILING ENFORCED ON BOTH PATHS
    const resolvedServerPath = path.resolve(serverFile);
    const resolvedSrcDir = path.resolve(targetSrcDirectory);
    const safeServerPath = enforcePathJail(WORKSPACE_ROOT, resolvedServerPath);
    const safeSrcDir = enforcePathJail(WORKSPACE_ROOT, resolvedSrcDir);

    const projectRoot = path.resolve(safeSrcDir, "..");

    return withMutationReport("inject_socket_service", dryRun ? null : projectRoot, async (report) => {
      // USING ONLY SAFE PATHS FOR ALL FS OPERATIONS
      if (!fs.existsSync(safeServerPath)) throw new Error(`serverFile not found: "${safeServerPath}"`);
      if (!fs.existsSync(safeSrcDir)) throw new Error(`src directory not found: "${safeSrcDir}"`);

      const servicesDir = path.join(safeSrcDir, "services");
      const socketPath = path.join(servicesDir, "socket.service.ts");

      if (fs.existsSync(socketPath)) throw new Error(`Guard: File exists: "${socketPath}"`);

      const serverContent = fs.readFileSync(safeServerPath, "utf-8");
      const modifiedServer = injectIntoServer(serverContent, safeServerPath, safeSrcDir);
      const socketContent = buildSocketService();

      if (dryRun) {
        report.humanMessage =
          `[INFO] DRY RUN\n\n` +
          `--- PROPOSED: socket.service.ts ---\n${socketContent}\n` +
          `--- PROPOSED: ${serverFile} ---\n${modifiedServer}\n`;
        return;
      }

      if (!fs.existsSync(servicesDir)) fs.mkdirSync(servicesDir, { recursive: true });

      report.snapshotFiles([socketPath, safeServerPath]);

      fs.writeFileSync(socketPath, socketContent, "utf-8");
      report.mutatedFiles.push(socketPath);
      fs.writeFileSync(safeServerPath, modifiedServer, "utf-8");
      report.mutatedFiles.push(safeServerPath);

      // Kept auto-install for now, but with 'pipe' safety intact as per the previous fix.
      let packageWarnings = `\n\n[INFO] Packages automatically installed:\n  socket.io`;
      try {
        const cwd = projectRoot;
        if (fs.existsSync(path.join(cwd, "package.json"))) {
          const pkgs = ["socket.io"];
          const devPkgs = ["@types/socket.io"];
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

          try {
            recordInstalledPackages(cwd, [...pkgs, ...devPkgs]);
          } catch (_) { }
        }
      } catch (err: unknown) {
        packageWarnings = `\n\n[WARNING] Failed to auto-install packages. Please manually run:\n  npm install socket.io\n  npm install -D @types/socket.io`;
        report.status = "PARTIAL_FAILURE";
      }

      report.humanMessage = `[SUCCESS] Socket Service injected successfully!` + packageWarnings;
    });
  },
};
import type http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, pbkdf2Sync } from "node:crypto";
import { WebSocketServer } from "ws";
import { D1DatabaseCompat } from "./sqlite-compat";
import { Progress } from "./progress";
import { WorkflowManager } from "./workflow";
import serverApp from "./index";
import type { Env } from "./env";

function hashPassword(value: string, saltHex?: string): string {
  const salt = saltHex ?? randomBytes(16).toString("hex");
  const derived = pbkdf2Sync(
    value,
    Buffer.from(salt, "hex"),
    100000,
    32,
    "sha256",
  ).toString("hex");
  return `pbkdf2:100000:${salt}:${derived}`;
}

export interface ServerConfig {
  dataDir?: string;
  distDir?: string;
}

export class WorkersChatServer {
  public readonly env: Env;
  private wss: WebSocketServer;
  private distDir: string;
  private progressMap = new Map<string, Progress>();

  constructor(config: ServerConfig = {}) {
    const dataDir =
      config.dataDir ||
      process.env.WORKERS_CHAT_DATA_DIR ||
      path.join(os.homedir(), ".dsh", "storages", "workers_chat");

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.distDir =
      config.distDir ||
      (fs.existsSync(path.resolve(__dirname, "../dist"))
        ? path.resolve(__dirname, "../dist")
        : path.resolve(__dirname, "../../dist"));

    // Load or generate secrets
    const secretsPath = path.join(dataDir, "secrets.json");
    let secrets: {
      PASSWORD_HASH: string;
      RECOVERY_HASH: string;
      ENCRYPTION_KEY: string;
      LOCAL_SESSION_TOKEN: string;
    };

    if (fs.existsSync(secretsPath)) {
      try {
        secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
      } catch {
        secrets = this.generateSecrets();
        fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), "utf8");
      }
    } else {
      secrets = this.generateSecrets();
      fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), "utf8");
    }

    // Initialize SQLite Database
    const dbPath = path.join(dataDir, "workers-chat.db");
    const db = new D1DatabaseCompat(dbPath);

    this.wss = new WebSocketServer({ noServer: true });

    const progressRegistry = {
      getByName: (name: string): Progress => {
        let p = this.progressMap.get(name);
        if (!p) {
          p = new Progress(name, this.env);
          this.progressMap.set(name, p);
        }
        return p;
      },
    };

    const genManager = new WorkflowManager("generation", null as any);
    const titleManager = new WorkflowManager("title", null as any);

    this.env = {
      DB: db,
      PROGRESS: progressRegistry,
      GENERATION: genManager,
      TITLES: titleManager,
      PASSWORD_HASH: secrets.PASSWORD_HASH,
      RECOVERY_HASH: secrets.RECOVERY_HASH,
      ENCRYPTION_KEY: secrets.ENCRYPTION_KEY,
      LOCAL_SESSION_TOKEN: secrets.LOCAL_SESSION_TOKEN,
    };

    (genManager as any).env = this.env;
    (titleManager as any).env = this.env;
  }

  private generateSecrets() {
    const defaultPassword = "workers-chat-local";
    const defaultRecovery = randomBytes(32).toString("hex");
    return {
      PASSWORD_HASH: hashPassword(defaultPassword),
      RECOVERY_HASH: hashPassword(defaultRecovery),
      ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      LOCAL_SESSION_TOKEN: randomBytes(32).toString("hex"),
    };
  }

  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case ".html":
        return "text/html; charset=utf-8";
      case ".js":
      case ".mjs":
        return "application/javascript; charset=utf-8";
      case ".css":
        return "text/css; charset=utf-8";
      case ".json":
        return "application/json; charset=utf-8";
      case ".svg":
        return "image/svg+xml";
      case ".png":
        return "image/png";
      case ".ico":
        return "image/x-icon";
      case ".woff":
        return "font/woff";
      case ".woff2":
        return "font/woff2";
      case ".txt":
        return "text/plain; charset=utf-8";
      default:
        return "application/octet-stream";
    }
  }

  handleStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }

    const parsed = new URL(req.url!, "http://127.0.0.1");
    let relative = parsed.pathname.replace(/^\/workers-chat\/?/, "");
    if (!relative) relative = "index.html";

    let targetFile = path.join(this.distDir, relative);

    // If file doesn't exist and has no dot, fall back to index.html (SPA routing)
    if (!fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
      targetFile = path.join(this.distDir, "index.html");
    }

    if (!fs.existsSync(targetFile)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const stat = fs.statSync(targetFile);
    const mime = this.getMimeType(targetFile);

    const headers: Record<string, string | number> = {
      "Content-Type": mime,
      "Content-Length": stat.size,
    };

    if (relative.startsWith("assets/")) {
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    } else {
      headers["Cache-Control"] = "no-cache";
    }

    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = fs.createReadStream(targetFile);
    stream.pipe(res);
  }

  async handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const protocol = req.headers["x-forwarded-proto"] || "http";
      const host = req.headers.host || "127.0.0.1";
      const originalUrl = new URL(req.url!, `${protocol}://${host}`);

      // Rewrite /api/workers-chat/... to /api/...
      const rewrittenPath = originalUrl.pathname.replace(
        /^\/api\/workers-chat/,
        "/api",
      );
      const url = new URL(
        rewrittenPath + originalUrl.search,
        `${protocol}://${host}`,
      );

      const headers = new Headers();
      for (const [key, val] of Object.entries(req.headers)) {
        if (val === undefined) continue;
        if (Array.isArray(val)) {
          for (const v of val) headers.append(key, v);
        } else {
          headers.set(key, val);
        }
      }

      // Auto-attach local session cookie if missing in desktop mode
      const existingCookie = headers.get("cookie") || "";
      if (!existingCookie.includes("session=")) {
        const sessionCookie = `session=${this.env.LOCAL_SESSION_TOKEN}`;
        headers.set(
          "cookie",
          existingCookie ? `${existingCookie}; ${sessionCookie}` : sessionCookie,
        );
      }

      let body: ReadableStream | null = null;
      if (req.method !== "GET" && req.method !== "HEAD") {
        body = new ReadableStream({
          start(controller) {
            req.on("data", (chunk) => controller.enqueue(chunk));
            req.on("end", () => controller.close());
            req.on("error", (err) => controller.error(err));
          },
        });
      }

      const request = new Request(url.toString(), {
        method: req.method,
        headers,
        body,
        // @ts-ignore
        duplex: "half",
      });

      const response = await serverApp.fetch(request, this.env);

      res.statusCode = response.status;
      for (const [key, value] of response.headers) {
        if (key.toLowerCase() === "set-cookie") {
          const getSetCookie = (response.headers as any).getSetCookie?.();
          if (getSetCookie) {
            res.setHeader(key, getSetCookie);
            continue;
          }
        }
        res.setHeader(key, value);
      }

      // Ensure local session cookie is set on bootstrap / auth check
      if (
        (url.pathname === "/api/bootstrap" ||
          url.pathname === "/api/auth/status") &&
        !existingCookie.includes("session=")
      ) {
        res.setHeader(
          "Set-Cookie",
          `session=${this.env.LOCAL_SESSION_TOKEN}; Path=/; SameSite=Lax`,
        );
      }

      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (err: any) {
      console.error("Workers-Chat API error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message || "Internal error" }));
      }
    }
  }

  async handleWorkerRequest(request: Request): Promise<Response> {
    return serverApp.fetch(request, this.env);
  }

  handleUpgrade(req: http.IncomingMessage, socket: any, head: any): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const parsed = new URL(req.url!, "http://127.0.0.1");
      let id = parsed.searchParams.get("id");
      const kind = parsed.searchParams.get("kind");
      const isTitle = kind === "title";

      if (!id) {
        // Fallback: match from path like /api/workers-chat/jobs/:id/events
        const match = parsed.pathname.match(
          /^\/api\/workers-chat\/jobs\/([^/]+)\/events/,
        );
        if (match) id = match[1];
      }

      if (!id) {
        ws.close(1008, "Missing job id");
        return;
      }

      const progressName = (isTitle ? "title-" : "") + id;
      const progress = this.env.PROGRESS.getByName(progressName);
      progress.attachWebSocket(ws, isTitle, id);
    });
  }
}

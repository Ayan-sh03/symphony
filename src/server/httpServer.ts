/**
 * OPTIONAL HTTP server extension (SPEC §13.7). Observability/control surface only;
 * never required for orchestrator correctness. Binds loopback by default.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import type { Logger } from "../logger.ts";
import { renderDashboard } from "./dashboard.ts";

export interface HttpServerOptions {
  orchestrator: Orchestrator;
  logger: Logger;
  port: number;
  host?: string;
}

export class SymphonyHttpServer {
  private server: http.Server;
  private port: number;
  private host: string;

  private opts: HttpServerOptions;
  constructor(opts: HttpServerOptions) {
    this.opts = opts;
    this.port = opts.port;
    this.host = opts.host ?? "127.0.0.1";
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address() as AddressInfo;
        this.opts.logger.info("http server listening", { host: this.host, port: addr.port });
        resolve(addr.port);
      });
    });
  }

  close(): void {
    this.server.close();
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    try {
      if (pathname === "/" && method === "GET") {
        const html = renderDashboard(this.opts.orchestrator.snapshot());
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (pathname === "/api/v1/state" && method === "GET") {
        return this.json(res, 200, this.opts.orchestrator.snapshot());
      }
      if (pathname === "/api/v1/refresh") {
        if (method !== "POST") return this.methodNotAllowed(res);
        const r = this.opts.orchestrator.requestRefresh();
        return this.json(res, 202, {
          queued: r.queued,
          coalesced: r.coalesced,
          requested_at: new Date().toISOString(),
          operations: ["poll", "reconcile"],
        });
      }
      if (pathname === "/api/v1/issues") {
        if (method === "GET") {
          if (!this.opts.orchestrator.canBoard()) {
            return this.json(res, 501, { error: { code: "not_supported", message: "tracker does not support a board view" } });
          }
          void this.opts.orchestrator
            .board()
            .then((b) => this.json(res, 200, b))
            .catch((err) => this.json(res, 500, { error: { code: "board_failed", message: String(err) } }));
          return;
        }
        if (method !== "POST") return this.methodNotAllowed(res);
        if (!this.opts.orchestrator.canCreateIssues()) {
          return this.json(res, 501, { error: { code: "not_supported", message: "tracker does not support creating issues" } });
        }
        void this.createIssue(req, res);
        return;
      }
      const stateMatch = pathname.match(/^\/api\/v1\/issues\/([^/]+)\/state$/);
      if (stateMatch) {
        if (method !== "POST") return this.methodNotAllowed(res);
        if (!this.opts.orchestrator.canBoard()) {
          return this.json(res, 501, { error: { code: "not_supported", message: "tracker does not support changing state" } });
        }
        void this.setState(decodeURIComponent(stateMatch[1]!), req, res);
        return;
      }
      const agentMatch = pathname.match(/^\/api\/v1\/issues\/([^/]+)\/agent$/);
      if (agentMatch) {
        if (method !== "POST") return this.methodNotAllowed(res);
        void this.setIssueAgent(decodeURIComponent(agentMatch[1]!), req, res);
        return;
      }
      if (pathname === "/api/v1/default-agent") {
        if (method !== "POST") return this.methodNotAllowed(res);
        void this.setDefaultAgent(req, res);
        return;
      }
      const m = pathname.match(/^\/api\/v1\/([^/]+)$/);
      if (m) {
        if (method !== "GET") return this.methodNotAllowed(res);
        const identifier = decodeURIComponent(m[1]!);
        void this.opts.orchestrator
          .issueDetailFor(identifier)
          .then((detail) => {
            if (!detail) {
              return this.json(res, 404, { error: { code: "issue_not_found", message: `unknown issue ${identifier}` } });
            }
            this.json(res, 200, detail);
          })
          .catch((err) => this.json(res, 500, { error: { code: "detail_failed", message: String(err) } }));
        return;
      }
      this.json(res, 404, { error: { code: "not_found", message: "no such route" } });
    } catch (err) {
      this.opts.logger.warn("http handler error", { error: String(err) });
      this.json(res, 500, { error: { code: "internal_error", message: String(err) } });
    }
  }

  private async createIssue(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      return this.json(res, 400, { error: { code: "bad_request", message: "invalid JSON body" } });
    }
    try {
      const issue = await this.opts.orchestrator.createIssue({
        identifier: String(body.identifier ?? ""),
        title: String(body.title ?? ""),
        description: typeof body.description === "string" ? body.description : null,
        state: typeof body.state === "string" ? body.state : null,
        priority: typeof body.priority === "number" ? body.priority : body.priority != null ? Number(body.priority) : null,
        labels: Array.isArray(body.labels) ? body.labels.map(String) : [],
      });
      this.json(res, 201, { created: true, issue: { id: issue.id, identifier: issue.identifier, state: issue.state } });
    } catch (err) {
      this.json(res, 400, { error: { code: "create_failed", message: String((err as Error).message ?? err) } });
    }
  }

  private async setState(id: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      return this.json(res, 400, { error: { code: "bad_request", message: "invalid JSON body" } });
    }
    const state = typeof body.state === "string" ? body.state : "";
    if (!state) return this.json(res, 400, { error: { code: "bad_request", message: "state is required" } });
    try {
      const issue = await this.opts.orchestrator.setIssueState(id, state);
      this.json(res, 200, { updated: true, issue: { id: issue.id, identifier: issue.identifier, state: issue.state } });
    } catch (err) {
      this.json(res, 400, { error: { code: "update_failed", message: String((err as Error).message ?? err) } });
    }
  }

  private async setIssueAgent(id: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      return this.json(res, 400, { error: { code: "bad_request", message: "invalid JSON body" } });
    }
    const agent = typeof body.agent === "string" ? body.agent : "";
    try {
      const issue = await this.opts.orchestrator.setIssueAgent(id, agent);
      this.json(res, 200, { updated: true, issue: { id: issue.id, identifier: issue.identifier, agent: issue.agent } });
    } catch (err) {
      this.json(res, 400, { error: { code: "update_failed", message: String((err as Error).message ?? err) } });
    }
  }

  private async setDefaultAgent(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      return this.json(res, 400, { error: { code: "bad_request", message: "invalid JSON body" } });
    }
    const kind = typeof body.kind === "string" ? body.kind : "";
    try {
      this.opts.orchestrator.setDefaultAgent(kind);
      this.json(res, 200, { updated: true, default_agent: this.opts.orchestrator.effectiveDefaultAgent() });
    } catch (err) {
      this.json(res, 400, { error: { code: "update_failed", message: String((err as Error).message ?? err) } });
    }
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body, null, 2));
  }
  private methodNotAllowed(res: http.ServerResponse): void {
    this.json(res, 405, { error: { code: "method_not_allowed", message: "unsupported method" } });
  }
}

/** Read and JSON-parse a request body, capped to guard against oversized payloads. */
function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) return reject(new Error("body too large"));
      if (data.trim() === "") return resolve({});
      try {
        const parsed = JSON.parse(data);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reject(new Error("not an object"));
        resolve(parsed as Record<string, unknown>);
      } catch (err) {
        reject(err as Error);
      }
    });
    req.on("error", reject);
  });
}

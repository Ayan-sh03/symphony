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
      const m = pathname.match(/^\/api\/v1\/([^/]+)$/);
      if (m) {
        if (method !== "GET") return this.methodNotAllowed(res);
        const identifier = decodeURIComponent(m[1]!);
        const detail = this.opts.orchestrator.issueDetail(identifier);
        if (!detail) {
          return this.json(res, 404, { error: { code: "issue_not_found", message: `unknown issue ${identifier}` } });
        }
        return this.json(res, 200, detail);
      }
      this.json(res, 404, { error: { code: "not_found", message: "no such route" } });
    } catch (err) {
      this.opts.logger.warn("http handler error", { error: String(err) });
      this.json(res, 500, { error: { code: "internal_error", message: String(err) } });
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

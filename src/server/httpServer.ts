/**
 * OPTIONAL HTTP server extension (SPEC §13.7). Observability/control surface only;
 * never required for orchestrator correctness. Binds loopback by default.
 *
 * Multi-project (host extension): routes are scoped by project id. `/api/v1/projects`
 * lists/creates projects; every other endpoint lives under `/api/v1/projects/<pid>/…`
 * and is dispatched to that project's Orchestrator. The `<pid>` segment namespaces
 * per-project issue identifiers, which are only unique within a single tracker scope.
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import { OrchestratorError } from "../orchestrator/orchestrator.ts";
import type { IssuePatch } from "../tracker/types.ts";
import type { ProjectManager } from "../project/manager.ts";
import type { Logger } from "../logger.ts";
import { renderDashboard } from "./dashboard.ts";

/** Static roots for the console app: our ES modules plus the lit-html package served as-is. */
const UI_ROOT = fileURLToPath(new URL("./ui/", import.meta.url));
// `lit-html/directive.js` sits at the package root and is in the exports map (the
// bare "lit-html" entry resolves to the node/ build, which is the wrong root).
const LIT_ROOT = path.dirname(createRequire(import.meta.url).resolve("lit-html/directive.js"));
const UI_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface HttpServerOptions {
  manager: ProjectManager;
  logger: Logger;
  port: number;
  host?: string;
}

interface SseClient {
  res: http.ServerResponse;
  heartbeat: NodeJS.Timeout | null;
  closed: boolean;
}

interface SseHub {
  clients: Set<SseClient>;
  unsubscribe: (() => void) | null;
  notifyTimer: NodeJS.Timeout | null;
}

const SSE_MAX_CLIENTS_PER_PROJECT = 16;
const SSE_COALESCE_MS = 200;
const SSE_HEARTBEAT_MS = 25000;

export class SymphonyHttpServer {
  private server: http.Server;
  private port: number;
  private host: string;
  /** One observer per project fans out coalesced snapshots to its browser clients. */
  private sseHubs = new Map<Orchestrator, SseHub>();

  private opts: HttpServerOptions;
  constructor(opts: HttpServerOptions) {
    this.opts = opts;
    this.port = opts.port;
    // A blank/whitespace-only host is treated as unset: Node binds "" to `::`,
    // which would silently expose the unauthenticated console. Default loopback
    // (SPEC §13.7).
    const trimmed = opts.host != null ? opts.host.trim() : "";
    this.host = trimmed || "127.0.0.1";
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
    for (const [orch, hub] of [...this.sseHubs]) {
      for (const client of [...hub.clients]) {
        this.closeSseClient(orch, hub, client);
        client.res.end();
      }
    }
    this.server.close();
  }

  /** Bound socket address (for tests/observability); null until the server listens. */
  address(): AddressInfo | string | null {
    return this.server.address();
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    try {
      // Console shell: embed the project list + the selected project's first snapshot.
      if (pathname === "/" && method === "GET") {
        const selected = this.selectedId(url);
        const snap = this.opts.manager.get(selected)?.orchestrator.snapshot() ?? null;
        const html = renderDashboard({
          projects: this.opts.manager.list(),
          can_add: this.opts.manager.canAdd(),
          selected,
          snapshot: snap,
        });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // Console app assets (ES modules + CSS + vendored lit-html).
      if (pathname.startsWith("/ui/")) {
        if (method !== "GET") return this.methodNotAllowed(res);
        void this.serveUi(pathname, res);
        return;
      }

      // Project registry.
      if (pathname === "/api/v1/projects") {
        if (method === "GET") {
          return this.json(res, 200, {
            projects: this.opts.manager.list(),
            can_add: this.opts.manager.canAdd(),
            default: this.opts.manager.firstId(),
          });
        }
        if (method !== "POST") return this.methodNotAllowed(res);
        void this.addProject(req, res);
        return;
      }

      // Everything else is project-scoped: /api/v1/projects/<pid>/<rest>.
      const scoped = pathname.match(/^\/api\/v1\/projects\/([^/]+)(\/.*)?$/);
      if (scoped) {
        const pid = decodeURIComponent(scoped[1]!);
        const rest = scoped[2] ?? "/";
        const project = this.opts.manager.get(pid);
        if (!project) {
          return this.json(res, 404, { error: { code: "project_not_found", message: `unknown project ${pid}` } });
        }
        return this.routeProject(project.orchestrator, rest, req, res, method);
      }

      this.json(res, 404, { error: { code: "not_found", message: "no such route" } });
    } catch (err) {
      this.opts.logger.warn("http handler error", { error: String(err) });
      this.json(res, 500, { error: { code: "internal_error", message: String(err) } });
    }
  }

  /** Which project the console shell should paint first: ?project=… if valid, else the first. */
  private selectedId(url: URL): string {
    const requested = url.searchParams.get("project");
    if (requested && this.opts.manager.get(requested)) return requested;
    return this.opts.manager.firstId();
  }

  /** Dispatch a project-scoped sub-path against one Orchestrator (mirrors the flat v1 API). */
  private routeProject(
    orch: Orchestrator,
    rest: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
  ): void {
    if (rest === "/state" && method === "GET") {
      return this.json(res, 200, orch.snapshot());
    }
    if (rest === "/events") {
      if (method !== "GET") return this.methodNotAllowed(res);
      return this.openEventStream(orch, req, res);
    }
    if (rest === "/refresh") {
      if (method !== "POST") return this.methodNotAllowed(res);
      const r = orch.requestRefresh();
      return this.json(res, 202, {
        queued: r.queued,
        coalesced: r.coalesced,
        requested_at: new Date().toISOString(),
        operations: ["poll", "reconcile"],
      });
    }
    if (rest === "/issues") {
      if (method === "GET") {
        if (!orch.canBoard()) {
          return this.json(res, 501, { error: { code: "not_supported", message: "tracker does not support a board view" } });
        }
        void orch
          .board()
          .then((b) => this.json(res, 200, b))
          .catch((err) => this.json(res, 500, { error: { code: "board_failed", message: String(err) } }));
        return;
      }
      if (method !== "POST") return this.methodNotAllowed(res);
      if (!orch.canCreateIssues()) {
        return this.json(res, 501, { error: { code: "not_supported", message: "tracker does not support creating issues" } });
      }
      void this.createIssue(orch, req, res);
      return;
    }
    // Edit/remove one issue (extension). Both halves are gated by the same adapter
    // capability, so an unsupported tracker answers 501 rather than a bare 405.
    const editMatch = rest.match(/^\/issues\/([^/]+)$/);
    if (editMatch) {
      if (method !== "PATCH" && method !== "DELETE") return this.methodNotAllowed(res);
      if (!orch.canEditIssues()) {
        return this.json(res, 501, { error: { code: "not_supported", message: "tracker does not support editing issues" } });
      }
      const id = decodeURIComponent(editMatch[1]!);
      if (method === "PATCH") {
        void this.updateIssue(orch, id, req, res);
        return;
      }
      void orch
        .deleteIssue(id)
        .then((r) => this.json(res, 200, { deleted: true, issue_id: r.issue_id, issue_identifier: r.issue_identifier }))
        .catch((err) => this.json(res, this.actionStatus(err, 400), { error: { code: this.actionCode(err, "delete_failed"), message: String((err as Error).message ?? err) } }));
      return;
    }
    // Open a follow-up on an existing issue: same branch, same workspace, so review
    // work does not diverge onto a second branch (SPEC Appendix B.5). The parent comes
    // from the path, never the body, so the console cannot mis-address one.
    const followUpMatch = rest.match(/^\/issues\/([^/]+)\/follow-up$/);
    if (followUpMatch) {
      if (method !== "POST") return this.methodNotAllowed(res);
      if (!orch.canFollowUp()) {
        return this.json(res, 501, { error: { code: "not_supported", message: "tracker does not support follow-up issues" } });
      }
      void this.createIssue(orch, req, res, decodeURIComponent(followUpMatch[1]!));
      return;
    }
    const stateMatch = rest.match(/^\/issues\/([^/]+)\/state$/);
    if (stateMatch) {
      if (method !== "POST") return this.methodNotAllowed(res);
      if (!orch.canBoard()) {
        return this.json(res, 501, { error: { code: "not_supported", message: "tracker does not support changing state" } });
      }
      void this.setState(orch, decodeURIComponent(stateMatch[1]!), req, res);
      return;
    }
    const stopMatch = rest.match(/^\/issues\/([^/]+)\/stop$/);
    if (stopMatch) {
      if (method !== "POST") return this.methodNotAllowed(res);
      const id = decodeURIComponent(stopMatch[1]!);
      const halt = orch.stopIssue(id);
      if (!halt) {
        return this.json(res, 404, { error: { code: "nothing_to_stop", message: `issue ${id} has no running session or pending retry to stop` } });
      }
      return this.json(res, 200, { stopped: true, issue_id: id, issue_identifier: halt.identifier, attempts: halt.attempts, reason: halt.reason });
    }
    const pushMatch = rest.match(/^\/issues\/([^/]+)\/push-branch$/);
    if (pushMatch) {
      if (method !== "POST") return this.methodNotAllowed(res);
      const id = decodeURIComponent(pushMatch[1]!);
      void orch
        .pushIssueBranch(id)
        .then((r) => this.json(res, 200, { pushed: true, branch: r.branch, pushed_at: r.pushed_at }))
        .catch((err) => {
          // Distinguish "this project/issue can't be pushed" from "the push itself
          // failed", so the console can tell the operator which one it is.
          this.json(res, this.actionStatus(err, 409), { error: { code: this.actionCode(err, "push_failed"), message: String((err as Error).message ?? err) } });
        });
      return;
    }
    const agentMatch = rest.match(/^\/issues\/([^/]+)\/agent$/);
    if (agentMatch) {
      if (method !== "POST") return this.methodNotAllowed(res);
      void this.setIssueAgent(orch, decodeURIComponent(agentMatch[1]!), req, res);
      return;
    }
    if (rest === "/default-agent") {
      if (method !== "POST") return this.methodNotAllowed(res);
      void this.setDefaultAgent(orch, req, res);
      return;
    }
    // Installed-agent discovery (extension). Must sit above the catch-all issue
    // lookup below, which would otherwise read "agents" as an issue identifier.
    if (rest === "/agents" || rest === "/agents/refresh") {
      const refresh = rest.endsWith("/refresh");
      if (method !== (refresh ? "POST" : "GET")) return this.methodNotAllowed(res);
      // A re-check notifies, so every open console learns what this one found.
      void (refresh ? orch.refreshAgentDetection() : orch.agentAvailability())
        .then((view) => this.json(res, 200, view))
        .catch((err) => this.json(res, 500, { error: { code: "detect_failed", message: String(err) } }));
      return;
    }
    // Model discovery (extension, Appendix B.7). Above the issue lookup for the same
    // reason as /agents: otherwise "models" is read as an issue identifier.
    if (rest === "/models" || rest === "/models/refresh") {
      const refresh = rest.endsWith("/refresh");
      if (method !== (refresh ? "POST" : "GET")) return this.methodNotAllowed(res);
      // Optional ?kind= so the form can list the backend an issue actually pinned,
      // rather than always the effective default.
      const query = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).searchParams;
      const kind = query.get("kind") ?? undefined;
      void (refresh ? orch.refreshAgentModels(kind) : orch.agentModels(kind))
        .then((view) => this.json(res, 200, view))
        .catch((err) => this.json(res, 500, { error: { code: "models_failed", message: String(err) } }));
      return;
    }
    const m = rest.match(/^\/([^/]+)$/);
    if (m) {
      if (method !== "GET") return this.methodNotAllowed(res);
      const identifier = decodeURIComponent(m[1]!);
      void orch
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
  }

  /** Open a bounded project-scoped SSE stream. One orchestrator observer serves all clients. */
  private openEventStream(orch: Orchestrator, req: http.IncomingMessage, res: http.ServerResponse): void {
    const hub = this.sseHub(orch);
    if (hub.clients.size >= SSE_MAX_CLIENTS_PER_PROJECT) {
      this.json(res, 503, { error: { code: "events_at_capacity", message: "too many event-stream clients" } });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();

    const client: SseClient = { res, heartbeat: null, closed: false };
    hub.clients.add(client);
    const close = () => this.closeSseClient(orch, hub, client);
    req.once("aborted", close);
    res.once("close", close);
    client.heartbeat = setInterval(() => this.writeSse(client, ": heartbeat\n\n"), SSE_HEARTBEAT_MS);
    this.writeSseSnapshot(client, orch);
  }

  private sseHub(orch: Orchestrator): SseHub {
    const existing = this.sseHubs.get(orch);
    if (existing) return existing;
    const hub: SseHub = { clients: new Set(), unsubscribe: null, notifyTimer: null };
    hub.unsubscribe = orch.onChange(() => this.queueSseSnapshot(orch, hub));
    this.sseHubs.set(orch, hub);
    return hub;
  }

  private queueSseSnapshot(orch: Orchestrator, hub: SseHub): void {
    if (hub.notifyTimer) return;
    hub.notifyTimer = setTimeout(() => {
      hub.notifyTimer = null;
      for (const client of [...hub.clients]) this.writeSseSnapshot(client, orch);
    }, SSE_COALESCE_MS);
  }

  private writeSseSnapshot(client: SseClient, orch: Orchestrator): void {
    this.writeSse(client, `event: snapshot\ndata: ${JSON.stringify({ snapshot: orch.snapshot(), board_dirty: true })}\n\n`);
  }

  private writeSse(client: SseClient, payload: string): void {
    if (client.closed || client.res.destroyed || client.res.writableEnded) return;
    client.res.write(payload);
  }

  private closeSseClient(orch: Orchestrator, hub: SseHub, client: SseClient): void {
    if (client.closed) return;
    client.closed = true;
    if (client.heartbeat) clearInterval(client.heartbeat);
    client.heartbeat = null;
    hub.clients.delete(client);
    if (hub.clients.size !== 0) return;
    if (hub.notifyTimer) clearTimeout(hub.notifyTimer);
    hub.notifyTimer = null;
    hub.unsubscribe?.();
    hub.unsubscribe = null;
    this.sseHubs.delete(orch);
  }

  /** Serve a console asset from disk (no caching: dev edits show on refresh; files are tiny). */
  private async serveUi(pathname: string, res: http.ServerResponse): Promise<void> {
    const rel = decodeURIComponent(pathname.slice("/ui/".length));
    const vendor = rel.startsWith("vendor/lit-html/");
    const root = vendor ? LIT_ROOT : UI_ROOT;
    const sub = vendor ? rel.slice("vendor/lit-html/".length) : rel;
    const abs = path.resolve(root, sub);
    const inside = path.relative(root, abs);
    const type = UI_TYPES[path.extname(abs).toLowerCase()];
    if (!type || inside.startsWith("..") || path.isAbsolute(inside)) {
      return this.json(res, 404, { error: { code: "not_found", message: "no such asset" } });
    }
    try {
      const body = await fs.readFile(abs);
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
      res.end(body);
    } catch {
      this.json(res, 404, { error: { code: "not_found", message: "no such asset" } });
    }
  }

  private async addProject(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.opts.manager.canAdd()) {
      return this.json(res, 501, { error: { code: "not_supported", message: "adding projects requires a projects manifest" } });
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      return this.json(res, 400, { error: { code: "bad_request", message: "invalid JSON body" } });
    }
    const workflow = typeof body.workflow === "string" ? body.workflow.trim() : "";
    if (!workflow) return this.json(res, 400, { error: { code: "bad_request", message: "workflow path is required" } });
    try {
      const project = await this.opts.manager.add({
        name: typeof body.name === "string" ? body.name : undefined,
        workflow,
      });
      this.json(res, 201, { created: true, project });
    } catch (err) {
      this.json(res, 400, { error: { code: "add_failed", message: String((err as Error).message ?? err) } });
    }
  }

  /**
   * Create an issue. `parent` (from the `/issues/<id>/follow-up` route) makes it a
   * follow-up: it joins that issue's work stream and delivers onto the same branch
   * instead of cutting its own (SPEC Appendix B.5).
   */
  private async createIssue(orch: Orchestrator, req: http.IncomingMessage, res: http.ServerResponse, parent?: string): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      return this.json(res, 400, { error: { code: "bad_request", message: "invalid JSON body" } });
    }
    const followUpFor = parent ?? (typeof body.follow_up_for === "string" && body.follow_up_for.trim() !== "" ? body.follow_up_for.trim() : null);
    try {
      const issue = await orch.createIssue({
        follow_up_for: followUpFor,
        identifier: String(body.identifier ?? ""),
        title: String(body.title ?? ""),
        description: typeof body.description === "string" ? body.description : null,
        state: typeof body.state === "string" ? body.state : null,
        priority: typeof body.priority === "number" ? body.priority : body.priority != null ? Number(body.priority) : null,
        labels: Array.isArray(body.labels) ? body.labels.map(String) : [],
        agent: typeof body.agent === "string" && body.agent.trim() !== "" ? body.agent.trim() : null,
        model: typeof body.model === "string" && body.model.trim() !== "" ? body.model.trim() : null,
      });
      this.json(res, 201, {
        created: true,
        issue: {
          id: issue.id,
          identifier: issue.identifier,
          state: issue.state,
          follow_up_for: issue.follow_up_for,
          stream_identifier: issue.stream_identifier,
        },
      });
    } catch (err) {
      // An unknown parent or a tracker that cannot do follow-ups is not a malformed
      // request, so those keep their own status (404/501/409).
      this.json(res, this.actionStatus(err, 400), { error: { code: this.actionCode(err, "create_failed"), message: String((err as Error).message ?? err) } });
    }
  }

  /**
   * Amend an issue's editable fields. Only keys actually present in the body are
   * written, so a partial patch never blanks the fields the operator left alone.
   */
  private async updateIssue(orch: Orchestrator, id: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      return this.json(res, 400, { error: { code: "bad_request", message: "invalid JSON body" } });
    }
    const patch: IssuePatch = {};
    if ("title" in body) patch.title = String(body.title ?? "").trim();
    if ("description" in body) patch.description = typeof body.description === "string" ? body.description : null;
    if ("priority" in body) {
      const p = body.priority;
      if (p != null && p !== "" && typeof p !== "number" && typeof p !== "string") {
        return this.json(res, 400, { error: { code: "bad_request", message: "priority must be an integer or null" } });
      }
      patch.priority = p == null || p === "" ? null : Number(p);
    }
    if ("labels" in body) {
      if (!Array.isArray(body.labels)) {
        return this.json(res, 400, { error: { code: "bad_request", message: "labels must be an array" } });
      }
      patch.labels = body.labels.map(String);
    }
    // Free text on purpose — the backend validates model ids, we do not (Appendix B.7).
    // Blank means "clear it", which is how the form's default option comes back.
    if ("model" in body) {
      patch.model = typeof body.model === "string" && body.model.trim() !== "" ? body.model.trim() : null;
    }
    if (Object.keys(patch).length === 0) {
      return this.json(res, 400, { error: { code: "bad_request", message: "patch must set at least one of title, description, priority, labels, model" } });
    }
    if (patch.title !== undefined && patch.title === "") {
      return this.json(res, 400, { error: { code: "bad_request", message: "title cannot be blank" } });
    }
    if (patch.priority != null && !Number.isInteger(patch.priority)) {
      return this.json(res, 400, { error: { code: "bad_request", message: "priority must be an integer" } });
    }
    try {
      const issue = await orch.updateIssue(id, patch);
      this.json(res, 200, {
        updated: true,
        issue: { id: issue.id, identifier: issue.identifier, title: issue.title, priority: issue.priority, labels: issue.labels, model: issue.model },
      });
    } catch (err) {
      this.json(res, this.actionStatus(err, 400), { error: { code: this.actionCode(err, "update_failed"), message: String((err as Error).message ?? err) } });
    }
  }

  /** Map an operator-action failure onto a status: a live issue is a conflict, not a 5xx. */
  private actionStatus(err: unknown, fallback: number): number {
    if (!(err instanceof OrchestratorError)) return fallback;
    if (err.code === "not_supported") return 501;
    if (err.code === "not_found") return 404;
    if (err.code === "upstream_failed") return 502;
    if (err.code === "conflict") return 409;
    return fallback;
  }
  private actionCode(err: unknown, fallback: string): string {
    return err instanceof OrchestratorError ? err.code : fallback;
  }

  private async setState(orch: Orchestrator, id: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      return this.json(res, 400, { error: { code: "bad_request", message: "invalid JSON body" } });
    }
    const state = typeof body.state === "string" ? body.state : "";
    if (!state) return this.json(res, 400, { error: { code: "bad_request", message: "state is required" } });
    try {
      const issue = await orch.setIssueState(id, state);
      this.json(res, 200, { updated: true, issue: { id: issue.id, identifier: issue.identifier, state: issue.state } });
    } catch (err) {
      this.json(res, 400, { error: { code: "update_failed", message: String((err as Error).message ?? err) } });
    }
  }

  private async setIssueAgent(orch: Orchestrator, id: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      return this.json(res, 400, { error: { code: "bad_request", message: "invalid JSON body" } });
    }
    const agent = typeof body.agent === "string" ? body.agent : "";
    try {
      const issue = await orch.setIssueAgent(id, agent);
      this.json(res, 200, { updated: true, issue: { id: issue.id, identifier: issue.identifier, agent: issue.agent } });
    } catch (err) {
      this.json(res, 400, { error: { code: "update_failed", message: String((err as Error).message ?? err) } });
    }
  }

  private async setDefaultAgent(orch: Orchestrator, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      return this.json(res, 400, { error: { code: "bad_request", message: "invalid JSON body" } });
    }
    const kind = typeof body.kind === "string" ? body.kind : "";
    try {
      orch.setDefaultAgent(kind);
      this.json(res, 200, { updated: true, default_agent: orch.effectiveDefaultAgent() });
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

/**
 * Codex model discovery (extension, SPEC Appendix B.7). Symphony is not the source of
 * truth for model inventory — codex is — so this asks the app-server what it can run
 * and renders the answer. Nothing model-related lives in `WORKFLOW.md`.
 *
 * Verified against codex-cli 0.146.0 (same protocol `appServerClient.ts` speaks):
 * - `model/list` params `{cursor, includeHidden, limit}` → `{data[], nextCursor}`.
 *   Entries carry `id`, `model`, `displayName`, `description`, `hidden`, `isDefault`,
 *   `supportedReasoningEfforts`, `defaultReasoningEffort`. Five models in ~3 ms after a
 *   ~280 ms `initialize`.
 * - `config/read` → `{config: {model, …}}` in snake_case; `config.model` is the
 *   effective default for this host.
 * - Two verified traps drive the shape of this module:
 *   1. `isDefault` is codex's *newest* model, not the configured one — it reported
 *      `gpt-5.6-terra` while `config.model` was `gpt-5.5`. Reporting it as the default
 *      would name a model dispatch does not use (M12's `2d9274d`, same bug on kinds).
 *   2. A bad `CODEX_HOME` makes `initialize` hang forever rather than fail — 25 s with
 *      no reply, only a stderr warning. Hence a wall-clock deadline and a killed child,
 *      not a try/catch.
 *
 * `codex debug models` also lists models, but it is a debug subcommand that ships the
 * full system prompt of every model (~240 KB) and exposes hidden entries. The typed
 * protocol above is the interface; that is not.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnShell } from "../shell.ts";
import type { AgentModel, ModelQuery } from "./types.ts";

/** Wall-clock budget for the whole probe: spawn, initialize, config/read, model/list. */
const DISCOVERY_TIMEOUT_MS = 15000;
/** Pagination guard — the verified listing is one page, this only bounds a bad cursor. */
const MAX_PAGES = 20;

interface ModelListEntry {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  hidden?: unknown;
  isDefault?: unknown;
}

/** Enumerate the models codex can run on this host. Never throws; `[]` on any failure. */
export async function listCodexModels(query: ModelQuery): Promise<AgentModel[]> {
  const conn = new Probe(query);
  try {
    return await conn.run();
  } catch (err) {
    query.logger.warn("codex model discovery failed", { error: String(err) });
    return [];
  } finally {
    conn.dispose();
  }
}

/** One short-lived app-server connection used for discovery only — no thread, no turn. */
class Probe {
  private query: ModelQuery;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private disposed = false;
  private deadline: NodeJS.Timeout | null = null;

  constructor(query: ModelQuery) {
    this.query = query;
  }

  async run(): Promise<AgentModel[]> {
    const { child } = spawnShell(this.query.config.codex.command, this.query.config.workflowDir, this.query.env);
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => this.onData(d));
    // codex warns on stderr about things that do not stop it (PATH aliases, CODEX_HOME).
    // Discovery has no use for them beyond a debug breadcrumb.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      const t = d.trim();
      if (t) this.query.logger.debug("codex model discovery stderr", { text: t.slice(0, 300) });
    });
    child.on("exit", () => this.failAll(new Error("codex app-server exited during model discovery")));
    child.on("error", (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));

    // One deadline for the whole probe: the verified failure is a silent hang, so an
    // unanswered request must still tear the process down.
    const timeout = new Promise<never>((_, reject) => {
      this.deadline = setTimeout(() => {
        this.failAll(new Error(`codex model discovery timed out after ${DISCOVERY_TIMEOUT_MS}ms`));
        reject(new Error(`codex model discovery timed out after ${DISCOVERY_TIMEOUT_MS}ms`));
      }, DISCOVERY_TIMEOUT_MS);
    });

    return Promise.race([this.collect(), timeout]);
  }

  private async collect(): Promise<AgentModel[]> {
    await this.request("initialize", {
      clientInfo: { name: "symphony", version: "1.0.0", title: "Symphony" },
    });

    // Ask what this host is actually configured to run before listing, so `default`
    // describes dispatch rather than codex's newest release. See the file header.
    let configured: string | null = null;
    try {
      const cfg = (await this.request("config/read", {})) as { config?: { model?: unknown } };
      const m = cfg?.config?.model;
      if (typeof m === "string" && m.trim() !== "") configured = m.trim();
    } catch (err) {
      // A default we cannot resolve is a missing flag, not a failed discovery.
      this.query.logger.debug("codex config/read failed during model discovery", { error: String(err) });
    }

    const entries: ModelListEntry[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = (await this.request("model/list", cursor ? { cursor } : {})) as {
        data?: unknown;
        nextCursor?: unknown;
      };
      if (Array.isArray(res?.data)) entries.push(...(res.data as ModelListEntry[]));
      cursor = typeof res?.nextCursor === "string" && res.nextCursor !== "" ? res.nextCursor : null;
      if (!cursor) break;
    }

    return toAgentModels(entries, configured);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.disposed || !this.child) return reject(new Error("model discovery connection is closed"));
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line === "") continue;
      let msg: { id?: unknown; result?: unknown; error?: { message?: unknown } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not protocol traffic; discovery ignores it
      }
      if (typeof msg.id !== "number") continue;
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(String(msg.error.message ?? "app-server error")));
      else waiter.resolve(msg.result);
    }
  }

  private failAll(err: Error): void {
    for (const [, waiter] of this.pending) waiter.reject(err);
    this.pending.clear();
  }

  /** Kill the child and release the deadline. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.deadline) clearTimeout(this.deadline);
    this.failAll(new Error("model discovery finished"));
    this.child?.kill();
    this.child = null;
  }
}

/**
 * Map raw `model/list` entries onto {@link AgentModel} (pure, exported for tests).
 * Hidden entries are dropped — codex marks internal models (`codex-auto-review`) that
 * an operator has no business selecting.
 */
export function toAgentModels(entries: ModelListEntry[], configuredDefault: string | null): AgentModel[] {
  const models: AgentModel[] = [];
  for (const e of entries) {
    if (e?.hidden === true) continue;
    const id = typeof e?.id === "string" && e.id !== "" ? e.id : typeof e?.model === "string" ? e.model : null;
    if (!id) continue;
    const model: AgentModel = { id };
    if (typeof e.displayName === "string" && e.displayName !== "") model.label = e.displayName;
    models.push(model);
  }

  if (configuredDefault) {
    // The configured model is the honest default even when codex does not list it —
    // dispatch will still use it, so the console must show it rather than silently
    // promoting a different one.
    const hit = models.find((m) => m.id === configuredDefault);
    if (hit) hit.default = true;
    else models.unshift({ id: configuredDefault, label: `${configuredDefault} (from codex config)`, default: true });
    return models;
  }

  // Nothing configured: codex falls back to its own built-in default, and `isDefault`
  // is precisely that. Here — and only here — it describes what dispatch would run.
  const builtin = entries.find((e) => e?.isDefault === true && e?.hidden !== true);
  const builtinId = typeof builtin?.id === "string" ? builtin.id : null;
  if (builtinId) {
    const hit = models.find((m) => m.id === builtinId);
    if (hit) hit.default = true;
  }
  return models;
}

/**
 * Config Layer (SPEC §5.3, §6). Typed getters over WorkflowDefinition.config with
 * built-in defaults, `$VAR` indirection, and path normalization. Coercion errors
 * are surfaced as ConfigError.
 */
import os from "node:os";
import path from "node:path";
import type { WorkflowDefinition } from "../domain/types.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface TrackerConfig {
  kind: string;
  provider: Record<string, unknown>;
  required_labels: string[];
  active_states: string[];
  terminal_states: string[];
  /**
   * OPTIONAL parking states that are neither dispatched nor terminal (e.g. "backlog").
   * The scheduler already ignores any state not in active_states; listing them here
   * only tells the console which states to offer and where new issues should land.
   */
  backlog_states: string[];
}

export interface HooksConfig {
  after_create: string | null;
  before_run: string | null;
  after_run: string | null;
  before_remove: string | null;
  timeout_ms: number;
}

export interface CodexConfig {
  command: string;
  approval_policy: unknown;
  thread_sandbox: unknown;
  turn_sandbox_policy: unknown;
  turn_timeout_ms: number;
  read_timeout_ms: number;
  stall_timeout_ms: number;
}

/**
 * opencode backend config (SPEC §10 generalized; see src/agent/opencodeSession.ts).
 * `command` is the opencode executable base (the ` run …` subcommand + flags are
 * appended by the session); `model` is an optional `provider/model` override; the
 * turn timeout bounds a single `opencode run` invocation.
 */
export interface OpencodeConfig {
  command: string;
  model: string | null;
  turn_timeout_ms: number;
}

export interface ServiceConfigValues {
  workflowDir: string;
  tracker: TrackerConfig;
  poll_interval_ms: number;
  workspace_root: string;
  hooks: HooksConfig;
  /** Selected agent backend (SPEC §10 generalized). Default "codex". */
  agent_kind: string;
  max_concurrent_agents: number;
  max_turns: number;
  max_retry_backoff_ms: number;
  max_concurrent_agents_by_state: Record<string, number>;
  codex: CodexConfig;
  opencode: OpencodeConfig;
  server_port: number | null;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Expand `$VAR` / `${VAR}` from the environment. Empty resolution => missing (SPEC §5.3.1). */
export function expandVars(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
    const name = a ?? b;
    return process.env[name] ?? "";
  });
}

/** Expand `~` home and `$VAR` for filesystem path values only (SPEC §6.1). */
export function expandPath(value: string): string {
  let v = expandVars(value);
  if (v === "~") v = os.homedir();
  else if (v.startsWith("~/") || v.startsWith("~\\")) v = path.join(os.homedir(), v.slice(2));
  return v;
}

function coerceInt(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value));
  }
  throw new ConfigError(`${field} must be an integer, got ${JSON.stringify(value)}`);
}

function coerceStringList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [];
  return value.map((x) => String(x));
}

/**
 * Build the typed ServiceConfig from a parsed workflow, resolving relative to the
 * directory that contains the WORKFLOW.md file (SPEC §5.3.3, §6.1).
 */
export function buildConfig(def: WorkflowDefinition, workflowFilePath: string): ServiceConfigValues {
  const cfg = def.config;
  const workflowDir = path.dirname(path.resolve(workflowFilePath));

  const trackerRaw = asObject(cfg.tracker);
  const tracker: TrackerConfig = {
    kind: typeof trackerRaw.kind === "string" ? trackerRaw.kind : "",
    provider: asObject(trackerRaw.provider),
    required_labels: coerceStringList(trackerRaw.required_labels),
    active_states: coerceStringList(trackerRaw.active_states),
    terminal_states: coerceStringList(trackerRaw.terminal_states),
    backlog_states: coerceStringList(trackerRaw.backlog_states),
  };

  const polling = asObject(cfg.polling);
  const poll_interval_ms = polling.interval_ms !== undefined ? coerceInt(polling.interval_ms, "polling.interval_ms") : 30000;

  const workspace = asObject(cfg.workspace);
  let rootRaw = typeof workspace.root === "string" && workspace.root.trim() !== ""
    ? workspace.root
    : path.join(os.tmpdir(), "symphony_workspaces");
  rootRaw = expandPath(rootRaw);
  const workspace_root = path.isAbsolute(rootRaw) ? path.normalize(rootRaw) : path.normalize(path.join(workflowDir, rootRaw));

  const hooksRaw = asObject(cfg.hooks);
  const hookStr = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
  const hooks: HooksConfig = {
    after_create: hookStr(hooksRaw.after_create),
    before_run: hookStr(hooksRaw.before_run),
    after_run: hookStr(hooksRaw.after_run),
    before_remove: hookStr(hooksRaw.before_remove),
    timeout_ms: hooksRaw.timeout_ms !== undefined ? coerceInt(hooksRaw.timeout_ms, "hooks.timeout_ms") : 60000,
  };
  if (hooks.timeout_ms <= 0) throw new ConfigError("hooks.timeout_ms must be positive");

  const agent = asObject(cfg.agent);
  const agent_kind = typeof agent.kind === "string" && agent.kind.trim() !== "" ? agent.kind.trim() : "codex";
  const max_concurrent_agents = agent.max_concurrent_agents !== undefined ? coerceInt(agent.max_concurrent_agents, "agent.max_concurrent_agents") : 10;
  const max_turns = agent.max_turns !== undefined ? coerceInt(agent.max_turns, "agent.max_turns") : 20;
  if (max_turns <= 0) throw new ConfigError("agent.max_turns must be a positive integer");
  const max_retry_backoff_ms = agent.max_retry_backoff_ms !== undefined ? coerceInt(agent.max_retry_backoff_ms, "agent.max_retry_backoff_ms") : 300000;

  const max_concurrent_agents_by_state: Record<string, number> = {};
  const byState = asObject(agent.max_concurrent_agents_by_state);
  for (const [k, v] of Object.entries(byState)) {
    const key = k.trim().toLowerCase();
    if (key === "") continue;
    let n: number;
    try {
      n = coerceInt(v, "x");
    } catch {
      continue; // ignore non-numeric (SPEC §5.3.5)
    }
    if (n > 0) max_concurrent_agents_by_state[key] = n;
  }

  const codexRaw = asObject(cfg.codex);
  const codex: CodexConfig = {
    command: typeof codexRaw.command === "string" && codexRaw.command.trim() !== "" ? codexRaw.command : "codex app-server",
    approval_policy: codexRaw.approval_policy ?? "never",
    thread_sandbox: codexRaw.thread_sandbox ?? "danger-full-access",
    turn_sandbox_policy: codexRaw.turn_sandbox_policy ?? { type: "dangerFullAccess" },
    turn_timeout_ms: codexRaw.turn_timeout_ms !== undefined ? coerceInt(codexRaw.turn_timeout_ms, "codex.turn_timeout_ms") : 3600000,
    read_timeout_ms: codexRaw.read_timeout_ms !== undefined ? coerceInt(codexRaw.read_timeout_ms, "codex.read_timeout_ms") : 5000,
    stall_timeout_ms: codexRaw.stall_timeout_ms !== undefined ? coerceInt(codexRaw.stall_timeout_ms, "codex.stall_timeout_ms") : 300000,
  };

  const opencodeRaw = asObject(cfg.opencode);
  const opencode: OpencodeConfig = {
    command: typeof opencodeRaw.command === "string" && opencodeRaw.command.trim() !== "" ? opencodeRaw.command : "opencode",
    model: typeof opencodeRaw.model === "string" && opencodeRaw.model.trim() !== "" ? opencodeRaw.model.trim() : null,
    turn_timeout_ms: opencodeRaw.turn_timeout_ms !== undefined ? coerceInt(opencodeRaw.turn_timeout_ms, "opencode.turn_timeout_ms") : 3600000,
  };

  const server = asObject(cfg.server);
  const server_port = server.port !== undefined ? coerceInt(server.port, "server.port") : null;

  return {
    workflowDir,
    tracker,
    poll_interval_ms,
    workspace_root,
    hooks,
    agent_kind,
    max_concurrent_agents,
    max_turns,
    max_retry_backoff_ms,
    max_concurrent_agents_by_state,
    codex,
    opencode,
    server_port,
  };
}

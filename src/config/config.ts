/**
 * Config Layer (SPEC §5.3, §6). Typed getters over WorkflowDefinition.config with
 * built-in defaults, `$VAR` indirection, and path normalization. Coercion errors
 * are surfaced as ConfigError.
 */
import os from "node:os";
import path from "node:path";
import type { WorkflowDefinition } from "../domain/types.ts";
import { EMPTY_PRICING } from "../history/cost.ts";
import type { AgentPricing, PricingTable } from "../history/cost.ts";

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
  /**
   * Review state (extension): on `workspace.repository` projects, an issue whose
   * run reaches the first terminal state is moved here instead, with its delivery
   * (branch, commit, files) recorded. It MUST NOT be listed in active_states or
   * terminal_states — it parks the issue for operator review until it is moved to
   * a real terminal state (e.g. via the console's Mark done).
   */
  review_state: string;
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
  workspace_repository: string | null;
  /**
   * Repository delivery settings (extension; only meaningful when
   * workspace_repository is set):
   * - base_branch: ref issue branches are cut from (null = the repo's current HEAD).
   * - branch_template: issue branch naming rule; must contain "{identifier}".
   * - delivery_mode: "branch" (local only), or "push"/"pr", which expose a Push
   *   action in the console. "pr" is currently a forward declaration and behaves
   *   exactly like "push": Symphony never opens a pull request itself.
   */
  workspace_base_branch: string | null;
  workspace_branch_template: string;
  workspace_delivery_mode: string;
  hooks: HooksConfig;
  /** Selected agent backend (SPEC §10 generalized). Default "codex". */
  agent_kind: string;
  max_concurrent_agents: number;
  max_turns: number;
  max_retry_backoff_ms: number;
  /** Failure-retry cap (extension): give up after this many attempts. 0 = unlimited. */
  max_retry_attempts: number;
  max_concurrent_agents_by_state: Record<string, number>;
  /**
   * Token pricing (extension): rates per million tokens, either flat or per agent
   * kind. Unset leaves every derived cost null — token counts are still reported.
   */
  agent_pricing: PricingTable;
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

/** Like coerceInt but without truncation — prices are fractional (SPEC Appendix B). */
function coerceNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new ConfigError(`${field} must be a number, got ${JSON.stringify(value)}`);
}

function coerceStringList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [];
  return value.map((x) => String(x));
}

function parsePricingEntry(raw: Record<string, unknown>, field: string): AgentPricing {
  // A half-written entry is a typo, not a free half of the run.
  if (raw.input_per_mtok === undefined || raw.output_per_mtok === undefined) {
    throw new ConfigError(`${field} must set both input_per_mtok and output_per_mtok`);
  }
  const input_per_mtok = coerceNumber(raw.input_per_mtok, `${field}.input_per_mtok`);
  const output_per_mtok = coerceNumber(raw.output_per_mtok, `${field}.output_per_mtok`);
  if (input_per_mtok < 0) throw new ConfigError(`${field}.input_per_mtok must be >= 0`);
  if (output_per_mtok < 0) throw new ConfigError(`${field}.output_per_mtok must be >= 0`);
  const currency = typeof raw.currency === "string" && raw.currency.trim() !== "" ? raw.currency.trim() : "USD";
  return { input_per_mtok, output_per_mtok, currency };
}

/**
 * Parse `agent.pricing` (extension). Two forms, which may be combined: the rate keys
 * directly on the map apply to every agent kind, and any object-valued key names a
 * kind whose own rates override the flat ones. Unknown kinds are not validated here
 * — config has no view of the agent registry; a typo simply leaves that kind
 * unpriced, which the console reports rather than hides.
 */
function parsePricing(raw: unknown): PricingTable {
  const map = asObject(raw);
  const keys = Object.keys(map);
  if (keys.length === 0) return EMPTY_PRICING;

  const flat = map.input_per_mtok !== undefined || map.output_per_mtok !== undefined;
  const table: PricingTable = {
    default: flat ? parsePricingEntry(map, "agent.pricing") : null,
    by_kind: {},
  };
  for (const key of keys) {
    if (key === "input_per_mtok" || key === "output_per_mtok" || key === "currency") continue;
    const value = map[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue; // ignore stray scalars
    const kind = key.trim().toLowerCase();
    if (kind === "") continue;
    table.by_kind[kind] = parsePricingEntry(value as Record<string, unknown>, `agent.pricing.${key}`);
  }

  // Summing across currencies would be meaningless, so refuse the config outright.
  const currencies = [...new Set([table.default, ...Object.values(table.by_kind)].filter((p) => p !== null).map((p) => p!.currency))];
  if (currencies.length > 1) {
    throw new ConfigError(`agent.pricing entries must all use the same currency (found ${currencies.join(", ")})`);
  }
  return table;
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
    review_state: typeof trackerRaw.review_state === "string" && trackerRaw.review_state.trim() !== "" ? trackerRaw.review_state.trim() : "review",
  };
  const norm = (s: string) => s.trim().toLowerCase();
  const reviewClash = [...tracker.active_states, ...tracker.terminal_states, ...tracker.backlog_states]
    .some((s) => norm(s) === norm(tracker.review_state));
  if (reviewClash) {
    throw new ConfigError("tracker.review_state must not appear in active_states, terminal_states or backlog_states");
  }

  const polling = asObject(cfg.polling);
  const poll_interval_ms = polling.interval_ms !== undefined ? coerceInt(polling.interval_ms, "polling.interval_ms") : 30000;

  const workspace = asObject(cfg.workspace);
  let rootRaw = typeof workspace.root === "string" && workspace.root.trim() !== ""
    ? workspace.root
    : path.join(os.tmpdir(), "symphony_workspaces");
  rootRaw = expandPath(rootRaw);
  const workspace_root = path.isAbsolute(rootRaw) ? path.normalize(rootRaw) : path.normalize(path.join(workflowDir, rootRaw));
  const repositoryRaw = typeof workspace.repository === "string" && workspace.repository.trim() !== "" ? expandPath(workspace.repository) : null;
  const workspace_repository = repositoryRaw === null
    ? null
    : path.isAbsolute(repositoryRaw) ? path.normalize(repositoryRaw) : path.normalize(path.join(workflowDir, repositoryRaw));
  const workspace_base_branch = typeof workspace.base_branch === "string" && workspace.base_branch.trim() !== "" ? workspace.base_branch.trim() : null;
  const workspace_branch_template = typeof workspace.branch_template === "string" && workspace.branch_template.trim() !== "" ? workspace.branch_template.trim() : "issue/{identifier}";
  if (!workspace_branch_template.includes("{identifier}")) {
    throw new ConfigError('workspace.branch_template must contain the "{identifier}" placeholder');
  }
  const workspace_delivery_mode = typeof workspace.delivery_mode === "string" && workspace.delivery_mode.trim() !== "" ? workspace.delivery_mode.trim().toLowerCase() : "branch";
  if (!["branch", "push", "pr"].includes(workspace_delivery_mode)) {
    throw new ConfigError('workspace.delivery_mode must be one of "branch", "push", "pr"');
  }

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
  const max_retry_attempts = agent.max_retry_attempts !== undefined ? coerceInt(agent.max_retry_attempts, "agent.max_retry_attempts") : 3;
  if (max_retry_attempts < 0) throw new ConfigError("agent.max_retry_attempts must be >= 0 (0 = unlimited)");

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

  const agent_pricing = parsePricing(agent.pricing);

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
    workspace_repository,
    workspace_base_branch,
    workspace_branch_template,
    workspace_delivery_mode,
    hooks,
    agent_kind,
    max_concurrent_agents,
    max_turns,
    max_retry_backoff_ms,
    max_retry_attempts,
    max_concurrent_agents_by_state,
    agent_pricing,
    codex,
    opencode,
    server_port,
  };
}

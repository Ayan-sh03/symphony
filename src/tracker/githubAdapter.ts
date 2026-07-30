/**
 * GitHub Tracker Adapter (`kind: "github"`). Issues live in a GitHub repository and
 * are read/written over the REST API with the global stdlib `fetch` — no SDK.
 *
 * Adapter profile (SPEC §11.2):
 * - tracker.kind: "github"
 * - tracker.provider keys:
 *     - `owner` (string, required)      — repository owner (user or org)
 *     - `repo` (string, required)       — repository name
 *     - `token_env` (string, required)  — name of the env var holding the PAT
 *     - `api_base` (string, optional)   — default "https://api.github.com"
 *   `secretEnvironmentNames()` returns [token_env], so the PAT is stripped from the
 *   child agent's environment (SPEC §10.4) — tools run host-side, never in the agent.
 *
 * State model. GitHub has no per-issue state field beyond open/closed, so a Symphony
 * state is represented by **exactly one label named `sym:<state>`** — `sym:todo`,
 * `sym:in progress`, `sym:review`, … The mapping is:
 * - `sym:<state>` label      -> that state.
 * - open, no `sym:*` label   -> `backlog`. Deliberately conservative: an unlabelled
 *   issue is somebody else's, and backlog is (by convention) not an active state, so
 *   a stray repo issue can never be picked up and dispatched by accident.
 * - closed                   -> terminal. The `sym:*` state is kept when it is itself
 *   terminal (so a cancellation survives), otherwise it normalizes to `done`.
 * `setIssueState` removes every existing `sym:*` label, adds the target one, and
 * closes or reopens the GitHub issue to match.
 *
 * Terminal detection is adapter-local (`TERMINAL_STATES`): the adapter only receives
 * `tracker.provider`, never the surrounding `tracker.terminal_states`, and the
 * registry/orchestrator signatures are fixed by the SPEC. The local set is
 * conservative — done/canceled/cancelled/closed — and only decides open-vs-closed on
 * write plus the closed-issue fallback; the orchestrator still applies the workflow's
 * own state lists to everything it reads.
 *
 * Normalization (SPEC §11.3):
 * - `GH-<number>` -> identifier; `node_id` (falling back to the number) -> id.
 * - Labels are lowercased; the `sym:*` state label is *not* carried in `labels` —
 *   it is state, and Symphony models those separately.
 * - Pull requests (records carrying `pull_request`) are ignored: the issues endpoint
 *   returns both, and a PR is not a work item.
 * - native_ref: { owner, repo, number, node_id, html_url }.
 * - A malformed provider payload raises `tracker_response`.
 *
 * Provider-native tools (SPEC §10.5, mutate tracker state, executed host-side):
 * - `update_issue_state({state, comment?})`
 * - `add_issue_comment({comment})`
 * - `set_issue_result({state?, comment?, pr_url?, tests?})`
 *
 * Errors map to AdapterError{category,message}: invalid_tracker_config,
 * missing_tracker_secret, tracker_request (network/auth/rate-limit),
 * tracker_response (malformed body), tracker_pagination (bad Link header).
 */
import type { Issue } from "../domain/types.ts";
import type { Logger } from "../logger.ts";
import {
  AdapterError,
  type TrackerAdapter,
  type ToolContext,
  type ToolResult,
  type ToolSpec,
  type NewIssueInput,
} from "./types.ts";

const DEFAULT_API_BASE = "https://api.github.com";
const STATE_LABEL_PREFIX = "sym:";
/** Adapter-local terminal set; see the header note on why this is not read from config. */
const TERMINAL_STATES = new Set(["done", "canceled", "cancelled", "closed"]);
/** Fallback state for a closed issue whose `sym:*` label is missing or non-terminal. */
const CLOSED_FALLBACK_STATE = "done";
/** State for an open issue with no `sym:*` label — never dispatched by convention. */
const UNLABELLED_STATE = "backlog";

interface GitHubAdapterOptions {
  owner: string;
  repo: string;
  tokenEnv: string;
  apiBase: string;
  logger: Logger;
}

interface GitHubResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

export class GitHubTrackerAdapter implements TrackerAdapter {
  readonly kind = "github";
  private owner: string;
  private repo: string;
  private tokenEnv: string;
  private apiBase: string;
  private logger: Logger;

  constructor(opts: GitHubAdapterOptions) {
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.tokenEnv = opts.tokenEnv;
    this.apiBase = opts.apiBase;
    this.logger = opts.logger;
  }

  /** Build the adapter from effective tracker.provider config (SPEC §11.2 construction). */
  static create(provider: Record<string, unknown>, _workflowDir: string, logger: Logger): GitHubTrackerAdapter {
    GitHubTrackerAdapter.validate(provider);
    const apiBase = str(provider.api_base) || DEFAULT_API_BASE;
    return new GitHubTrackerAdapter({
      owner: str(provider.owner),
      repo: str(provider.repo),
      tokenEnv: str(provider.token_env),
      apiBase: apiBase.replace(/\/+$/, ""),
      logger,
    });
  }

  /** Validate config eagerly for dispatch preflight (SPEC §6.3). */
  static validate(provider: Record<string, unknown>): void {
    for (const key of ["owner", "repo", "token_env"]) {
      const value = provider[key];
      if (typeof value !== "string" || value.trim() === "") {
        throw new AdapterError("invalid_tracker_config", `tracker.provider.${key} is required (non-empty string)`);
      }
    }
    if (provider.api_base !== undefined && (typeof provider.api_base !== "string" || provider.api_base.trim() === "")) {
      throw new AdapterError("invalid_tracker_config", "tracker.provider.api_base must be a non-empty string URL");
    }
  }

  secretEnvironmentNames(): string[] {
    return [this.tokenEnv];
  }

  // ---- HTTP ----

  private token(): string {
    const token = process.env[this.tokenEnv];
    if (!token || token.trim() === "") {
      throw new AdapterError("missing_tracker_secret", `environment variable ${this.tokenEnv} is unset or empty`);
    }
    return token.trim();
  }

  /**
   * One GitHub REST call. Network faults, auth failures and rate limits all surface as
   * `tracker_request`; a body that is not the expected JSON shape is `tracker_response`.
   */
  private async request(method: string, url: string, body?: unknown): Promise<GitHubResponse> {
    const token = this.token();
    const target = url.startsWith("http") ? url : `${this.apiBase}${url}`;
    let res: Response;
    try {
      res = await fetch(target, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "symphony-tracker",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new AdapterError("tracker_request", `${method} ${target} failed: ${(err as Error).message}`, true);
    }

    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (res.ok) throw new AdapterError("tracker_response", `${method} ${target} returned non-JSON body`);
        parsed = null;
      }
    }

    if (!res.ok) throw this.httpError(method, target, res, parsed);
    return { status: res.status, headers: res.headers, body: parsed };
  }

  /** Map a non-2xx response onto an AdapterError, keeping GitHub's own message. */
  private httpError(method: string, target: string, res: Response, parsed: unknown): AdapterError {
    const detail = str((parsed as Record<string, unknown> | null)?.message) || res.statusText || "";
    const where = `${method} ${target} -> ${res.status}`;
    const retryAfter = res.headers.get("retry-after");
    // Secondary rate limits answer 403 + Retry-After; primary ones exhaust the
    // remaining quota. Both are worth retrying, unlike a plain permission denial.
    const rateLimited = retryAfter !== null || res.headers.get("x-ratelimit-remaining") === "0";
    if (rateLimited) {
      const wait = retryAfter ? ` retry-after=${retryAfter}s` : "";
      return new AdapterError("tracker_request", `${where} rate limited${wait}: ${detail}`, true);
    }
    if (res.status === 401 || res.status === 403) {
      return new AdapterError("tracker_request", `${where} unauthorized (check ${this.tokenEnv}): ${detail}`);
    }
    return new AdapterError("tracker_request", `${where}: ${detail}`);
  }

  /** GET every page of the repo's issues, following `Link: <…>; rel="next"`. */
  private async listRawIssues(): Promise<Record<string, unknown>[]> {
    let url = `/repos/${enc(this.owner)}/${enc(this.repo)}/issues?state=all&per_page=100`;
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    while (true) {
      if (seen.has(url)) throw new AdapterError("tracker_pagination", `pagination loop at ${url}`);
      seen.add(url);
      const res = await this.request("GET", url);
      if (!Array.isArray(res.body)) {
        throw new AdapterError("tracker_response", `expected an array of issues from ${url}`);
      }
      for (const rec of res.body) {
        if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
          throw new AdapterError("tracker_response", `malformed issue record in response from ${url}`);
        }
        out.push(rec as Record<string, unknown>);
      }
      const next = nextLink(res.headers.get("link"));
      if (!next) return out;
      url = next;
    }
  }

  /** Every issue in the repo, normalized; pull requests dropped. */
  private async listIssues(): Promise<Issue[]> {
    const out: Issue[] = [];
    for (const raw of await this.listRawIssues()) {
      if (raw.pull_request !== undefined) continue; // the issues endpoint also returns PRs
      out.push(this.normalize(raw));
    }
    return out;
  }

  /**
   * Map a GitHub issue payload onto the domain model (SPEC §11.3). A payload that
   * cannot yield the required fields is a provider fault, not a skippable record.
   */
  private normalize(raw: Record<string, unknown>): Issue {
    const number = raw.number;
    if (typeof number !== "number" || !Number.isInteger(number)) {
      throw new AdapterError("tracker_response", "issue payload is missing an integer 'number'");
    }
    const title = str(raw.title);
    if (!title) throw new AdapterError("tracker_response", `issue #${number} is missing a title`);
    const ghState = str(raw.state).toLowerCase();
    if (ghState !== "open" && ghState !== "closed") {
      throw new AdapterError("tracker_response", `issue #${number} has an unknown state: ${ghState || "(empty)"}`);
    }

    const { labels, state: labelState, stateLabels } = splitLabels(raw.labels, number);
    let state = labelState;
    if (ghState === "closed") {
      // Closed is terminal by definition; keep an explicitly terminal label so a
      // cancellation is not rewritten as success.
      if (!state || !TERMINAL_STATES.has(state)) state = CLOSED_FALLBACK_STATE;
    } else if (!state) {
      state = UNLABELLED_STATE;
    }

    const nodeId = str(raw.node_id);
    const htmlUrl = str(raw.html_url) || null;
    return {
      id: nodeId || String(number),
      native_ref: {
        owner: this.owner,
        repo: this.repo,
        number,
        node_id: nodeId || null,
        html_url: htmlUrl,
        // The literal `sym:*` label names as they exist on the issue. `state` above is
        // normalized (a closed issue reads as `done` whatever its label said), so the
        // raw names are what a transition must actually delete.
        state_labels: stateLabels,
      },
      identifier: `GH-${number}`,
      title,
      description: typeof raw.body === "string" && raw.body.trim() !== "" ? raw.body : null,
      priority: null,
      state,
      branch_name: null,
      url: htmlUrl,
      assignee_id: str((raw.assignee as Record<string, unknown> | null)?.login) || null,
      labels,
      blocked_by: [],
      dispatchable: true,
      agent: null,
      follow_up_for: null,
      stream_identifier: null,
      delivery: null,
      created_at: str(raw.created_at) || null,
      updated_at: str(raw.updated_at) || null,
    };
  }

  // ---- read kernel (SPEC §11.1) ----

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return []; // SPEC §11.1: empty => empty, no request
    const wanted = new Set(stateNames.map((s) => s.trim().toLowerCase()));
    return (await this.listIssues()).filter((i) => wanted.has(i.state.trim().toLowerCase()));
  }

  /**
   * Refresh by dispatch id. The ids are `node_id`s, which no REST endpoint accepts in
   * place of an issue number, so this lists and filters rather than fetching each one.
   */
  async fetchIssuesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return []; // SPEC §11.1: empty => empty, no request
    const wanted = new Set(issueIds);
    return (await this.listIssues()).filter((i) => wanted.has(i.id));
  }

  // ---- board capability (extension) ----

  supportsBoard(): boolean {
    return true;
  }

  async listAllIssues(): Promise<Issue[]> {
    return this.listIssues();
  }

  /**
   * Move an issue to a new Symphony state: swap the `sym:*` label and align GitHub's
   * own open/closed flag with the target's terminality.
   */
  async setIssueState(id: string, state: string): Promise<Issue> {
    const target = str(state);
    if (!target) throw new AdapterError("invalid_tracker_config", "state is required");
    const issue = await this.findById(id);
    await this.applyState(numberOf(issue), issue, target);
    return this.refresh(id);
  }

  /** Replace the state label on an issue and open/close it to match. */
  private async applyState(number: number, current: Issue | null, state: string): Promise<void> {
    const wanted = STATE_LABEL_PREFIX + state.toLowerCase();
    const existing = current ? stateLabelsOf(current) : [];
    // GitHub label names are case-insensitive for matching but the DELETE path needs
    // the literal name, so compare folded and delete verbatim.
    for (const label of existing) {
      if (label.toLowerCase() === wanted) continue;
      await this.request("DELETE", `/repos/${enc(this.owner)}/${enc(this.repo)}/issues/${number}/labels/${enc(label)}`);
    }
    if (!existing.some((l) => l.toLowerCase() === wanted)) {
      await this.request("POST", `/repos/${enc(this.owner)}/${enc(this.repo)}/issues/${number}/labels`, {
        labels: [wanted],
      });
    }
    await this.request("PATCH", `/repos/${enc(this.owner)}/${enc(this.repo)}/issues/${number}`, {
      state: TERMINAL_STATES.has(state.toLowerCase()) ? "closed" : "open",
    });
  }

  private async addComment(number: number, comment: string): Promise<void> {
    await this.request("POST", `/repos/${enc(this.owner)}/${enc(this.repo)}/issues/${number}/comments`, {
      body: comment,
    });
  }

  private async findById(id: string): Promise<Issue> {
    const found = (await this.listIssues()).find((i) => i.id === id);
    if (!found) throw new AdapterError("tracker_response", `issue ${id} not found in ${this.owner}/${this.repo}`);
    return found;
  }

  private async refresh(id: string): Promise<Issue> {
    const refreshed = await this.fetchIssuesByIds([id]);
    if (refreshed.length === 0) throw new AdapterError("tracker_response", `issue ${id} not found after update`);
    return refreshed[0]!;
  }

  // ---- create capability (extension) ----

  supportsCreate(): boolean {
    return true;
  }

  /**
   * Open a new GitHub issue. The caller's `identifier` is advisory only — GitHub
   * assigns the number, so the returned issue is identified as `GH-<number>`.
   */
  async createIssue(input: NewIssueInput): Promise<Issue> {
    const title = str(input.title);
    if (!title) throw new AdapterError("invalid_tracker_config", "title is required");
    const state = (str(input.state) || "todo").toLowerCase();
    const labels = [...new Set([...(input.labels ?? []).map((l) => str(l).toLowerCase()).filter(Boolean), STATE_LABEL_PREFIX + state])];

    const res = await this.request("POST", `/repos/${enc(this.owner)}/${enc(this.repo)}/issues`, {
      title,
      body: typeof input.description === "string" && input.description.trim() !== "" ? input.description : undefined,
      labels,
    });
    if (!res.body || typeof res.body !== "object" || Array.isArray(res.body)) {
      throw new AdapterError("tracker_response", "create issue returned an unexpected payload");
    }
    const created = this.normalize(res.body as Record<string, unknown>);
    // GitHub opens every new issue; a terminal creation state has to be applied after.
    if (TERMINAL_STATES.has(state)) {
      await this.applyState(numberOf(created), created, state);
      return this.refresh(created.id);
    }
    return created;
  }

  // ---- Provider-native agent tools (SPEC §10.5) ----

  agentToolSpecs(): ToolSpec[] {
    return [
      {
        name: "update_issue_state",
        description:
          "Transition the current issue to a new tracker state (e.g. 'in progress', 'review', 'done'). Optionally attach a comment. Use this to report progress and hand off work.",
        mutates: true,
        input_schema: {
          type: "object",
          required: ["state"],
          properties: {
            state: { type: "string", description: "The new tracker state name." },
            comment: { type: "string", description: "Optional note recorded with the transition." },
          },
        },
      },
      {
        name: "add_issue_comment",
        description: "Append a comment to the current issue on GitHub without changing its state.",
        mutates: true,
        input_schema: {
          type: "object",
          required: ["comment"],
          properties: { comment: { type: "string" } },
        },
      },
      {
        name: "set_issue_result",
        description:
          "Record the final outcome of your work on the issue: optionally set its handoff state, add a summary comment, attach a PR/URL, and note the test/build outcome.",
        mutates: true,
        input_schema: {
          type: "object",
          properties: {
            state: { type: "string" },
            comment: { type: "string" },
            pr_url: { type: "string" },
            tests: { type: "string", description: "Test/build outcome, e.g. 'npm test: 70 passed; typecheck clean'." },
          },
        },
      },
    ];
  }

  async executeAgentTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "update_issue_state": {
          const state = str(a.state);
          if (!state) return fail("update_issue_state requires a non-empty 'state'");
          const number = numberOf(ctx.issue);
          if (str(a.comment)) await this.addComment(number, str(a.comment));
          await this.applyState(number, ctx.issue, state);
          return { success: true, output: { issue_id: ctx.issue.id, state } };
        }
        case "add_issue_comment": {
          const comment = str(a.comment);
          if (!comment) return fail("add_issue_comment requires a non-empty 'comment'");
          await this.addComment(numberOf(ctx.issue), comment);
          return { success: true, output: { issue_id: ctx.issue.id, commented: true } };
        }
        case "set_issue_result": {
          const number = numberOf(ctx.issue);
          const comment = str(a.comment);
          const tests = str(a.tests);
          if (comment || tests) {
            await this.addComment(number, tests ? `${comment ? comment + "\n\n" : ""}Tests: ${tests}` : comment);
          }
          if (str(a.pr_url)) await this.addComment(number, `PR: ${str(a.pr_url)}`);
          const state = str(a.state);
          if (state) await this.applyState(number, ctx.issue, state);
          return { success: true, output: { issue_id: ctx.issue.id, state: state || ctx.issue.state, result_recorded: true } };
        }
        default:
          // Unsupported tool name -> structured failure (SPEC §10.5).
          return fail(`unsupported tool: ${name}`);
      }
    } catch (err) {
      // A provider fault during a tool call is the agent's to see, not a run-killer.
      this.logger.warn("github tool call failed", { adapter: this.kind, tool: name, error: (err as Error).message });
      return fail((err as Error).message);
    }
  }
}

// ---- helpers ----

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

function enc(v: string): string {
  return encodeURIComponent(v);
}

/** The GitHub issue number carried on a normalized issue's native_ref. */
function numberOf(issue: Issue): number {
  const number = issue.native_ref?.number;
  if (typeof number !== "number" || !Number.isInteger(number)) {
    throw new AdapterError("tracker_response", `issue ${issue.id} has no GitHub issue number`);
  }
  return number;
}

/**
 * Split a GitHub label array into ordinary (lowercased, deduped) labels and the
 * single `sym:<state>` label. A record with more than one state label is not a fault
 * — states are swapped with two calls, so a crash between them can leave both; the
 * first wins and `setIssueState` cleans the rest up on the next transition.
 */
function splitLabels(v: unknown, number: number): { labels: string[]; state: string; stateLabels: string[] } {
  if (v === undefined || v === null) return { labels: [], state: "", stateLabels: [] };
  if (!Array.isArray(v)) throw new AdapterError("tracker_response", `issue #${number} has a malformed 'labels' field`);
  const seen = new Set<string>();
  const labels: string[] = [];
  const stateLabels: string[] = [];
  let state = "";
  for (const entry of v) {
    const name = typeof entry === "string" ? entry.trim() : str((entry as Record<string, unknown> | null)?.name);
    if (!name) continue;
    const lower = name.toLowerCase();
    if (lower.startsWith(STATE_LABEL_PREFIX)) {
      const candidate = lower.slice(STATE_LABEL_PREFIX.length).trim();
      if (!candidate || stateLabels.includes(name)) continue;
      if (!state) state = candidate;
      stateLabels.push(name); // literal name — that is what DELETE addresses
      continue; // state is not a label in the domain model
    }
    if (seen.has(lower)) continue;
    seen.add(lower);
    labels.push(lower);
  }
  return { labels, state, stateLabels };
}

/** The literal `sym:*` label names on an issue, as recorded at normalization. */
function stateLabelsOf(issue: Issue): string[] {
  const raw = issue.native_ref?.state_labels;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x !== "") : [];
}

/** Extract the `rel="next"` URL from a GitHub `Link` header, if any. */
function nextLink(header: string | null): string | null {
  if (!header || header.trim() === "") return null;
  for (const part of header.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*(.+)$/.exec(part);
    if (!match) continue;
    if (!/rel\s*=\s*"?next"?/.test(match[2]!)) continue;
    const url = match[1]!.trim();
    if (!/^https?:\/\//.test(url)) {
      throw new AdapterError("tracker_pagination", `Link header 'next' is not an absolute URL: ${url}`);
    }
    return url;
  }
  return null;
}

function fail(message: string): ToolResult {
  return { success: false, output: { error: message } };
}

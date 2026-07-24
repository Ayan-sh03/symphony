/**
 * File Tracker Adapter (`kind: "file"`). A self-contained, credential-free tracker
 * whose issues are JSON files in a directory. This is the adapter Symphony uses to
 * "track itself": its own work items live on disk and the coding agent transitions
 * them via provider-native agent tools executed host-side.
 *
 * Adapter profile (SPEC §11.2):
 * - tracker.kind: "file"
 * - tracker.provider keys:
 *     - `dir` (string path, default "./issues", relative to WORKFLOW.md dir; supports ~ and $VAR)
 *   No secret keys; secretEnvironmentNames() returns [] .
 * - Scope: every `*.json` file directly inside `dir` is one issue. No pagination limit.
 * - id mapping: issue.id, defaulting to identifier when absent. native_ref preserved verbatim if a JSON object.
 * - dispatchable: from the file's `dispatchable` field, defaulting to true.
 * - Malformed record = missing/blank required id/identifier/title/state, or unreadable/!object JSON.
 *   State-list reads log+omit malformed records; ID refresh fails them (SPEC §11.1).
 * - Errors map to AdapterError{category,message}: invalid_tracker_config, tracker_request, tracker_response.
 *
 * Provider-native tools (SPEC §10.5, mutate tracker state):
 * - `update_issue_state({state, comment?})`  -> sets the issue's state (+ optional comment)
 * - `add_issue_comment({comment})`           -> appends a comment
 * - `set_issue_result({state?, comment?, pr_url?, tests?})` -> convenience terminal handoff
 *
 * Delivery records (extension): `setIssueDelivery` merges a delivery (branch,
 * commit, files, …) onto the issue's `delivery` field, enriching summary/tests
 * from the stored result envelope; the record survives on the issue for review.
 */
import fs from "node:fs";
import path from "node:path";
import type { Issue, BlockerRef, IssueDelivery } from "../domain/types.ts";
import type { Logger } from "../logger.ts";
import { expandPath } from "../config/config.ts";
import {
  AdapterError,
  type TrackerAdapter,
  type ToolContext,
  type ToolResult,
  type ToolSpec,
  type NewIssueInput,
} from "./types.ts";
import { workspaceKey } from "../workspace/manager.ts";

interface FileAdapterOptions {
  dir: string;
  logger: Logger;
}

export class FileTrackerAdapter implements TrackerAdapter {
  readonly kind = "file";
  private dir: string;
  private logger: Logger;

  constructor(opts: FileAdapterOptions) {
    this.dir = opts.dir;
    this.logger = opts.logger;
  }

  /**
   * Build the adapter from effective tracker.provider config (SPEC §11.2 construction).
   * @param provider adapter-owned config
   * @param workflowDir directory containing WORKFLOW.md, for relative `dir`
   */
  static create(provider: Record<string, unknown>, workflowDir: string, logger: Logger): FileTrackerAdapter {
    let dirRaw = typeof provider.dir === "string" && provider.dir.trim() !== "" ? provider.dir : "./issues";
    dirRaw = expandPath(dirRaw);
    const dir = path.isAbsolute(dirRaw) ? path.normalize(dirRaw) : path.normalize(path.join(workflowDir, dirRaw));
    return new FileTrackerAdapter({ dir, logger });
  }

  /** Validate config eagerly for dispatch preflight (SPEC §6.3). */
  static validate(provider: Record<string, unknown>): void {
    if (provider.dir !== undefined && typeof provider.dir !== "string") {
      throw new AdapterError("invalid_tracker_config", "tracker.provider.dir must be a string path");
    }
  }

  private ensureDir(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      throw new AdapterError("tracker_request", `cannot access issue dir ${this.dir}: ${(err as Error).message}`);
    }
  }

  private listFiles(): string[] {
    this.ensureDir();
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dir);
    } catch (err) {
      throw new AdapterError("tracker_request", `cannot read issue dir ${this.dir}: ${(err as Error).message}`);
    }
    return entries.filter((f) => f.toLowerCase().endsWith(".json")).sort().map((f) => path.join(this.dir, f));
  }

  private readRaw(file: string): Record<string, unknown> | null {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Normalize a raw record into an Issue, or null if it is malformed (SPEC §11.3). */
  private normalize(raw: Record<string, unknown> | null): Issue | null {
    if (!raw) return null;
    const identifier = str(raw.identifier);
    const title = str(raw.title);
    const state = str(raw.state);
    const id = str(raw.id) || identifier; // id defaults to identifier
    if (!identifier || !title || !state || !id) return null; // required non-empty (SPEC §11.3)

    const labels = normalizeLabels(raw.labels);
    const priority = normalizePriority(raw.priority);
    const dispatchable = raw.dispatchable === undefined ? true : raw.dispatchable === true;
    const nativeRef =
      raw.native_ref && typeof raw.native_ref === "object" && !Array.isArray(raw.native_ref)
        ? (raw.native_ref as Record<string, unknown>)
        : null;

    return {
      id,
      native_ref: nativeRef,
      identifier,
      title,
      description: strOrNull(raw.description),
      priority,
      state,
      branch_name: strOrNull(raw.branch_name),
      url: strOrNull(raw.url),
      assignee_id: strOrNull(raw.assignee_id),
      labels,
      blocked_by: normalizeBlockers(raw.blocked_by),
      dispatchable,
      agent: typeof raw.agent === "string" && raw.agent.trim() !== "" ? raw.agent.trim() : null,
      delivery: normalizeDelivery(raw.delivery),
      created_at: strOrNull(raw.created_at),
      updated_at: strOrNull(raw.updated_at),
    };
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return []; // SPEC §11.1: empty => empty, no request
    const wanted = new Set(stateNames.map((s) => s.trim().toLowerCase()));
    const out: Issue[] = [];
    for (const file of this.listFiles()) {
      const raw = this.readRaw(file);
      const issue = this.normalize(raw);
      if (!issue) {
        // State-list read: log and omit malformed record (SPEC §11.1).
        this.logger.warn("tracker omitted malformed record", { adapter: this.kind, file });
        continue;
      }
      if (wanted.has(issue.state.trim().toLowerCase())) out.push(issue);
    }
    return out;
  }

  async fetchIssuesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return []; // SPEC §11.1: empty => empty, no request
    const wanted = new Set(issueIds);
    const byId = new Map<string, Issue>();
    for (const file of this.listFiles()) {
      const raw = this.readRaw(file);
      // Determine candidate id cheaply to know if this file is requested.
      const candidateId = raw ? (str(raw.id) || str(raw.identifier)) : "";
      if (!wanted.has(candidateId)) continue;
      const issue = this.normalize(raw);
      if (!issue) {
        // ID refresh: a malformed requested record MUST fail (SPEC §11.1).
        throw new AdapterError("tracker_response", `requested issue record is malformed: ${file}`);
      }
      byId.set(issue.id, issue); // each dispatch id at most once (SPEC §11.1)
    }
    return [...byId.values()];
  }

  // ---- board capability (extension) ----

  supportsBoard(): boolean {
    return true;
  }

  /** Every normalized issue in the tracker, regardless of state (malformed omitted). */
  async listAllIssues(): Promise<Issue[]> {
    const out: Issue[] = [];
    for (const file of this.listFiles()) {
      const issue = this.normalize(this.readRaw(file));
      if (issue) out.push(issue);
    }
    return out;
  }

  /** Move an issue to a new state (console Start/Reopen/Cancel actions). */
  async setIssueState(id: string, state: string): Promise<Issue> {
    const target = str(state);
    if (!target) throw new AdapterError("invalid_tracker_config", "state is required");
    return this.patch(id, (rec) => { rec.state = target; }, { state: target });
  }

  /** Assign (or clear, with empty string) the per-task agent backend. */
  async setIssueAgent(id: string, agent: string): Promise<Issue> {
    const target = str(agent);
    return this.patch(id, (rec) => { if (target) rec.agent = target; else delete rec.agent; }, { agent: target || null });
  }

  /**
   * Record/merge a delivery on the issue (extension). Fields absent from the
   * incoming patch keep their stored values; summary/tests fall back to the
   * agent's own result envelope (its latest comment + result_tests). A fresh
   * delivery (one carrying delivered_at) also lands in the comment log.
   */
  async setIssueDelivery(id: string, delivery: Partial<IssueDelivery>): Promise<Issue> {
    return this.patch(id, (rec) => {
      const existing = normalizeDelivery(rec.delivery);
      const merged: IssueDelivery = {
        branch: delivery.branch ?? existing?.branch ?? "",
        commit_sha: delivery.commit_sha ?? existing?.commit_sha ?? null,
        base_branch: delivery.base_branch ?? existing?.base_branch ?? null,
        files_changed: delivery.files_changed ?? existing?.files_changed ?? [],
        uncommitted: delivery.uncommitted ?? existing?.uncommitted ?? [],
        tests: delivery.tests ?? existing?.tests ?? (str(rec.result_tests) || null),
        summary: delivery.summary ?? existing?.summary ?? lastCommentText(rec),
        needs_attention: delivery.needs_attention ?? existing?.needs_attention ?? false,
        attention_reason: delivery.attention_reason ?? existing?.attention_reason ?? null,
        delivered_at: delivery.delivered_at ?? existing?.delivered_at ?? new Date().toISOString(),
        pushed_at: delivery.pushed_at ?? existing?.pushed_at ?? null,
      };
      rec.delivery = merged;
      if (delivery.delivered_at) {
        const sha = (merged.commit_sha ?? "").slice(0, 7) || "unknown";
        appendComment(rec, `Delivery recorded: ${merged.branch} @ ${sha}${merged.needs_attention ? ` — needs attention: ${merged.attention_reason ?? "check workspace"}` : ""}`);
      }
    }, { delivery_recorded: true });
  }

  private async patch(id: string, fn: (rec: Record<string, unknown>) => void, ok: Record<string, unknown>): Promise<Issue> {
    const res = this.mutate(id, fn, ok);
    if (!res.success) throw new AdapterError("tracker_response", String((res.output as { error?: string }).error ?? "update failed"));
    const refreshed = await this.fetchIssuesByIds([id]);
    if (refreshed.length === 0) throw new AdapterError("tracker_response", `issue ${id} not found after update`);
    return refreshed[0]!;
  }

  // ---- Provider-native agent tools (SPEC §10.5) ----

  agentToolSpecs(): ToolSpec[] {
    return [
      {
        name: "update_issue_state",
        description:
          "Transition the current issue to a new tracker state (e.g. 'In Review', 'Done'). Optionally attach a comment. Use this to report progress and hand off work.",
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
        description: "Append a comment to the current issue's activity log without changing its state.",
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

  secretEnvironmentNames(): string[] {
    return []; // file adapter uses no credentials
  }

  // ---- create capability (extension) ----

  supportsCreate(): boolean {
    return true;
  }

  /** Create a new issue as a JSON file in the tracker directory. */
  async createIssue(input: NewIssueInput): Promise<Issue> {
    const identifier = str(input.identifier);
    const title = str(input.title);
    if (!identifier) throw new AdapterError("invalid_tracker_config", "identifier is required");
    if (!title) throw new AdapterError("invalid_tracker_config", "title is required");

    this.ensureDir();
    // Filename derives from the sanitized identifier so it is filesystem-safe and
    // stable; a colliding id is rejected rather than silently overwritten.
    const fileName = `${workspaceKey(identifier)}.json`;
    const file = path.join(this.dir, fileName);
    for (const existing of this.listFiles()) {
      const raw = this.readRaw(existing);
      const id = raw ? str(raw.id) || str(raw.identifier) : "";
      if (id === identifier) throw new AdapterError("invalid_tracker_config", `issue ${identifier} already exists`);
    }

    const record: Record<string, unknown> = {
      id: identifier,
      identifier,
      title,
      description: typeof input.description === "string" && input.description.trim() !== "" ? input.description : null,
      state: str(input.state) || "todo",
      priority: normalizePriority(input.priority),
      labels: normalizeLabels(input.labels),
      dispatchable: true,
      url: `symphony://issues/${identifier}`,
      created_at: new Date().toISOString(),
    };
    if (typeof input.agent === "string" && input.agent.trim() !== "") record.agent = input.agent.trim();
    try {
      fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
    } catch (err) {
      throw new AdapterError("tracker_request", `failed to write issue ${identifier}: ${(err as Error).message}`);
    }
    const issue = this.normalize(record);
    if (!issue) throw new AdapterError("tracker_response", "created record failed normalization");
    return issue;
  }

  async executeAgentTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    switch (name) {
      case "update_issue_state": {
        const state = str(a.state);
        if (!state) return fail("update_issue_state requires a non-empty 'state'");
        return this.mutate(ctx.issue.id, (rec) => {
          rec.state = state;
          if (str(a.comment)) appendComment(rec, str(a.comment));
        }, { state });
      }
      case "add_issue_comment": {
        const comment = str(a.comment);
        if (!comment) return fail("add_issue_comment requires a non-empty 'comment'");
        return this.mutate(ctx.issue.id, (rec) => appendComment(rec, comment), { commented: true });
      }
      case "set_issue_result": {
        return this.mutate(ctx.issue.id, (rec) => {
          if (str(a.state)) rec.state = str(a.state);
          if (str(a.comment)) appendComment(rec, str(a.comment));
          if (str(a.pr_url)) rec.pr_url = str(a.pr_url);
          if (str(a.tests)) rec.result_tests = str(a.tests);
        }, { result_recorded: true });
      }
      default:
        // Unsupported tool name -> structured failure (SPEC §10.5).
        return fail(`unsupported tool: ${name}`);
    }
  }

  /** Load, mutate, and persist an issue record by dispatch id. Used by agent tools. */
  private mutate(id: string, fn: (rec: Record<string, unknown>) => void, ok: Record<string, unknown>): ToolResult {
    for (const file of this.listFiles()) {
      const raw = this.readRaw(file);
      if (!raw) continue;
      const candidateId = str(raw.id) || str(raw.identifier);
      if (candidateId !== id) continue;
      fn(raw);
      raw.updated_at = new Date().toISOString();
      try {
        fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n", "utf8");
      } catch (err) {
        return fail(`failed to persist issue ${id}: ${(err as Error).message}`);
      }
      return { success: true, output: { issue_id: id, state: raw.state, ...ok } };
    }
    return fail(`issue ${id} not found in tracker`);
  }
}

// ---- normalization helpers ----

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}
function strOrNull(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return null;
}
function normalizeLabels(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of v) {
    const s = typeof x === "string" ? x.trim().toLowerCase() : "";
    if (s === "" || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
function normalizePriority(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isInteger(Number(v))) return Number(v);
  return null;
}
function normalizeBlockers(v: unknown): BlockerRef[] {
  if (!Array.isArray(v)) return [];
  const out: BlockerRef[] = [];
  for (const b of v) {
    if (!b || typeof b !== "object") continue;
    const rec = b as Record<string, unknown>;
    out.push({ id: strOrNull(rec.id), identifier: strOrNull(rec.identifier), state: strOrNull(rec.state) });
  }
  return out;
}
function appendComment(rec: Record<string, unknown>, comment: string): void {
  const list = Array.isArray(rec.comments) ? (rec.comments as unknown[]) : [];
  list.push({ at: new Date().toISOString(), text: comment });
  rec.comments = list;
}
function lastCommentText(rec: Record<string, unknown>): string | null {
  const list = Array.isArray(rec.comments) ? (rec.comments as unknown[]) : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const text = str((list[i] as Record<string, unknown> | null)?.text);
    if (text) return text;
  }
  return null;
}
function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
}
/** Parse a stored delivery record; null when absent or shapeless (extension). */
function normalizeDelivery(v: unknown): IssueDelivery | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const branch = str(r.branch);
  if (!branch) return null;
  return {
    branch,
    commit_sha: strOrNull(r.commit_sha),
    base_branch: strOrNull(r.base_branch),
    files_changed: stringArray(r.files_changed),
    uncommitted: stringArray(r.uncommitted),
    tests: strOrNull(r.tests),
    summary: strOrNull(r.summary),
    needs_attention: r.needs_attention === true,
    attention_reason: strOrNull(r.attention_reason),
    delivered_at: str(r.delivered_at),
    pushed_at: strOrNull(r.pushed_at),
  };
}
function fail(message: string): ToolResult {
  return { success: false, output: { error: message } };
}

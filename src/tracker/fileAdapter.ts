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
 * Edit capability (extension): `updateIssue` amends title/description/priority/labels
 * and the per-task `model` in place, and `deleteIssue` removes the issue's file; the
 * identifier keys the record and is immutable (a rename is a delete + create).
 *
 * Follow-ups (extension, SPEC Appendix B.5): `follow_up_for` and `stream_identifier`
 * are carried verbatim on the record and written at creation only — `stream_identifier`
 * picks the branch and workspace, so `updateIssue` never touches either.
 *
 * Delivery records (extension): `setIssueDelivery` merges a delivery (branch,
 * commit, files, …) onto the issue's `delivery` field, enriching summary/tests
 * from the stored result envelope; the record survives on the issue for review.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
  type IssuePatch,
} from "./types.ts";
import { workspaceKey } from "../workspace/manager.ts";

interface FileAdapterOptions {
  dir: string;
  logger: Logger;
}

interface IndexedRecord {
  file: string;
  stamp: string;
  raw: Record<string, unknown> | null;
  candidateId: string;
  issue: Issue | null;
}

export class FileTrackerAdapter implements TrackerAdapter {
  readonly kind = "file";
  private dir: string;
  private logger: Logger;
  private records = new Map<string, IndexedRecord>();
  private filesById = new Map<string, Set<string>>();
  private watcher: fs.FSWatcher | null = null;
  private needsFullRefresh = true;
  private dirtyFiles = new Set<string>();
  private mutationTails = new Map<string, Promise<void>>();
  private refreshInFlight: Promise<void> | null = null;

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

  private async ensureDir(): Promise<void> {
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
    } catch (err) {
      throw new AdapterError("tracker_request", `cannot access issue dir ${this.dir}: ${(err as Error).message}`);
    }
    this.startWatcher();
  }

  private startWatcher(): void {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, (_event, name) => {
        if (!name) {
          this.needsFullRefresh = true;
          return;
        }
        const file = path.join(this.dir, name.toString());
        if (file.toLowerCase().endsWith(".json")) this.dirtyFiles.add(file);
      });
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
        this.needsFullRefresh = true;
      });
    } catch {
      // Some filesystems cannot watch directories. The async full refresh below
      // remains the correctness fallback in that case.
      this.needsFullRefresh = true;
    }
  }

  /**
   * Reconcile the in-memory index with directory metadata. The first access reads
   * each record; later accesses only reread files whose metadata changed. This
   * deliberately keeps expensive JSON parsing off the event loop and out of
   * steady-state single-issue paths.
   */
  private async refreshIndex(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const refresh = this.refreshIndexOnce();
    this.refreshInFlight = refresh;
    try {
      await refresh;
    } finally {
      if (this.refreshInFlight === refresh) this.refreshInFlight = null;
    }
  }

  private async refreshIndexOnce(): Promise<void> {
    await this.ensureDir();
    if (!this.needsFullRefresh) {
      // Give a synchronous hand edit a chance to reach fs.watch before deciding
      // that this is a no-I/O steady-state lookup.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const dirty = [...this.dirtyFiles];
      this.dirtyFiles.clear();
      await mapConcurrent(dirty, 64, async (file) => this.refreshFile(file));
      return;
    }

    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch (err) {
      throw new AdapterError("tracker_request", `cannot read issue dir ${this.dir}: ${(err as Error).message}`);
    }

    const files = names
      .filter((name) => name.toLowerCase().endsWith(".json"))
      .sort()
      .map((name) => path.join(this.dir, name));
    const present = new Set(files);
    for (const entry of this.records.values()) {
      if (!present.has(entry.file)) this.removeRecord(entry);
    }
    await mapConcurrent(files, 64, async (file) => this.refreshFile(file));
    this.needsFullRefresh = false;
  }

  private async refreshFile(file: string): Promise<void> {
    let stamp: string;
    try {
      const stat = await fs.promises.stat(file);
      stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch {
      const existing = this.records.get(file);
      if (existing) this.removeRecord(existing);
      return;
    }
    const existing = this.records.get(file);
    if (existing?.stamp === stamp) return;
    const raw = await this.readRaw(file);
    const next: IndexedRecord = {
      file,
      stamp,
      raw,
      candidateId: raw ? str(raw.id) || str(raw.identifier) : "",
      issue: this.normalize(raw),
    };
    if (existing) this.removeRecord(existing);
    this.addRecord(next);
  }

  private async readRaw(file: string): Promise<Record<string, unknown> | null> {
    let text: string;
    try {
      text = await fs.promises.readFile(file, "utf8");
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

  private addRecord(record: IndexedRecord): void {
    this.records.set(record.file, record);
    if (!record.candidateId) return;
    const files = this.filesById.get(record.candidateId) ?? new Set<string>();
    files.add(record.file);
    this.filesById.set(record.candidateId, files);
  }

  private removeRecord(record: IndexedRecord): void {
    this.records.delete(record.file);
    if (!record.candidateId) return;
    const files = this.filesById.get(record.candidateId);
    if (!files) return;
    files.delete(record.file);
    if (files.size === 0) this.filesById.delete(record.candidateId);
  }

  /** Existing file order resolves duplicate ids deterministically. */
  private recordForId(id: string, last: boolean): IndexedRecord | undefined {
    const files = this.filesById.get(id);
    if (!files || files.size === 0) return undefined;
    const ordered = [...files].sort();
    return this.records.get(last ? ordered.at(-1)! : ordered[0]!);
  }

  /** Persist beside the destination, flush, then atomically publish by rename. */
  private async writeAtomically(file: string, raw: Record<string, unknown>): Promise<string> {
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
    let renamed = false;
    try {
      let mode = 0o666;
      try {
        mode = (await fs.promises.stat(file)).mode & 0o777;
      } catch {
        // A new record uses the process umask with the ordinary file default.
      }
      await fs.promises.writeFile(temp, JSON.stringify(raw, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode });
      const handle = await fs.promises.open(temp, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      const stat = await fs.promises.stat(temp);
      await fs.promises.rename(temp, file);
      renamed = true;
      return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } finally {
      if (!renamed) await fs.promises.unlink(temp).catch(() => {});
    }
  }

  /** Replace the cached record only after its atomic disk commit succeeds. */
  private async storeRecord(previous: IndexedRecord, raw: Record<string, unknown>): Promise<IndexedRecord> {
    const stamp = await this.writeAtomically(previous.file, raw);
    const next: IndexedRecord = {
      file: previous.file,
      stamp,
      raw,
      candidateId: str(raw.id) || str(raw.identifier),
      issue: this.normalize(raw),
    };
    this.removeRecord(previous);
    this.addRecord(next);
    return next;
  }

  /** Queue writers by destination so every mutation starts from the last commit. */
  private async serializeMutation<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(file) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.mutationTails.set(file, current);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.mutationTails.get(file) === current) this.mutationTails.delete(file);
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
      model: typeof raw.model === "string" && raw.model.trim() !== "" ? raw.model.trim() : null,
      follow_up_for: str(raw.follow_up_for) || null,
      stream_identifier: str(raw.stream_identifier) || null,
      delivery: normalizeDelivery(raw.delivery),
      created_at: strOrNull(raw.created_at),
      updated_at: strOrNull(raw.updated_at),
    };
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return []; // SPEC §11.1: empty => empty, no request
    await this.refreshIndex();
    const wanted = new Set(stateNames.map((s) => s.trim().toLowerCase()));
    const out: Issue[] = [];
    for (const record of [...this.records.values()].sort((a, b) => a.file.localeCompare(b.file))) {
      if (!record.issue) {
        // State-list read: log and omit malformed record (SPEC §11.1).
        this.logger.warn("tracker omitted malformed record", { adapter: this.kind, file: record.file });
        continue;
      }
      if (wanted.has(record.issue.state.trim().toLowerCase())) out.push(record.issue);
    }
    return out;
  }

  async fetchIssuesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return []; // SPEC §11.1: empty => empty, no request
    await this.refreshIndex();
    const byId = new Map<string, Issue>();
    for (const id of issueIds) {
      const record = this.recordForId(id, true);
      if (!record) continue;
      if (!record.issue) {
        // ID refresh: a malformed requested record MUST fail (SPEC §11.1).
        throw new AdapterError("tracker_response", `requested issue record is malformed: ${record.file}`);
      }
      byId.set(record.issue.id, record.issue); // each dispatch id at most once (SPEC §11.1)
    }
    return [...byId.values()];
  }

  // ---- board capability (extension) ----

  supportsBoard(): boolean {
    return true;
  }

  /** Every normalized issue in the tracker, regardless of state (malformed omitted). */
  async listAllIssues(): Promise<Issue[]> {
    await this.refreshIndex();
    const out: Issue[] = [];
    for (const record of [...this.records.values()].sort((a, b) => a.file.localeCompare(b.file))) {
      if (record.issue) out.push(record.issue);
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
        parent_delivery_sha: delivery.parent_delivery_sha ?? existing?.parent_delivery_sha ?? null,
        history_rewritten: delivery.history_rewritten ?? existing?.history_rewritten ?? false,
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
    const { result, issue } = await this.mutateRecord(id, fn, ok);
    if (!result.success) throw new AdapterError("tracker_response", String((result.output as { error?: string }).error ?? "update failed"));
    if (!issue) throw new AdapterError("tracker_response", `issue ${id} not found after update`);
    return issue;
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

  /** Follow-ups are plain fields on the record, so this adapter carries them as-is. */
  supportsFollowUp(): boolean {
    return true;
  }

  /** Create a new issue as a JSON file in the tracker directory. */
  async createIssue(input: NewIssueInput): Promise<Issue> {
    const identifier = str(input.identifier);
    const title = str(input.title);
    if (!identifier) throw new AdapterError("invalid_tracker_config", "identifier is required");
    if (!title) throw new AdapterError("invalid_tracker_config", "title is required");

    await this.refreshIndex();
    // Filename derives from the sanitized identifier so it is filesystem-safe and
    // stable; a colliding id is rejected rather than silently overwritten.
    const fileName = `${workspaceKey(identifier)}.json`;
    const file = path.join(this.dir, fileName);
    if (this.recordForId(identifier, false)) {
      throw new AdapterError("invalid_tracker_config", `issue ${identifier} already exists`);
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
    if (typeof input.model === "string" && input.model.trim() !== "") record.model = input.model.trim();
    // Written only when set, so ordinary issues keep the record shape they had.
    if (str(input.follow_up_for)) record.follow_up_for = str(input.follow_up_for);
    if (str(input.stream_identifier)) record.stream_identifier = str(input.stream_identifier);
    try {
      const stamp = await this.writeAtomically(file, record);
      this.addRecord({
        file,
        stamp,
        raw: record,
        candidateId: identifier,
        issue: this.normalize(record),
      });
    } catch (err) {
      throw new AdapterError("tracker_request", `failed to write issue ${identifier}: ${(err as Error).message}`);
    }
    const issue = this.normalize(record);
    if (!issue) throw new AdapterError("tracker_response", "created record failed normalization");
    return issue;
  }

  // ---- edit capability (extension) ----

  supportsEdit(): boolean {
    return true;
  }

  /**
   * Amend an existing issue's editable fields in place. Absent keys keep their
   * stored value; the identifier keys the file and is never rewritten here.
   */
  async updateIssue(id: string, patch: IssuePatch): Promise<Issue> {
    if (patch.title !== undefined && !str(patch.title)) {
      throw new AdapterError("invalid_tracker_config", "title cannot be blank");
    }
    return this.patch(id, (rec) => {
      if (patch.title !== undefined) rec.title = str(patch.title);
      if (patch.description !== undefined) {
        rec.description = typeof patch.description === "string" && patch.description.trim() !== "" ? patch.description : null;
      }
      if (patch.priority !== undefined) rec.priority = normalizePriority(patch.priority);
      if (patch.labels !== undefined) rec.labels = normalizeLabels(patch.labels);
      // Clearing drops the key entirely, matching how `agent` is stored — an issue on
      // the backend default carries no model field at all.
      if (patch.model !== undefined) {
        const m = str(patch.model);
        if (m) rec.model = m;
        else delete rec.model;
      }
    }, { updated: true });
  }

  /** Remove an issue by deleting its file. Unknown id is an error, not a no-op. */
  async deleteIssue(id: string): Promise<void> {
    await this.refreshIndex();
    const record = this.recordForId(id, false);
    if (!record) throw new AdapterError("tracker_response", `issue ${id} not found in tracker`);
    try {
      await fs.promises.unlink(record.file);
      this.removeRecord(record);
    } catch (err) {
      throw new AdapterError("tracker_request", `failed to delete issue ${id}: ${(err as Error).message}`);
    }
  }

  async executeAgentTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    switch (name) {
      case "update_issue_state": {
        const state = str(a.state);
        if (!state) return fail("update_issue_state requires a non-empty 'state'");
        return (await this.mutateRecord(ctx.issue.id, (rec) => {
          rec.state = state;
          if (str(a.comment)) appendComment(rec, str(a.comment));
        }, { state })).result;
      }
      case "add_issue_comment": {
        const comment = str(a.comment);
        if (!comment) return fail("add_issue_comment requires a non-empty 'comment'");
        return (await this.mutateRecord(ctx.issue.id, (rec) => appendComment(rec, comment), { commented: true })).result;
      }
      case "set_issue_result": {
        return (await this.mutateRecord(ctx.issue.id, (rec) => {
          if (str(a.state)) rec.state = str(a.state);
          if (str(a.comment)) appendComment(rec, str(a.comment));
          if (str(a.pr_url)) rec.pr_url = str(a.pr_url);
          if (str(a.tests)) rec.result_tests = str(a.tests);
        }, { result_recorded: true })).result;
      }
      default:
        // Unsupported tool name -> structured failure (SPEC §10.5).
        return fail(`unsupported tool: ${name}`);
    }
  }

  /** Load, mutate, and persist an issue record by dispatch id. Used by agent tools. */
  private async mutateRecord(
    id: string,
    fn: (rec: Record<string, unknown>) => void,
    ok: Record<string, unknown>,
  ): Promise<{ result: ToolResult; issue: Issue | null }> {
    await this.refreshIndex();
    const selected = this.recordForId(id, false);
    if (!selected || !selected.raw) return { result: fail(`issue ${id} not found in tracker`), issue: null };
    return this.serializeMutation(selected.file, async () => {
      await this.refreshIndex();
      const record = this.records.get(selected.file);
      if (!record?.raw || record.candidateId !== id) {
        return { result: fail(`issue ${id} not found in tracker`), issue: null };
      }
      const raw = structuredClone(record.raw);
      fn(raw);
      raw.updated_at = new Date().toISOString();
      let updated: IndexedRecord;
      try {
        updated = await this.storeRecord(record, raw);
      } catch (err) {
        return { result: fail(`failed to persist issue ${id}: ${(err as Error).message}`), issue: null };
      }
      return {
        result: { success: true, output: { issue_id: id, state: raw.state, ...ok } },
        issue: updated.issue,
      };
    });
  }
}

// ---- normalization helpers ----

/** Keep large directory refreshes asynchronous without opening unbounded handles. */
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const current = next++;
      out[current] = await fn(items[current]!);
    }
  });
  await Promise.all(workers);
  return out;
}

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
    parent_delivery_sha: strOrNull(r.parent_delivery_sha),
    history_rewritten: r.history_rewritten === true,
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

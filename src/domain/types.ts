/**
 * Core domain model (SPEC §4). These types are provider-neutral; adapters map
 * provider payloads into `Issue` (SPEC §4.1.1, §11.3).
 */

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

/**
 * Delivery record for a repository-backed issue (extension). Written by the
 * orchestrator when a run completes on a `workspace.repository` project: the
 * issue branch and its head commit are the deliverable, so they are recorded
 * on the tracker issue before the disposable worktree is removed.
 */
export interface IssueDelivery {
  /** Issue branch in the main repository (e.g. "issue/SYM-1"). */
  branch: string;
  /** Head commit of the issue branch at delivery time. */
  commit_sha: string | null;
  /**
   * Base the branch was cut from: the configured base_branch, else the repo branch at
   * creation. A commit SHA when no ref name is knowable — a detached HEAD has none, and a
   * branch Symphony did not create has its base recovered from the reflog. Null when it
   * could not be established at all; never a guess.
   */
  base_branch: string | null;
  /** Files changed on the branch relative to the base (merge-base diff). */
  files_changed: string[];
  /** Paths with uncommitted changes left in the preserved worktree (empty when clean). */
  uncommitted: string[];
  /** Agent-reported test/build outcome (from the result envelope). */
  tests: string | null;
  /** Agent-reported summary (from the result envelope). */
  summary: string | null;
  /** True when delivery was unsafe (uncommitted work, missing branch) — operator must look. */
  needs_attention: boolean;
  attention_reason: string | null;
  delivered_at: string;
  /** Set once the branch has been pushed to the remote (delivery_mode push/pr). */
  pushed_at: string | null;
}

/** Normalized schedulable work item (SPEC §4.1.1). */
export interface Issue {
  id: string;
  native_ref: Record<string, unknown> | null;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  assignee_id: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  dispatchable: boolean;
  /**
   * OPTIONAL per-task agent backend override (extension). When set to a registered
   * agent kind, this issue runs on that backend instead of the effective default.
   */
  agent: string | null;
  /**
   * Identifier of the issue this one follows up on (extension, SPEC Appendix B.5).
   * Lineage only — it records who asked for the follow-up; the branch and workspace
   * come from `stream_identifier`.
   */
  follow_up_for: string | null;
  /**
   * Work stream this issue belongs to (extension, SPEC Appendix B.5): the identifier
   * whose branch and workspace it shares. Null means the issue is its own stream,
   * which is every ordinary issue. Frozen at creation from the parent's own stream,
   * so a chain of follow-ups all name the original — no walk, no cycles, and deleting
   * a middle issue cannot strand a child on a fresh branch.
   */
  stream_identifier: string | null;
  /** Recorded delivery, present on repository-backed issues that reached review (extension). */
  delivery?: IssueDelivery | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Parsed WORKFLOW.md payload (SPEC §4.1.2). */
export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt_template: string;
}

/** Logical workspace record (SPEC §4.1.4). */
export interface Workspace {
  path: string;
  workspace_key: string;
  created_now: boolean;
}

/** Live agent session metadata (SPEC §4.1.6). */
export interface LiveSession {
  session_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  codex_app_server_pid: string | null;
  last_codex_event: string | null;
  last_codex_timestamp: string | null;
  last_codex_message: string | null;
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  turn_count: number;
}

/**
 * Emitted runtime event from an agent session to the orchestrator (SPEC §10.4).
 * Agent-implementation-neutral; the `codex_*`-named fields are kept because the
 * spec's observable LiveSession schema (§4.1.6) uses them, but any agent backend
 * populates them.
 */
export interface AgentUpdate {
  event: string;
  timestamp: string;
  codex_app_server_pid?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null;
  message?: string;
  thread_id?: string | null;
  turn_id?: string | null;
  session_id?: string | null;
  [key: string]: unknown;
}

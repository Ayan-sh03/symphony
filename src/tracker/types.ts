/**
 * Issue Tracker Adapter contract (SPEC §11). A portable read kernel plus OPTIONAL
 * provider-native agent tools.
 */
import type { Issue, IssueDelivery } from "../domain/types.ts";

export type AdapterErrorCategory =
  | "unsupported_tracker_kind"
  | "invalid_tracker_config"
  | "missing_tracker_secret"
  | "tracker_request"
  | "tracker_status"
  | "tracker_response"
  | "tracker_pagination"
  | "tracker_rate_limited";

export class AdapterError extends Error {
  readonly category: AdapterErrorCategory;
  readonly retryable: boolean;
  constructor(category: AdapterErrorCategory, message: string, retryable = false) {
    super(message);
    this.name = "AdapterError";
    this.category = category;
    this.retryable = retryable;
  }
}

/** Agent tool spec advertised to the coding agent (SPEC §10.5, §11 extension). */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  mutates: boolean;
}

/** Result of a provider-native tool execution (SPEC §10.5). */
export interface ToolResult {
  success: boolean;
  output: unknown;
}

export interface ToolContext {
  issue: Issue;
}

/** Input for creating a new work item (OPTIONAL adapter capability). */
export interface NewIssueInput {
  identifier: string;
  title: string;
  description?: string | null;
  state?: string | null;
  priority?: number | null;
  labels?: string[];
  /** OPTIONAL per-task agent backend override. */
  agent?: string | null;
  /** OPTIONAL per-task model override, passed to the backend verbatim. */
  model?: string | null;
  /** OPTIONAL follow-up lineage: the identifier this issue follows up on. */
  follow_up_for?: string | null;
  /** OPTIONAL work stream to join (resolved by the caller, never by the adapter). */
  stream_identifier?: string | null;
}

/**
 * Editable fields of an existing work item (OPTIONAL adapter capability). Only the
 * keys present are written. `identifier` is deliberately absent: it keys the record
 * (and the workspace), so a rename is a delete + create. State and the per-task
 * agent keep their dedicated `setIssueState`/`setIssueAgent` endpoints.
 *
 * The follow-up fields are absent for the same reason as `identifier`: `stream_identifier`
 * picks the branch and workspace, so editing it would move an issue's work mid-life.
 * Changing a follow-up link is a delete + create.
 */
export interface IssuePatch {
  title?: string;
  description?: string | null;
  priority?: number | null;
  labels?: string[];
  /**
   * Per-task model override (extension, Appendix B.7). Unlike `agent`, this has no
   * dedicated endpoint: it is free text with nothing to validate against, so the edit
   * form is the whole interface. `null` clears it back to the backend default.
   */
  model?: string | null;
}

export interface TrackerAdapter {
  readonly kind: string;

  /** SPEC §11.1: candidate polling + startup terminal cleanup. Empty list => empty, no request. */
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;

  /** SPEC §11.1: reconciliation/refresh. Empty list => empty, no request. Malformed requested record MUST fail. */
  fetchIssuesByIds(issueIds: string[]): Promise<Issue[]>;

  /** OPTIONAL provider-native agent tools (SPEC §10.5). */
  agentToolSpecs(): ToolSpec[];
  secretEnvironmentNames(): string[];
  executeAgentTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;

  /**
   * OPTIONAL create capability (extension beyond the read kernel). When present,
   * the console and API can add work items. Not all trackers support this.
   */
  supportsCreate?(): boolean;
  createIssue?(input: NewIssueInput): Promise<Issue>;

  /**
   * OPTIONAL follow-up capability (extension, SPEC Appendix B.5): the adapter persists
   * and returns `follow_up_for`/`stream_identifier`, so a new issue can join an existing
   * issue's branch instead of cutting its own. Requires `supportsCreate`. Adapters
   * without it simply never offer follow-ups; nothing else changes.
   */
  supportsFollowUp?(): boolean;

  /**
   * OPTIONAL edit capability (extension beyond the read kernel). When present, the
   * console and API can amend or remove work items instead of forcing the operator
   * to hand-edit provider records. Both are gated by the same `supportsEdit`.
   */
  supportsEdit?(): boolean;
  updateIssue?(id: string, patch: IssuePatch): Promise<Issue>;
  deleteIssue?(id: string): Promise<void>;

  /**
   * OPTIONAL board capability: list every work item regardless of state, and move
   * one between states. Powers the console board (backlog + completed visibility).
   */
  supportsBoard?(): boolean;
  listAllIssues?(): Promise<Issue[]>;
  setIssueState?(id: string, state: string): Promise<Issue>;
  /** OPTIONAL: assign/clear the per-task agent backend (empty string clears). */
  setIssueAgent?(id: string, agent: string): Promise<Issue>;
  /**
   * OPTIONAL delivery capability (extension): persist/merge a delivery record on
   * the issue. The orchestrator writes git facts at completion and `pushed_at`
   * after a push; the adapter may enrich provider-side fields (summary/tests)
   * from its own records. Adapters without it simply skip delivery recording.
   */
  setIssueDelivery?(id: string, delivery: Partial<IssueDelivery>): Promise<Issue>;
}

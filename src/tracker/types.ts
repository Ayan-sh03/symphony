/**
 * Issue Tracker Adapter contract (SPEC §11). A portable read kernel plus OPTIONAL
 * provider-native agent tools.
 */
import type { Issue } from "../domain/types.ts";

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
   * OPTIONAL board capability: list every work item regardless of state, and move
   * one between states. Powers the console board (backlog + completed visibility).
   */
  supportsBoard?(): boolean;
  listAllIssues?(): Promise<Issue[]>;
  setIssueState?(id: string, state: string): Promise<Issue>;
  /** OPTIONAL: assign/clear the per-task agent backend (empty string clears). */
  setIssueAgent?(id: string, agent: string): Promise<Issue>;
}

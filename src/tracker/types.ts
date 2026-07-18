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
}

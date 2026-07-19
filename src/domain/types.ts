/**
 * Core domain model (SPEC §4). These types are provider-neutral; adapters map
 * provider payloads into `Issue` (SPEC §4.1.1, §11.3).
 */

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
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

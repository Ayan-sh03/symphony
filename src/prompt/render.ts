/**
 * Prompt Construction (SPEC §5.4, §12). Strict Liquid rendering: unknown variables
 * and unknown filters MUST fail rendering.
 */
import { Liquid } from "liquidjs";
import type { Issue } from "../domain/types.ts";

export type PromptErrorClass = "template_parse_error" | "template_render_error";

export class PromptError extends Error {
  readonly errorClass: PromptErrorClass;
  constructor(errorClass: PromptErrorClass, message: string) {
    super(message);
    this.name = "PromptError";
    this.errorClass = errorClass;
  }
}

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
  // Do not cache templates across reloads; the prompt body changes on reload.
  cache: false,
});

/**
 * Render the per-issue prompt. `attempt` is null on the first run, a 1-based
 * integer on retries/continuations (SPEC §12.3). `branch` is the branch the run
 * delivers on (SPEC Appendix B), null on scratch projects — it is not always
 * `issue/<identifier>`, since a follow-up delivers on the branch it continues.
 */
export function renderPrompt(template: string, issue: Issue, attempt: number | null, branch: string | null = null): string {
  // Convert issue keys to string-keyed plain object; preserve nested arrays/maps
  // so templates can iterate labels/blockers (SPEC §12.2).
  const scope = { issue: issueToScope(issue), attempt: attempt, branch };
  let parsed;
  try {
    parsed = engine.parse(template);
  } catch (err) {
    throw new PromptError("template_parse_error", `prompt template parse failed: ${(err as Error).message}`);
  }
  try {
    return engine.renderSync(parsed, scope) as string;
  } catch (err) {
    throw new PromptError("template_render_error", `prompt render failed: ${(err as Error).message}`);
  }
}

function issueToScope(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    native_ref: issue.native_ref,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branch_name,
    url: issue.url,
    assignee_id: issue.assignee_id,
    labels: issue.labels,
    blocked_by: issue.blocked_by,
    dispatchable: issue.dispatchable,
    follow_up_for: issue.follow_up_for,
    stream_identifier: issue.stream_identifier,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

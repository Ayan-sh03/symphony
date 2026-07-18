/**
 * Workflow Loader (SPEC §5.1, §5.2). Reads WORKFLOW.md, splits YAML front matter
 * from the prompt body, and returns {config, prompt_template}.
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { WorkflowDefinition } from "../domain/types.ts";

export type WorkflowErrorClass =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map";

export class WorkflowError extends Error {
  readonly errorClass: WorkflowErrorClass;
  constructor(errorClass: WorkflowErrorClass, message: string) {
    super(message);
    this.name = "WorkflowError";
    this.errorClass = errorClass;
  }
}

/** Default fallback prompt when the body is empty (SPEC §5.4). */
export const DEFAULT_PROMPT = "You are working on an issue from the configured tracker.";

/**
 * Resolve the workflow file path (SPEC §5.1 precedence):
 * 1. explicit path (CLI startup) 2. `WORKFLOW.md` in cwd.
 */
export function resolveWorkflowPath(explicit?: string | null): string {
  if (explicit && explicit.trim() !== "") return path.resolve(explicit);
  return path.resolve(process.cwd(), "WORKFLOW.md");
}

/**
 * Load and parse a WORKFLOW.md file. Throws WorkflowError on read/parse/shape
 * failures (SPEC §5.2, §5.5).
 */
export function loadWorkflow(filePath: string): WorkflowDefinition {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new WorkflowError(
      "missing_workflow_file",
      `cannot read workflow file at ${filePath}: ${(err as Error).message}`,
    );
  }
  return parseWorkflow(raw);
}

/** Pure parse (SPEC §5.2), separated from IO so it is directly testable. */
export function parseWorkflow(raw: string): WorkflowDefinition {
  // Normalize line endings so `---` fences match on Windows too.
  const text = raw.replace(/\r\n/g, "\n");

  if (!text.startsWith("---\n")) {
    // No front matter: the whole file is the prompt body (SPEC §5.2).
    return { config: {}, prompt_template: text.trim() };
  }

  // Find the closing fence: a line consisting solely of `---`.
  const lines = text.split("\n");
  let closeLine = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closeLine = i;
      break;
    }
  }
  if (closeLine === -1) {
    throw new WorkflowError(
      "workflow_parse_error",
      "front matter opened with `---` but no closing `---` fence was found",
    );
  }

  const fmText = lines.slice(1, closeLine).join("\n");
  const body = lines.slice(closeLine + 1).join("\n");

  let config: unknown;
  try {
    config = fmText.trim() === "" ? {} : parseYaml(fmText);
  } catch (err) {
    throw new WorkflowError(
      "workflow_parse_error",
      `invalid YAML front matter: ${(err as Error).message}`,
    );
  }
  if (config === null || config === undefined) config = {};
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new WorkflowError(
      "workflow_front_matter_not_a_map",
      "YAML front matter must decode to a map/object",
    );
  }
  return { config: config as Record<string, unknown>, prompt_template: body.trim() };
}

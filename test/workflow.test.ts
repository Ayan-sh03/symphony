import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflow, WorkflowError, DEFAULT_PROMPT } from "../src/workflow/loader.ts";

test("parses front matter and prompt body", () => {
  const wf = parseWorkflow("---\ntracker:\n  kind: file\n---\nHello {{ issue.title }}\n");
  assert.equal((wf.config.tracker as { kind: string }).kind, "file");
  assert.equal(wf.prompt_template, "Hello {{ issue.title }}");
});

test("no front matter => whole file is prompt, empty config", () => {
  const wf = parseWorkflow("Just a prompt body");
  assert.deepEqual(wf.config, {});
  assert.equal(wf.prompt_template, "Just a prompt body");
});

test("unclosed front matter is a parse error", () => {
  assert.throws(() => parseWorkflow("---\nkind: file\nno close"), (e) => e instanceof WorkflowError && e.errorClass === "workflow_parse_error");
});

test("non-map front matter is rejected", () => {
  assert.throws(() => parseWorkflow("---\n- a\n- b\n---\nbody"), (e) => e instanceof WorkflowError && e.errorClass === "workflow_front_matter_not_a_map");
});

test("empty front matter yields empty config map", () => {
  const wf = parseWorkflow("---\n---\nbody");
  assert.deepEqual(wf.config, {});
  assert.equal(wf.prompt_template, "body");
});

test("handles CRLF line endings", () => {
  const wf = parseWorkflow("---\r\ntracker:\r\n  kind: file\r\n---\r\nbody\r\n");
  assert.equal((wf.config.tracker as { kind: string }).kind, "file");
  assert.equal(wf.prompt_template, "body");
});

test("default prompt constant exists", () => {
  assert.ok(DEFAULT_PROMPT.length > 0);
});

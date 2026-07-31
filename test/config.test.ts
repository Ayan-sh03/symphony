import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { buildConfig, ConfigError, expandVars } from "../src/config/config.ts";
import { parseWorkflow } from "../src/workflow/loader.ts";

const WF = path.join(os.tmpdir(), "WORKFLOW.md");

function cfg(src: string) {
  return buildConfig(parseWorkflow(src), WF);
}

test("applies defaults for missing optional fields", () => {
  const c = cfg("---\ntracker:\n  kind: file\n---\n");
  assert.equal(c.poll_interval_ms, 30000);
  assert.equal(c.max_concurrent_agents, 10);
  assert.equal(c.max_turns, 20);
  assert.equal(c.max_retry_backoff_ms, 300000);
  assert.equal(c.max_retry_attempts, 3);
  assert.equal(c.hooks.timeout_ms, 60000);
  assert.equal(c.codex.command, "codex app-server");
  assert.equal(c.agent_kind, "codex");
  assert.equal(c.codex.turn_timeout_ms, 3600000);
});

test("$VAR resolves from environment", () => {
  process.env.SYM_TEST_VAR = "resolved";
  assert.equal(expandVars("prefix-$SYM_TEST_VAR"), "prefix-resolved");
  assert.equal(expandVars("${SYM_TEST_VAR}"), "resolved");
  delete process.env.SYM_TEST_VAR;
});

test("~ expansion in workspace root", () => {
  const c = cfg("---\ntracker:\n  kind: file\nworkspace:\n  root: ~/sym_ws_test\n---\n");
  assert.equal(c.workspace_root, path.normalize(path.join(os.homedir(), "sym_ws_test")));
});

test("relative workspace root resolves against workflow dir", () => {
  const c = cfg("---\ntracker:\n  kind: file\nworkspace:\n  root: ./ws\n---\n");
  assert.equal(c.workspace_root, path.normalize(path.join(path.dirname(WF), "ws")));
});

test("per-state concurrency normalizes keys and drops invalid", () => {
  const c = cfg("---\ntracker:\n  kind: file\nagent:\n  max_concurrent_agents_by_state:\n    \"In Progress\": 3\n    Bad: -1\n    Junk: nope\n---\n");
  assert.equal(c.max_concurrent_agents_by_state["in progress"], 3);
  assert.equal(c.max_concurrent_agents_by_state["bad"], undefined);
  assert.equal(c.max_concurrent_agents_by_state["junk"], undefined);
});

test("invalid max_turns fails validation", () => {
  assert.throws(() => cfg("---\ntracker:\n  kind: file\nagent:\n  max_turns: 0\n---\n"), (e) => e instanceof ConfigError);
});

test("max_retry_attempts: explicit value and 0 (unlimited) accepted; negative rejected", () => {
  assert.equal(cfg("---\ntracker:\n  kind: file\nagent:\n  max_retry_attempts: 7\n---\n").max_retry_attempts, 7);
  assert.equal(cfg("---\ntracker:\n  kind: file\nagent:\n  max_retry_attempts: 0\n---\n").max_retry_attempts, 0);
  assert.throws(() => cfg("---\ntracker:\n  kind: file\nagent:\n  max_retry_attempts: -1\n---\n"), (e) => e instanceof ConfigError);
});

test("codex.command preserved verbatim as shell string", () => {
  const c = cfg("---\ntracker:\n  kind: file\ncodex:\n  command: my-agent app-server --flag\n---\n");
  assert.equal(c.codex.command, "my-agent app-server --flag");
});

test("server.port parsed when present", () => {
  const c = cfg("---\ntracker:\n  kind: file\nserver:\n  port: 8080\n---\n");
  assert.equal(c.server_port, 8080);
});

test("agent.pricing unset leaves the table empty", () => {
  assert.deepEqual(cfg("---\ntracker:\n  kind: file\n---\n").agent_pricing, { default: null, by_kind: {} });
  assert.deepEqual(cfg("---\ntracker:\n  kind: file\nagent:\n  pricing: {}\n---\n").agent_pricing, { default: null, by_kind: {} });
});

test("agent.pricing flat form applies to every kind", () => {
  const c = cfg("---\ntracker:\n  kind: file\nagent:\n  pricing:\n    input_per_mtok: 2.5\n    output_per_mtok: 10\n    currency: EUR\n---\n");
  assert.deepEqual(c.agent_pricing.default, { input_per_mtok: 2.5, output_per_mtok: 10, currency: "EUR" });
  assert.deepEqual(c.agent_pricing.by_kind, {});
});

test("agent.pricing per-kind form parses each kind, keys normalized", () => {
  const c = cfg("---\ntracker:\n  kind: file\nagent:\n  pricing:\n    Codex:\n      input_per_mtok: 1\n      output_per_mtok: 2\n    opencode:\n      input_per_mtok: 3\n      output_per_mtok: 4\n---\n");
  assert.equal(c.agent_pricing.default, null);
  assert.deepEqual(Object.keys(c.agent_pricing.by_kind).sort(), ["codex", "opencode"]);
  assert.equal(c.agent_pricing.by_kind["codex"].output_per_mtok, 2);
  assert.equal(c.agent_pricing.by_kind["opencode"].input_per_mtok, 3);
});

test("agent.pricing mixes flat fallback with a per-kind override", () => {
  const c = cfg("---\ntracker:\n  kind: file\nagent:\n  pricing:\n    input_per_mtok: 1\n    output_per_mtok: 1\n    codex:\n      input_per_mtok: 5\n      output_per_mtok: 6\n---\n");
  assert.equal(c.agent_pricing.default!.input_per_mtok, 1);
  assert.equal(c.agent_pricing.by_kind["codex"].input_per_mtok, 5);
});

test("agent.pricing keeps fractional rates", () => {
  const c = cfg("---\ntracker:\n  kind: file\nagent:\n  pricing:\n    input_per_mtok: 1.25\n    output_per_mtok: 0.075\n---\n");
  assert.equal(c.agent_pricing.default!.input_per_mtok, 1.25, "rates must not be truncated to integers");
  assert.equal(c.agent_pricing.default!.output_per_mtok, 0.075);
});

test("agent.pricing rejects malformed entries", () => {
  assert.throws(() => cfg("---\ntracker:\n  kind: file\nagent:\n  pricing:\n    input_per_mtok: nope\n    output_per_mtok: 1\n---\n"), ConfigError, "non-numeric rate is rejected");
  assert.throws(() => cfg("---\ntracker:\n  kind: file\nagent:\n  pricing:\n    input_per_mtok: -1\n    output_per_mtok: 1\n---\n"), ConfigError, "negative rate is rejected");
  assert.throws(() => cfg("---\ntracker:\n  kind: file\nagent:\n  pricing:\n    input_per_mtok: 1\n---\n"), ConfigError, "half-written entry is rejected");
  assert.throws(() => cfg("---\ntracker:\n  kind: file\nagent:\n  pricing:\n    codex:\n      input_per_mtok: 1\n      output_per_mtok: 2\n      currency: USD\n    opencode:\n      input_per_mtok: 1\n      output_per_mtok: 2\n      currency: EUR\n---\n"), ConfigError, "mixed currencies are rejected");
});

test("agent.pricing defaults currency to USD and ignores stray scalars", () => {
  const c = cfg("---\ntracker:\n  kind: file\nagent:\n  pricing:\n    note: ignore me\n    made-up-kind:\n      input_per_mtok: 1\n      output_per_mtok: 2\n---\n");
  assert.equal(c.agent_pricing.by_kind["made-up-kind"].currency, "USD");
  assert.equal(c.agent_pricing.by_kind["note"], undefined);
});

test("repository delivery settings: defaults, explicit values, validation", () => {
  const d = cfg("---\ntracker:\n  kind: file\n---\n");
  assert.equal(d.workspace_repository, null);
  assert.equal(d.workspace_base_branch, null);
  assert.equal(d.workspace_branch_template, "issue/{identifier}");
  assert.equal(d.workspace_delivery_mode, "branch");
  assert.equal(d.tracker.review_state, "review");

  const c = cfg("---\ntracker:\n  kind: file\n  review_state: in review\nworkspace:\n  repository: ./repo\n  base_branch: master\n  branch_template: feat/{identifier}-work\n  delivery_mode: push\n---\n");
  assert.equal(c.workspace_base_branch, "master");
  assert.equal(c.workspace_branch_template, "feat/{identifier}-work");
  assert.equal(c.workspace_delivery_mode, "push");
  assert.equal(c.tracker.review_state, "in review");

  assert.throws(() => cfg("---\ntracker:\n  kind: file\nworkspace:\n  branch_template: fixed-name\n---\n"), ConfigError, "branch_template without the {identifier} placeholder is rejected");
  assert.throws(() => cfg("---\ntracker:\n  kind: file\nworkspace:\n  delivery_mode: merge\n---\n"), ConfigError, "unknown delivery_mode is rejected");
  assert.throws(() => cfg("---\ntracker:\n  kind: file\n  terminal_states: [done]\n  review_state: Done\n---\n"), ConfigError, "review_state colliding with a terminal state is rejected");
  assert.throws(() => cfg("---\ntracker:\n  kind: file\n  backlog_states: [backlog]\n  review_state: Backlog\n---\n"), ConfigError, "review_state colliding with a backlog state is rejected");
});

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

test("codex.command preserved verbatim as shell string", () => {
  const c = cfg("---\ntracker:\n  kind: file\ncodex:\n  command: my-agent app-server --flag\n---\n");
  assert.equal(c.codex.command, "my-agent app-server --flag");
});

test("server.port parsed when present", () => {
  const c = cfg("---\ntracker:\n  kind: file\nserver:\n  port: 8080\n---\n");
  assert.equal(c.server_port, 8080);
});

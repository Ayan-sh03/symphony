import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { detectAgentKinds } from "../src/agent/registry.ts";
import { commandExecutableToken, resolveAgentAvailability, type AgentDetection } from "../src/agent/detection.ts";
import { buildConfig } from "../src/config/config.ts";
import { parseWorkflow } from "../src/workflow/loader.ts";
import { Logger } from "../src/logger.ts";

const silent = new Logger([{ name: "null", write() {} }], "error");

function cfg() {
  const src = `---
tracker:
  kind: file
  provider:
    dir: ./issues
  active_states: ["todo"]
  terminal_states: ["done"]
agent:
  kind: codex
codex:
  command: codex app-server
opencode:
  command: opencode
---
Do work.`;
  const wf = parseWorkflow(src);
  return buildConfig(wf, path.join(process.cwd(), "WORKFLOW.md"));
}

test("agent command parsing extracts only the executable token", () => {
  assert.equal(commandExecutableToken("codex app-server"), "codex");
  assert.equal(commandExecutableToken("opencode"), "opencode");
  assert.equal(commandExecutableToken('"C:/Program Files/Codex/codex.exe" app-server'), "C:/Program Files/Codex/codex.exe");
  assert.equal(commandExecutableToken("  'C:/Tools/opencode.exe' run --flag"), "C:/Tools/opencode.exe");
  assert.equal(commandExecutableToken(""), null);
  // Malformed: an unterminated quote is not an executable called "codex app-server".
  assert.equal(commandExecutableToken('"codex app-server'), null);
  assert.equal(commandExecutableToken('""'), null);
});

function det(kind: string, usable: boolean): AgentDetection {
  return { kind, registered: true, installed: usable, command: kind, command_field: `${kind}.command`, usable, reason: usable ? undefined : `${kind} not found on PATH`, checked_at: "2026-08-01T00:00:00.000Z" };
}

test("a missing configured default falls back only when there is exactly one alternative", () => {
  const one = resolveAgentAvailability([det("codex", false), det("opencode", true)], "codex", null);
  assert.equal(one.effective_default, "opencode");
  assert.equal(one.auto_default, "opencode");
  assert.equal(one.blocked, false);
  assert.match(one.reason ?? "", /only installed backend/);

  // Two candidates: guessing would silently run tasks on an agent nobody chose.
  const many = resolveAgentAvailability([det("codex", false), det("opencode", true), det("other", true)], "codex", null);
  assert.equal(many.blocked, true);
  assert.equal(many.auto_default, null);
  assert.equal(many.effective_default, "codex");

  // Nothing installed at all is also a block, not a silent fallback.
  assert.equal(resolveAgentAvailability([det("codex", false)], "codex", null).blocked, true);
});

test("an operator's runtime override outranks discovery; an unprobed set decides nothing", () => {
  const overridden = resolveAgentAvailability([det("codex", false), det("opencode", true), det("other", true)], "codex", "opencode");
  assert.equal(overridden.effective_default, "opencode");
  assert.equal(overridden.blocked, false);

  const stale = resolveAgentAvailability([], "codex", null);
  assert.equal(stale.stale, true);
  assert.equal(stale.blocked, false);
  assert.equal(stale.effective_default, "codex");
});

test("an override the host cannot run blocks instead of quietly reverting to WORKFLOW.md", () => {
  // The console lets an operator pick an uninstalled backend on purpose. Reporting
  // the configured default here while dispatch honors the override is how a missing
  // CLI reaches a spawn — the effective default must be the one we would run.
  const av = resolveAgentAvailability([det("codex", true), det("opencode", false)], "codex", "opencode");
  assert.equal(av.effective_default, "opencode");
  assert.equal(av.blocked, true);
  assert.equal(av.auto_default, null);
  assert.match(av.reason ?? "", /runtime default opencode cannot run/);
  assert.match(av.reason ?? "", /not found on PATH/);
});

test("checked_at reports the newest probe, not whichever backend happens to be first", () => {
  const older = { ...det("codex", true), checked_at: "2026-08-01T00:00:00.000Z" };
  const newer = { ...det("opencode", true), checked_at: "2026-08-02T00:00:00.000Z" };
  assert.equal(resolveAgentAvailability([older, newer], "codex", null).checked_at, newer.checked_at);
  assert.equal(resolveAgentAvailability([newer, older], "codex", null).checked_at, newer.checked_at);
});

test("detectAgentKinds reports registered backends using an injectable executable resolver", async () => {
  const statuses = await detectAgentKinds(cfg(), silent, {
    resolveExecutable: async (exe) => exe === "codex" ? "C:/Tools/codex.cmd" : null,
  });

  const byKind = Object.fromEntries(statuses.map((s) => [s.kind, s]));
  assert.equal(byKind.codex.registered, true);
  assert.equal(byKind.codex.installed, true);
  assert.equal(byKind.codex.usable, true);
  assert.equal(byKind.codex.command, "codex app-server");
  assert.equal(byKind.codex.path, "C:/Tools/codex.cmd");

  assert.equal(byKind.opencode.registered, true);
  assert.equal(byKind.opencode.installed, false);
  assert.equal(byKind.opencode.usable, false);
  assert.equal(byKind.opencode.command, "opencode");
  assert.match(byKind.opencode.reason ?? "", /not found/i);
});

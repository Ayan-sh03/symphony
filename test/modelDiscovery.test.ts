/**
 * Model discovery (extension, SPEC Appendix B.7). Covers the registry passthrough and
 * the two pure parsers. Nothing here spawns a real `codex`/`opencode` — discovery that
 * shells out is exercised only through fake factories and raw payloads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { listAgentModels, registerAgentFactory } from "../src/agent/registry.ts";
import { toAgentModels } from "../src/agent/codexModels.ts";
import { parseModelLines } from "../src/agent/opencodeModels.ts";
import type { AgentModel, AgentSession, ModelQuery } from "../src/agent/types.ts";
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

function query(): ModelQuery {
  return { config: cfg(), logger: silent, env: {} };
}

/** A backend that exists but says nothing about models. */
const noCapability = {
  kind: "test-no-listmodels",
  create(): AgentSession {
    throw new Error("not used in this test");
  },
};

function fakeFactory(kind: string, listModels: (q: ModelQuery) => Promise<AgentModel[]>) {
  return {
    kind,
    create(): AgentSession {
      throw new Error("not used in this test");
    },
    listModels,
  };
}

test("listAgentModels returns [] for an unknown kind and for a backend without the capability", async () => {
  assert.deepEqual(await listAgentModels("no-such-agent", query()), []);

  registerAgentFactory(noCapability);
  assert.deepEqual(await listAgentModels(noCapability.kind, query()), []);
});

test("a backend's model list comes back through the registry intact", async () => {
  const listing: AgentModel[] = [
    { id: "vendor/a", label: "Model A" },
    { id: "vendor/b", default: true },
  ];
  registerAgentFactory(fakeFactory("test-lists-models", async () => listing));

  assert.deepEqual(await listAgentModels("test-lists-models", query()), listing);
});

test("a backend that fails discovery yields [], never a rejection", async () => {
  // Discovery is console garnish: a broken CLI must not become an orchestration error.
  registerAgentFactory(
    fakeFactory("test-throws-sync", () => {
      throw new Error("boom");
    }),
  );
  registerAgentFactory(
    fakeFactory("test-rejects", () => Promise.reject(new Error("async boom"))),
  );

  assert.deepEqual(await listAgentModels("test-throws-sync", query()), []);
  assert.deepEqual(await listAgentModels("test-rejects", query()), []);
});

test("toAgentModels drops hidden entries, falls back to `model`, and skips the unidentifiable", () => {
  const models = toAgentModels(
    [
      { id: "gpt-5.5", displayName: "GPT-5.5" },
      { id: "codex-auto-review", hidden: true },
      { model: "gpt-5.6-terra" }, // no `id` — the `model` field names it
      { displayName: "nameless" }, // neither: not selectable, not shown
    ],
    null,
  );

  assert.deepEqual(models, [{ id: "gpt-5.5", label: "GPT-5.5" }, { id: "gpt-5.6-terra" }]);
});

test("the configured default wins over the backend's own isDefault", () => {
  // The verified codex trap: `model/list` marks isDefault on its newest model
  // (gpt-5.6-terra) while `config/read` reports config.model = gpt-5.5. Reporting the
  // former would name a model dispatch never runs.
  const models = toAgentModels(
    [
      { id: "gpt-5.6-terra", isDefault: true },
      { id: "gpt-5.5" },
    ],
    "gpt-5.5",
  );

  assert.equal(models.find((m) => m.id === "gpt-5.6-terra")?.default, undefined);
  assert.equal(models.find((m) => m.id === "gpt-5.5")?.default, true);
  assert.equal(models.filter((m) => m.default === true).length, 1);
});

test("a configured default missing from the listing is still shown as the default", () => {
  // dispatch would use it regardless of what codex chose to list.
  const models = toAgentModels([{ id: "gpt-5.6-terra", isDefault: true }], "gpt-6-preview");

  assert.equal(models[0].id, "gpt-6-preview");
  assert.equal(models[0].default, true);
  assert.match(models[0].label ?? "", /codex config/);
  assert.equal(models[1].id, "gpt-5.6-terra");
  assert.equal(models[1].default, undefined);
});

test("with nothing configured, isDefault is the default — the one case it describes dispatch", () => {
  const models = toAgentModels([{ id: "gpt-5.5" }, { id: "gpt-5.6-terra", isDefault: true }], null);

  assert.equal(models.find((m) => m.id === "gpt-5.5")?.default, undefined);
  assert.equal(models.find((m) => m.id === "gpt-5.6-terra")?.default, true);
});

test("parseModelLines keeps identifier lines in order, de-duplicated, and ignores banners", () => {
  const stdout = [
    "opencode",
    "",
    "  ▄  ",
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-opus-4-1",
    "openai/gpt-5",
    "anthropic/claude sonnet 4 5", // whitespace: not an identifier
    "  openai/gpt-5  ", // duplicate once trimmed
    "not-a-model",
  ].join("\n");

  assert.deepEqual(parseModelLines(stdout, null), [
    { id: "anthropic/claude-sonnet-4-5" },
    { id: "anthropic/claude-opus-4-1" },
    { id: "openai/gpt-5" },
  ]);
});

test("parseModelLines flags the configured default in place, prepends it when unlisted, none when null", () => {
  const stdout = "anthropic/claude-sonnet-4-5\nopenai/gpt-5\n";

  const listed = parseModelLines(stdout, "openai/gpt-5");
  assert.equal(listed.length, 2);
  assert.equal(listed.find((m) => m.id === "openai/gpt-5")?.default, true);
  assert.equal(listed.find((m) => m.id === "anthropic/claude-sonnet-4-5")?.default, undefined);

  // Configured but unlisted still runs — opencode gets it via `-m`.
  const unlisted = parseModelLines(stdout, "local/my-model");
  assert.equal(unlisted[0].id, "local/my-model");
  assert.equal(unlisted[0].default, true);
  assert.match(unlisted[0].label ?? "", /WORKFLOW\.md/);
  assert.equal(unlisted.length, 3);

  // opencode marks no default of its own, so nothing configured means nothing flagged.
  assert.equal(parseModelLines(stdout, null).some((m) => m.default === true), false);
});

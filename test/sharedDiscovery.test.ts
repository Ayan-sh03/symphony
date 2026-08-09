import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentDiscoveryCache } from "../src/agent/discoveryCache.ts";

const config = {} as never;
const logger = {} as never;

test("shared discovery joins equivalent availability probes and preserves refresh semantics", async () => {
  let calls = 0;
  let release!: () => void;
  let now = 0;
  const cache = new AgentDiscoveryCache({
    availabilityKey: () => "same-command",
    modelKey: () => "unused",
    detect: async () => {
      calls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return [{ kind: "codex", registered: true, installed: true, command: "codex", command_field: "codex.command", usable: true, checked_at: "now" }];
    },
    listModels: async () => [],
    now: () => now,
  });

  const first = cache.detect(config, logger);
  const second = cache.detect(config, logger);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, "equivalent projects must share their in-flight probe");
  release();
  assert.deepEqual(await first, await second);
  await cache.detect(config, logger);
  assert.equal(calls, 1, "a completed probe is reused until refresh");

  now = 1001;
  const refresh = cache.detect(config, logger, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, "refresh starts a fresh probe after the cache's force floor");
  release();
  await refresh;
});

test("shared discovery separates availability commands and model credentials", async () => {
  const availabilityCalls: string[] = [];
  const modelCalls: string[] = [];
  const cache = new AgentDiscoveryCache({
    availabilityKey: (cfg) => String(cfg),
    modelKey: (_kind, query) => `${query.config}:${query.env.TOKEN ?? ""}`,
    detect: async (cfg) => {
      availabilityCalls.push(String(cfg));
      return [];
    },
    listModels: async (_kind, query) => {
      modelCalls.push(`${query.config}:${query.env.TOKEN ?? ""}`);
      return [];
    },
  });

  await Promise.all([cache.detect("codex-a" as never, logger), cache.detect("codex-b" as never, logger)]);
  await Promise.all([
    cache.modelsFor("codex", { config: "same-command" as never, logger, env: { TOKEN: "one" } }),
    cache.modelsFor("codex", { config: "same-command" as never, logger, env: { TOKEN: "two" } }),
  ]);

  assert.deepEqual(availabilityCalls, ["codex-a", "codex-b"]);
  assert.deepEqual(modelCalls, ["same-command:one", "same-command:two"]);
});

test("equivalent model discovery joins one in-flight credential-scoped probe", async () => {
  let calls = 0;
  let release!: () => void;
  const cache = new AgentDiscoveryCache({
    availabilityKey: () => "unused",
    modelKey: (_kind, query) => String(query.config),
    detect: async () => [],
    listModels: async () => {
      calls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return [{ id: "vendor/model" }];
    },
  });
  const query = { config: "same-command" as never, logger, env: { TOKEN: "same-credential" } };

  const first = cache.modelsFor("codex", query);
  const second = cache.modelsFor("codex", query);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, await second);
  await cache.modelsFor("codex", query);
  assert.equal(calls, 1, "the completed credential-scoped model listing is cached");
});

test("a failed shared probe is isolated and can be retried", async () => {
  let calls = 0;
  const cache = new AgentDiscoveryCache({
    availabilityKey: () => "same",
    modelKey: () => "unused",
    detect: async () => {
      calls += 1;
      if (calls === 1) throw new Error("unavailable");
      return [];
    },
    listModels: async () => [],
  });

  await assert.rejects(cache.detect(config, logger), /unavailable/);
  await cache.detect(config, logger);
  assert.equal(calls, 2);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentDiscoveryCache } from "../src/agent/discoveryCache.ts";
import { agentModelDiscoveryCacheKey } from "../src/agent/registry.ts";

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

test("an older in-flight probe cannot overwrite a completed forced refresh", async () => {
  let now = 0;
  const releases: ((value: string) => void)[] = [];
  const cache = new AgentDiscoveryCache({
    availabilityKey: () => "same",
    modelKey: () => "unused",
    detect: () => new Promise((resolve) => releases.push((value) => resolve([{
      kind: value,
      registered: true,
      installed: true,
      command: value,
      command_field: `${value}.command`,
      usable: true,
      checked_at: value,
    }]))),
    listModels: async () => [],
    now: () => now,
  });

  const oldProbe = cache.detect(config, logger);
  await new Promise((resolve) => setImmediate(resolve));
  now = 1001;
  const refreshed = cache.detect(config, logger, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 2);

  releases[1]!("new");
  assert.equal((await refreshed)[0]?.kind, "new");
  releases[0]!("old");
  assert.equal((await oldProbe)[0]?.kind, "old", "the original caller still receives its own result");
  assert.equal((await cache.detect(config, logger))[0]?.kind, "new", "cache publication follows probe generation, not completion order");
});

test("built-in model cache keys separate identical commands run from different cwd", () => {
  const query = (kind: "codex" | "opencode", workflowDir: string) => ({
    config: {
      workflowDir,
      codex: { command: "codex app-server" },
      opencode: { command: "opencode", model: null },
    } as never,
    logger,
    env: {},
    kind,
  });

  for (const kind of ["codex", "opencode"] as const) {
    const left = query(kind, "C:/projects/left");
    const right = query(kind, "C:/projects/right");
    assert.notEqual(agentModelDiscoveryCacheKey(kind, left), agentModelDiscoveryCacheKey(kind, right));
  }
});

test("an older successful model probe survives a newer forced empty failure sentinel", async () => {
  let now = 0;
  let calls = 0;
  const releases: ((models: { id: string }[]) => void)[] = [];
  const cache = new AgentDiscoveryCache({
    availabilityKey: () => "unused",
    modelKey: () => "same",
    detect: async () => [],
    listModels: () => {
      calls += 1;
      return new Promise((resolve) => releases.push(resolve));
    },
    now: () => now,
  });
  const query = { config, logger, env: {} };

  const older = cache.modelsFor("codex", query);
  await new Promise((resolve) => setImmediate(resolve));
  now = 2001;
  const forced = cache.modelsFor("codex", query, true);
  await new Promise((resolve) => setImmediate(resolve));

  releases[1]!([]);
  assert.deepEqual(await forced, [], "the refresh caller sees that its own probe failed");
  releases[0]!([{ id: "good" }]);
  assert.deepEqual(await older, [{ id: "good" }], "the original caller sees its successful result");
  assert.deepEqual(await cache.modelsFor("codex", query), [{ id: "good" }]);
  assert.equal(calls, 2, "the older success becomes last-known-good instead of forcing a third probe");
});

test("a forced empty model result returns empty but preserves an existing last-known-good", async () => {
  let now = 0;
  let calls = 0;
  const cache = new AgentDiscoveryCache({
    availabilityKey: () => "unused",
    modelKey: () => "same",
    detect: async () => [],
    listModels: async () => {
      calls += 1;
      return calls === 1 ? [{ id: "good" }] : [];
    },
    now: () => now,
  });
  const query = { config, logger, env: {} };

  assert.deepEqual(await cache.modelsFor("codex", query), [{ id: "good" }]);
  now = 2001;
  assert.deepEqual(await cache.modelsFor("codex", query, true), []);
  assert.deepEqual(await cache.modelsFor("codex", query), [{ id: "good" }]);
  assert.equal(calls, 2);
});

test("an initial empty model result is not shared for the TTL", async () => {
  let calls = 0;
  const cache = new AgentDiscoveryCache({
    availabilityKey: () => "unused",
    modelKey: () => "same",
    detect: async () => [],
    listModels: async () => {
      calls += 1;
      return calls === 1 ? [] : [{ id: "recovered" }];
    },
  });
  const query = { config, logger, env: {} };

  assert.deepEqual(await cache.modelsFor("codex", query), []);
  assert.deepEqual(await cache.modelsFor("codex", query), [{ id: "recovered" }]);
  assert.equal(calls, 2, "an equivalent project retries instead of inheriting an empty failure sentinel");
});

test("repeated forced cold availability requests share one hanging probe and clean up after settle", async () => {
  let calls = 0;
  let now = 0;
  const releases: (() => void)[] = [];
  const cache = new AgentDiscoveryCache({
    availabilityKey: () => "same",
    modelKey: () => "unused",
    detect: async () => {
      calls += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      return [];
    },
    listModels: async () => [],
    now: () => now,
  });

  const cold = Array.from({ length: 5 }, () => cache.detect(config, logger, true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, "forced cold requests must coalesce while the probe is unresolved");
  releases[0]!();
  await Promise.all(cold);

  now = 1001;
  const refreshed = cache.detect(config, logger, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, "a settled forced probe must be removed so a later refresh can run");
  releases[1]!();
  await refreshed;
});

test("repeated forced cold model requests share one hanging probe", async () => {
  let calls = 0;
  const releases: ((models: { id: string }[]) => void)[] = [];
  const cache = new AgentDiscoveryCache({
    availabilityKey: () => "unused",
    modelKey: () => "same",
    detect: async () => [],
    listModels: () => {
      calls += 1;
      return new Promise((resolve) => releases.push(resolve));
    },
  });
  const query = { config, logger, env: {} };

  const cold = Array.from({ length: 5 }, () => cache.modelsFor("codex", query, true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, "forced model refreshes must coalesce while cold and unresolved");
  releases[0]!([{ id: "shared" }]);
  for (const result of await Promise.all(cold)) assert.deepEqual(result, [{ id: "shared" }]);
});

test("one forced refresh may overlap a normal probe but repeated forced requests join it", async () => {
  let calls = 0;
  let now = 0;
  const releases: ((value: string) => void)[] = [];
  const cache = new AgentDiscoveryCache({
    availabilityKey: () => "same",
    modelKey: () => "unused",
    detect: () => {
      calls += 1;
      return new Promise((resolve) => releases.push((value) => resolve([{
        kind: value,
        registered: true,
        installed: true,
        command: value,
        command_field: `${value}.command`,
        usable: true,
        checked_at: value,
      }])));
    },
    listModels: async () => [],
    now: () => now,
  });

  const normal = cache.detect(config, logger);
  await new Promise((resolve) => setImmediate(resolve));
  now = 1001;
  const forcedOne = cache.detect(config, logger, true);
  const forcedTwo = cache.detect(config, logger, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, "work is bounded to the old normal probe plus one forced refresh");

  releases[1]!("new");
  assert.equal((await forcedOne)[0]?.kind, "new");
  assert.equal((await forcedTwo)[0]?.kind, "new");
  releases[0]!("old");
  await normal;
});

test("a failed forced probe is shared, cleaned up, and retryable", async () => {
  let calls = 0;
  const failures: ((error: Error) => void)[] = [];
  const cache = new AgentDiscoveryCache({
    availabilityKey: () => "same",
    modelKey: () => "unused",
    detect: () => {
      calls += 1;
      if (calls > 1) return Promise.resolve([]);
      return new Promise((_resolve, reject) => failures.push(reject));
    },
    listModels: async () => [],
  });

  const first = cache.detect(config, logger, true);
  const joined = cache.detect(config, logger, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, "concurrent forced callers must share the failing probe");
  failures[0]!(new Error("unavailable"));
  await assert.rejects(first, /unavailable/);
  await assert.rejects(joined, /unavailable/);

  await cache.detect(config, logger, true);
  assert.equal(calls, 2, "failure cleanup must allow a fresh forced retry");
});

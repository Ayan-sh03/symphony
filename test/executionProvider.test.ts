/**
 * Execution provider contract (issue #34). A provider owns processes and files for
 * one workspace; callers select it only through the registry and declared capabilities.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { Logger } from "../src/logger.ts";
import {
  createExecutionSession,
  executionProviderCapabilities,
  isSupportedExecutionKind,
  registerExecutionProviderFactory,
  requireExecutionCapabilities,
  supportedExecutionKinds,
  supportsExecutionCapability,
  validateExecutionProvider,
} from "../src/execution/registry.ts";
import type {
  ExecutionProviderFactory,
  ExecutionSession,
  ExecutionSessionOptions,
  ProcessHandle,
} from "../src/execution/types.ts";

const silent = new Logger([{ name: "null", write() {} }], "error");

async function streamText(stream: Readable): Promise<string> {
  stream.setEncoding("utf8");
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

test("a fake provider is selected through the registry and reports capabilities", async () => {
  let validated: Record<string, unknown> | null = null;
  let received: ExecutionSessionOptions | null = null;
  const fakeSession = {
    runtimeId: "fake-runtime",
    async spawn(): Promise<ProcessHandle> { throw new Error("not used"); },
    async close() { /* no-op */ },
  } satisfies ExecutionSession;
  const factory: ExecutionProviderFactory = {
    kind: "fake-issue-34",
    capabilities: ["process"],
    validate(provider) { validated = provider; },
    create(opts) {
      received = opts;
      return fakeSession;
    },
  };
  registerExecutionProviderFactory(factory);

  const provider = { region: "test" };
  assert.equal(isSupportedExecutionKind(factory.kind), true);
  assert.ok(supportedExecutionKinds().includes(factory.kind));
  validateExecutionProvider(factory.kind, provider);
  assert.deepEqual(validated, provider);
  assert.equal(supportsExecutionCapability(factory.kind, "process"), true);
  assert.equal(supportsExecutionCapability(factory.kind, "filesystem"), false);
  assert.deepEqual(executionProviderCapabilities(factory.kind), ["process"]);
  assert.doesNotThrow(() => requireExecutionCapabilities(factory.kind, ["process"]));
  assert.throws(
    () => requireExecutionCapabilities(factory.kind, ["filesystem"]),
    /fake-issue-34.*filesystem/,
  );

  const workspacePath = path.join(os.tmpdir(), "fake-execution-workspace");
  const session = await createExecutionSession(factory.kind, provider, {
    workspacePath,
    env: { TEST_VALUE: "present" },
    logger: silent,
  });
  assert.equal(session, fakeSession);
  assert.equal(received!.workspacePath, workspacePath);
  assert.deepEqual(received!.provider, provider);
  assert.equal(received!.env.TEST_VALUE, "present");
});

test("the local provider preserves shell, stream, and workspace file behavior", async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "sym-local-execution-"));
  const session = await createExecutionSession("local", {}, {
    workspacePath,
    env: process.env,
    logger: silent,
  });
  try {
    assert.equal(supportsExecutionCapability("local", "process"), true);
    assert.equal(supportsExecutionCapability("local", "filesystem"), true);

    await session.writeFile!("nested/result.txt", "from local provider\n");
    assert.equal(Buffer.from(await session.readFile!("nested/result.txt")).toString("utf8"), "from local provider\n");
    await session.removeFile!("nested/result.txt");
    await assert.rejects(() => session.readFile!("nested/result.txt"), /ENOENT/);
    await assert.rejects(() => session.writeFile!("../escape.txt", "nope"), /outside the workspace/);

    const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('local-ok')"`;
    const proc = await session.spawn!(command);
    const stdout = streamText(proc.stdout);
    const result = await proc.wait();
    assert.equal(result.code, 0);
    assert.equal(await stdout, "local-ok");
    assert.equal(await proc.exit, result, "wait() and exit expose one stable outcome");
    await proc.kill(); // already settled: termination remains safe and idempotent
  } finally {
    await session.close();
    await session.close();
    await assert.rejects(() => session.spawn!("node --version"), /session is closed/);
    await assert.rejects(() => session.readFile!("anything"), /session is closed/);
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("unknown providers fail validation, capability checks, and construction clearly", async () => {
  assert.throws(
    () => registerExecutionProviderFactory({ kind: " ", capabilities: [], create: async () => ({ runtimeId: null, async close() {} }) }),
    /kind must not be empty/,
  );
  assert.throws(() => validateExecutionProvider("missing-provider", {}), /unsupported execution.kind/);
  assert.throws(() => requireExecutionCapabilities("missing-provider", ["process"]), /unsupported execution.kind/);
  await assert.rejects(
    () => createExecutionSession("missing-provider", {}, {
      workspacePath: os.tmpdir(),
      env: process.env,
      logger: silent,
    }),
    /unsupported execution.kind/,
  );
});

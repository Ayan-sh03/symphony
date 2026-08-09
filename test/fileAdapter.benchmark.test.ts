import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { FileTrackerAdapter } from "../src/tracker/fileAdapter.ts";
import { Logger } from "../src/logger.ts";

const silent = new Logger([{ name: "null", write() {} }], "error");

interface Sample {
  size: number;
  lookupMs: number;
  mutationMs: number;
  eventLoopTurns: number;
}

async function sample(size: number): Promise<Sample> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tr-bench-"));
  for (let i = 0; i < size; i++) {
    fs.writeFileSync(path.join(dir, `${i}.json`), JSON.stringify({
      id: `I-${i}`,
      identifier: `I-${i}`,
      title: `issue ${i}`,
      state: "todo",
    }));
  }

  const adapter = new FileTrackerAdapter({ dir, logger: silent });
  let eventLoopTurns = 0;
  let pulse = true;
  const turn = () => {
    eventLoopTurns++;
    if (pulse) setImmediate(turn);
  };
  setImmediate(turn);
  await adapter.fetchIssuesByIds([`I-${size - 1}`]);

  const lookupStart = performance.now();
  for (let i = 0; i < 30; i++) await adapter.fetchIssuesByIds([`I-${size - 1}`]);
  const lookupMs = (performance.now() - lookupStart) / 30;

  const mutationStart = performance.now();
  for (let i = 0; i < 10; i++) await adapter.setIssueState(`I-${size - 1}`, i % 2 === 0 ? "done" : "todo");
  const mutationMs = (performance.now() - mutationStart) / 10;
  pulse = false;
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { size, lookupMs, mutationMs, eventLoopTurns };
}

test("benchmark: steady single-ID work scales sub-linearly and keeps the event loop responsive", async (t) => {
  const small = await sample(40);
  const large = await sample(800);
  t.diagnostic(JSON.stringify({ small, large }));

  assert.ok(small.eventLoopTurns > 0 && large.eventLoopTurns > 0, "directory indexing yields to the event loop");
  assert.ok(large.lookupMs <= small.lookupMs * 6 + 1, "20x more files stays well below linear lookup growth");
  assert.ok(large.mutationMs <= small.mutationMs * 6 + 2, "20x more files stays well below linear mutation growth");
});

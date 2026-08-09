import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectManager } from "../src/project/manager.ts";
import { saveManifest, loadManifest } from "../src/project/manifest.ts";
import { Logger } from "../src/logger.ts";

const silent = new Logger([{ name: "null", write() {} }], "error");

const WF = `---
tracker:
  kind: file
  provider:
    dir: ./issues
  active_states: ["todo"]
  terminal_states: ["done"]
polling:
  interval_ms: 60000
workspace:
  root: ./.ws
---
Do work.`;

/** Scaffold a project directory (WORKFLOW.md + issues/) and return its workflow path. */
function project(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "issues"), { recursive: true });
  fs.writeFileSync(path.join(dir, "WORKFLOW.md"), WF);
  return path.join(dir, "WORKFLOW.md");
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sym-mgr-"));
}

test("fromManifest builds one project per entry and skips broken ones", () => {
  const root = tmpRoot();
  project(root, "a");
  project(root, "b");
  const mp = path.join(root, "projects.json");
  saveManifest(mp, [
    { id: "a", name: "A", workflow: "./a/WORKFLOW.md" },
    { id: "b", name: "B", workflow: "./b/WORKFLOW.md" },
    { id: "broken", name: "Broken", workflow: "./nope/WORKFLOW.md" },
  ]);
  const mgr = ProjectManager.fromManifest(mp, silent);
  try {
    assert.equal(mgr.list().length, 2);
    assert.ok(mgr.get("a"));
    assert.ok(mgr.get("b"));
    assert.equal(mgr.get("broken"), null);
    assert.equal(mgr.firstId(), "a");
    assert.equal(mgr.canAdd(), true);
  } finally {
    mgr.stopAll();
  }
});

test("add registers, starts, and persists a new project", async () => {
  const root = tmpRoot();
  project(root, "a");
  const cWorkflow = project(root, "c");
  const mp = path.join(root, "projects.json");
  saveManifest(mp, [{ id: "a", name: "A", workflow: "./a/WORKFLOW.md" }]);

  const mgr = ProjectManager.fromManifest(mp, silent);
  try {
    const summary = await mgr.add({ name: "C", workflow: cWorkflow });
    assert.ok(mgr.get(summary.id));
    assert.equal(mgr.list().length, 2);
    // Persisted to the manifest so it survives restart.
    assert.equal(loadManifest(mp).length, 2);
    // Registering the same workflow twice is rejected.
    await assert.rejects(mgr.add({ workflow: cWorkflow }), /already registered/);
  } finally {
    mgr.stopAll();
  }
});

test("single-project mode uses id 'default' and cannot add", async () => {
  const root = tmpRoot();
  const wf = project(root, "solo");
  const mgr = ProjectManager.fromSingleWorkflow(wf, silent);
  try {
    assert.equal(mgr.firstId(), "default");
    assert.equal(mgr.canAdd(), false);
    await assert.rejects(mgr.add({ workflow: wf }), /requires a projects manifest/);
  } finally {
    mgr.stopAll();
  }
});

test("startup benchmark: projects start in bounded parallel waves and failures stay isolated", async () => {
  const root = tmpRoot();
  const entries = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, workflow: `./p${i}/WORKFLOW.md` }));
  for (const entry of entries) project(root, entry.id);
  const mp = path.join(root, "projects.json");
  saveManifest(mp, entries);
  const mgr = ProjectManager.fromManifest(mp, silent);
  const releases: (() => void)[] = [];
  let running = 0;
  let peak = 0;
  let started = 0;
  for (const entry of entries) {
    const p = mgr.get(entry.id)!;
    Object.defineProperty(p.orchestrator, "start", { value: async () => {
      started += 1;
      if (entry.id === "p2") throw new Error("broken project");
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => releases.push(() => { running -= 1; resolve(); }));
    } });
    Object.defineProperty(p.watcher, "start", { value: () => {} });
  }

  try {
    const starting = mgr.startAll();
    while (started < 5) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(peak, 4, "the startup benchmark should fill, but not exceed, the four-project limit");
    while (releases.length > 0) releases.shift()!();
    while (started < entries.length) {
      await new Promise((resolve) => setImmediate(resolve));
      while (releases.length > 0) releases.shift()!();
    }
    await starting;
    assert.equal(started, entries.length, "one failed project must not block later startup waves");
  } finally {
    mgr.stopAll();
  }
});

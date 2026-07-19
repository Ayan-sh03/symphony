import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectManager } from "../src/project/manager.ts";
import { saveManifest } from "../src/project/manifest.ts";
import { SymphonyHttpServer } from "../src/server/httpServer.ts";
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

/** Scaffold a project with a single issue, and return its workflow path. */
function project(root: string, name: string, issueId: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "issues"), { recursive: true });
  fs.writeFileSync(path.join(dir, "WORKFLOW.md"), WF);
  fs.writeFileSync(
    path.join(dir, "issues", `${issueId}.json`),
    JSON.stringify({ identifier: issueId, title: `title ${issueId}`, state: "todo" }),
  );
  return path.join(dir, "WORKFLOW.md");
}

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sym-http-"));
  project(root, "a", "A-1");
  project(root, "b", "B-1");
  const mp = path.join(root, "projects.json");
  saveManifest(mp, [
    { id: "a", name: "A", workflow: "./a/WORKFLOW.md" },
    { id: "b", name: "B", workflow: "./b/WORKFLOW.md" },
  ]);
  const mgr = ProjectManager.fromManifest(mp, silent);
  const server = new SymphonyHttpServer({ manager: mgr, logger: silent, port: 0 });
  const port = await server.listen();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    mgr.stopAll();
  }
}

test("GET /api/v1/projects lists every project and advertises add support", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/projects`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.projects.length, 2);
    assert.equal(body.can_add, true);
    assert.equal(body.default, "a");
    assert.deepEqual(body.projects.map((p: { id: string }) => p.id).sort(), ["a", "b"]);
  });
});

test("project-scoped state hits the right orchestrator; unknown project 404s", async () => {
  await withServer(async (base) => {
    const ok = await fetch(`${base}/api/v1/projects/a/state`);
    assert.equal(ok.status, 200);
    const snap = (await ok.json()) as any;
    assert.ok(snap.meta && Array.isArray(snap.running));

    const missing = await fetch(`${base}/api/v1/projects/nope/state`);
    assert.equal(missing.status, 404);
    const err = (await missing.json()) as any;
    assert.equal(err.error.code, "project_not_found");
  });
});

test("board views are isolated per project", async () => {
  await withServer(async (base) => {
    const a = (await (await fetch(`${base}/api/v1/projects/a/issues`)).json()) as any;
    const b = (await (await fetch(`${base}/api/v1/projects/b/issues`)).json()) as any;
    const aIds = a.issues.map((i: { identifier: string }) => i.identifier);
    const bIds = b.issues.map((i: { identifier: string }) => i.identifier);
    assert.deepEqual(aIds, ["A-1"]);
    assert.deepEqual(bIds, ["B-1"]);
  });
});

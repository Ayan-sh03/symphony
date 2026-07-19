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

test("console shell references the static app; /ui/ serves modules, css, and vendored lit-html", async () => {
  await withServer(async (base) => {
    const shell = await fetch(`${base}/`);
    assert.equal(shell.status, 200);
    const html = await shell.text();
    assert.ok(html.includes('src="/ui/app.js"'));
    assert.ok(html.includes('href="/ui/styles.css"'));
    assert.ok(html.includes("window.__SYMPHONY__"));

    const js = await fetch(`${base}/ui/app.js`);
    assert.equal(js.status, 200);
    assert.ok(js.headers.get("content-type")!.startsWith("text/javascript"));

    const css = await fetch(`${base}/ui/styles.css`);
    assert.equal(css.status, 200);
    assert.ok(css.headers.get("content-type")!.startsWith("text/css"));

    const lit = await fetch(`${base}/ui/vendor/lit-html/lit-html.js`);
    assert.equal(lit.status, 200);
    assert.ok(lit.headers.get("content-type")!.startsWith("text/javascript"));
    const rep = await fetch(`${base}/ui/vendor/lit-html/directives/repeat.js`);
    assert.equal(rep.status, 200);
  });
});

test("/ui/ rejects unknown assets, foreign extensions, and path traversal", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/ui/nope.js`)).status, 404);
    assert.equal((await fetch(`${base}/ui/store.ts`)).status, 404);
    assert.equal((await fetch(`${base}/ui/..%2F..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${base}/ui/vendor/lit-html/..%2F..%2Fyaml/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/ui/app.js`, { method: "POST" })).status, 405);
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { ProjectManager } from "../src/project/manager.ts";
import { saveManifest } from "../src/project/manifest.ts";
import { SymphonyHttpServer } from "../src/server/httpServer.ts";
import { OrchestratorError, type OrchestratorErrorCode } from "../src/orchestrator/orchestrator.ts";
import { registerAgentFactory } from "../src/agent/registry.ts";
import type { AgentModel, AgentSession } from "../src/agent/types.ts";
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
    // backlog on purpose: an active-state issue would dispatch a real agent on tick.
    JSON.stringify({ identifier: issueId, title: `title ${issueId}`, state: "backlog" }),
  );
  return path.join(dir, "WORKFLOW.md");
}

async function withServer(fn: (base: string, mgr: ProjectManager, server: SymphonyHttpServer) => Promise<void>): Promise<void> {
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
    await fn(`http://127.0.0.1:${port}`, mgr, server);
  } finally {
    server.close();
    mgr.stopAll();
  }
}

/** A response whose kernel buffer stays full until the test explicitly emits drain. */
class SlowSseResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writes: string[] = [];
  private results: boolean[];

  constructor(results: boolean[]) {
    super();
    this.results = results;
  }

  writeHead(): void {}
  flushHeaders(): void {}
  write(payload: string): boolean {
    this.writes.push(payload);
    return this.results.shift() ?? true;
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
    // The console reads cost off the wire; unpriced projects must still carry the key.
    assert.ok("estimated_cost" in snap.codex_totals);
    assert.equal(snap.codex_totals.estimated_cost, null);

    const missing = await fetch(`${base}/api/v1/projects/nope/state`);
    assert.equal(missing.status, 404);
    const err = (await missing.json()) as any;
    assert.equal(err.error.code, "project_not_found");
  });
});

test("GET /agents reports registered agent availability", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/projects/a/agents`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.configured_default, "codex");
    assert.equal(body.effective_default, "codex");
    assert.ok(Array.isArray(body.agents));
    assert.ok(body.agents.some((a: { kind: string; registered: boolean; command: string }) =>
      a.kind === "codex" && a.registered === true && a.command === "codex app-server"));
    assert.ok(body.agents.some((a: { kind: string; registered: boolean; command: string }) =>
      a.kind === "opencode" && a.registered === true && a.command === "opencode"));
  });
});

test("POST /agents/refresh re-probes and notifies; the wrong method is rejected", async () => {
  await withServer(async (base, mgr) => {
    let notified = 0;
    const dispose = mgr.get("a")!.orchestrator.onChange(() => { notified += 1; });
    try {
      const res = await fetch(`${base}/api/v1/projects/a/agents/refresh`, { method: "POST" });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { agents: unknown[]; checked_at: string | null };
      assert.ok(Array.isArray(body.agents) && body.agents.length > 0);
      assert.ok(notified > 0, "a re-check pushes the new picture to every open console");

      // GET is the read; refresh is a POST and nothing else.
      assert.equal((await fetch(`${base}/api/v1/projects/a/agents/refresh`)).status, 405);
      assert.equal((await fetch(`${base}/api/v1/projects/a/agents`, { method: "POST" })).status, 405);
    } finally {
      dispose();
    }
  });
});

test("GET /events classifies live-only snapshots without invalidating the board", { timeout: 15000 }, async () => {
  await withServer(async (base, mgr) => {
    const orch = mgr.get("a")!.orchestrator;
    const observers = () => (orch as any).observers.size as number;
    const baseline = observers();

    const ac = new AbortController();
    const res = await fetch(`${base}/api/v1/projects/a/events`, { signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = (res.body as any).getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const dec = new TextDecoder();
    let buf = "";
    /** Read until the stream has yielded n snapshot events (they may arrive coalesced). */
    const readUntil = async (n: number): Promise<void> => {
      const deadline = Date.now() + 5000;
      while ((buf.match(/event: snapshot/g) ?? []).length < n) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} snapshot events; got: ${buf.slice(0, 120)}`);
        const { value, done } = await reader.read();
        if (done) throw new Error("event stream ended early");
        buf += dec.decode(value, { stream: true });
      }
    };

    await readUntil(1); // initial snapshot on connect
    assert.match(buf, /"board_dirty":true/, "a new client needs one board load");
    assert.equal(observers(), baseline + 1, "one hub observer registered for the project's clients");

    (orch as any).notify(false); // live session activity must not reload the complete board
    await readUntil(2); // coalesced follow-up snapshot (~200 ms debounce)
    const events = [...buf.matchAll(/event: snapshot\ndata: (.+)/g)].map((m) => JSON.parse(m[1]!));
    assert.equal(events[1].board_dirty, false, "agent-only changes are snapshot-only SSE events");

    ac.abort();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(observers(), baseline, "last client leaving disposes the orchestrator observer");
  });
});

test("SSE backpressure retains only the latest snapshot and cleans up its drain listener", async () => {
  await withServer(async (_base, mgr, server) => {
    const orch = mgr.get("a")!.orchestrator;
    const response = new SlowSseResponse([false, true, false]);
    const request = new EventEmitter();
    const impl = server as any;
    let version = 0;
    (orch as any).snapshot = () => ({ version });

    impl.openEventStream(orch, request, response);
    const hub = impl.sseHubs.get(orch);
    const client = [...hub.clients][0];
    try {
      assert.equal(client.backpressured, true, "a false write marks the client as blocked");
      assert.equal(response.listenerCount("drain"), 1, "only one drain listener is registered");

      for (version = 1; version <= 5; version += 1) impl.writeSseSnapshot(client, orch, version === 2);
      impl.writeSse(orch, hub, client, ": heartbeat\n\n");
      assert.equal(response.writes.length, 1, "a blocked client receives no queued snapshots or heartbeats");

      response.emit("drain");
      assert.equal(response.writes.length, 2, "drain flushes one coalesced snapshot");
      assert.match(response.writes[1]!, /\"version\":5/, "the flushed snapshot is the newest state");
      assert.match(response.writes[1]!, /\"board_dirty\":true/, "coalescing preserves a pending board refresh");
      assert.equal(response.listenerCount("drain"), 0, "a drained client does not retain a stale listener");

      version = 6;
      impl.writeSseSnapshot(client, orch, false);
      assert.equal(client.backpressured, true, "a later false write blocks the client again");
      assert.equal(response.listenerCount("drain"), 1, "each blocked period owns one listener");
      response.emit("close");
      assert.equal(client.closed, true);
      assert.equal(client.heartbeat, null, "closing clears the heartbeat timer");
      assert.equal(response.listenerCount("drain"), 0, "closing removes an outstanding drain listener");
      assert.equal(hub.clients.size, 0, "closing drops the client from the project hub");
    } finally {
      response.emit("close");
    }
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

test("POST /issues/<id>/stop 404s when nothing is running or retrying", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/projects/a/issues/A-1/stop`, { method: "POST" });
    assert.equal(res.status, 404);
    const body = (await res.json()) as any;
    assert.equal(body.error.code, "nothing_to_stop");

    assert.equal((await fetch(`${base}/api/v1/projects/a/issues/A-1/stop`)).status, 405);
  });
});

test("POST /issues/<id>/push-branch 501s on a scratch project (no repository)", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/projects/a/issues/A-1/push-branch`, { method: "POST" });
    assert.equal(res.status, 501, "the project cannot push at all: not a bad request");
    const body = (await res.json()) as any;
    assert.equal(body.error.code, "not_supported");
    assert.match(body.error.message, /workspace\.repository/);

    assert.equal((await fetch(`${base}/api/v1/projects/a/issues/A-1/push-branch`)).status, 405);
  });
});

test("POST /issues persists the per-task agent override and rejects unknown kinds", async () => {
  await withServer(async (base) => {
    // backlog state: parked, so the create-triggered tick never dispatches a real agent.
    const created = await fetch(`${base}/api/v1/projects/a/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "A-2", title: "agent override", state: "backlog", agent: "opencode" }),
    });
    assert.equal(created.status, 201);

    const board = (await (await fetch(`${base}/api/v1/projects/a/issues`)).json()) as any;
    const row = board.issues.find((i: { identifier: string }) => i.identifier === "A-2");
    assert.equal(row.agent_override, "opencode", "override should persist instead of falling back to the default");
    assert.equal(row.agent, "opencode");

    const bad = await fetch(`${base}/api/v1/projects/a/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "A-3", title: "bad agent", state: "backlog", agent: "nope" }),
    });
    assert.equal(bad.status, 400);
    const err = (await bad.json()) as any;
    assert.match(err.error.message, /unknown agent\.kind/);
  });
});

test("POST /issues carries the per-task model onto the board; PATCH sets and clears it", async () => {
  await withServer(async (base) => {
    // backlog state: parked, so the create-triggered tick never dispatches a real agent.
    const created = await fetch(`${base}/api/v1/projects/a/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "A-4", title: "pinned model", state: "backlog", model: "vendor/fast" }),
    });
    assert.equal(created.status, 201);

    const row = async (identifier: string) => {
      const board = (await (await fetch(`${base}/api/v1/projects/a/issues`)).json()) as any;
      return board.issues.find((i: { identifier: string }) => i.identifier === identifier);
    };
    assert.equal((await row("A-4")).model, "vendor/fast", "the create should persist the model, not drop it");
    assert.equal((await row("A-1")).model, null, "an issue that pinned nothing runs the backend default");

    const patched = await fetch(`${base}/api/v1/projects/a/issues/A-1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "still A-1", model: "vendor/slow" }),
    });
    assert.equal(patched.status, 200);
    assert.equal(((await patched.json()) as any).issue.model, "vendor/slow", "the response echoes it so the form can rebind");
    assert.equal((await row("A-1")).model, "vendor/slow");

    // The form's "backend default" option comes back as a blank string.
    const cleared = await fetch(`${base}/api/v1/projects/a/issues/A-1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "" }),
    });
    assert.equal(cleared.status, 200);
    assert.equal(((await cleared.json()) as any).issue.model, null);
    assert.equal((await row("A-1")).model, null);
  });
});

test("a PATCH carrying only a model is a valid patch, not an empty one", async () => {
  // Regression guard: `model` must count towards "at least one of", or the console's
  // model-only edit answers 400 while looking like a well-formed request.
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/projects/a/issues/A-1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "vendor/only" }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).issue.model, "vendor/only");
  });
});

test("a blank or whitespace host is treated as unset (binds loopback, not ::)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sym-host-"));
  project(root, "a", "A-1");
  const mp = path.join(root, "projects.json");
  saveManifest(mp, [{ id: "a", name: "A", workflow: "./a/WORKFLOW.md" }]);
  for (const bad of ["", "   ", "\t"]) {
    const mgr = ProjectManager.fromManifest(mp, silent);
    const server = new SymphonyHttpServer({ manager: mgr, logger: silent, port: 0, host: bad });
    await server.listen();
    try {
      // Node binds "" to `::` (all interfaces); a blank host must NOT survive as
      // "" — it must fall back to loopback so the unauthenticated console is
      // never silently exposed (SPEC §13.7).
      const addr = server.address() as AddressInfo;
      assert.ok(addr, "server should be listening");
      assert.equal(addr.address, "127.0.0.1", `blank host "${JSON.stringify(bad)}" should bind loopback, not ::`);
    } finally {
      server.close();
      mgr.stopAll();
    }
  }
});

test("PATCH /issues/<id> amends the record; DELETE removes it from the board", async () => {
  await withServer(async (base) => {
    const patched = await fetch(`${base}/api/v1/projects/a/issues/A-1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "edited title", description: "new body", priority: 2, labels: ["Docs", "docs"] }),
    });
    assert.equal(patched.status, 200);
    const body = (await patched.json()) as any;
    assert.equal(body.updated, true);
    assert.equal(body.issue.title, "edited title");
    assert.deepEqual(body.issue.labels, ["docs"]);

    const detail = (await (await fetch(`${base}/api/v1/projects/a/A-1`)).json()) as any;
    assert.equal(detail.title, "edited title");
    assert.equal(detail.description, "new body", "the console prefills the edit form from this payload");

    const deleted = await fetch(`${base}/api/v1/projects/a/issues/A-1`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal(((await deleted.json()) as any).issue_identifier, "A-1");
    const board = (await (await fetch(`${base}/api/v1/projects/a/issues`)).json()) as any;
    assert.deepEqual(board.issues, []);

    const again = await fetch(`${base}/api/v1/projects/a/issues/A-1`, { method: "DELETE" });
    assert.equal(again.status, 404);
    assert.equal(((await again.json()) as any).error.code, "not_found");
  });
});

test("PATCH /issues/<id> rejects an empty or invalid patch; unsupported methods 405", async () => {
  await withServer(async (base) => {
    const cases: [unknown, RegExp][] = [
      [{}, /at least one of/],
      [{ title: "   " }, /title cannot be blank/],
      [{ priority: 1.5 }, /priority must be an integer/],
      [{ priority: true }, /priority must be an integer or null/],
      [{ labels: "docs" }, /labels must be an array/],
    ];
    for (const [payload, message] of cases) {
      const res = await fetch(`${base}/api/v1/projects/a/issues/A-1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 400, `payload ${JSON.stringify(payload)} should be rejected`);
      assert.match(((await res.json()) as any).error.message, message);
    }
    // The issue survived every rejected patch.
    const board = (await (await fetch(`${base}/api/v1/projects/a/issues`)).json()) as any;
    assert.equal(board.issues[0].title, "title A-1");

    assert.equal((await fetch(`${base}/api/v1/projects/a/issues/A-1`, { method: "PUT" })).status, 405);
  });
});

test("PATCH/DELETE /issues/<id> 501 when the tracker cannot edit", async () => {
  await withServer(async (base, mgr) => {
    // Simulate an adapter without the optional edit capability.
    (mgr.get("a")!.orchestrator as unknown as { canEditIssues(): boolean }).canEditIssues = () => false;
    for (const method of ["PATCH", "DELETE"]) {
      const res = await fetch(`${base}/api/v1/projects/a/issues/A-1`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "PATCH" ? JSON.stringify({ title: "x" }) : undefined,
      });
      assert.equal(res.status, 501, `${method} should report the capability, not a bad request`);
      assert.equal(((await res.json()) as any).error.code, "not_supported");
    }
  });
});

test("DELETE /issues/<id> maps orchestrator failures onto their own status", async () => {
  await withServer(async (base, mgr) => {
    const orch = mgr.get("a")!.orchestrator as unknown as { deleteIssue(id: string): Promise<unknown> };
    const cases: [OrchestratorErrorCode, number][] = [
      ["conflict", 409], // running or retrying: the operator must Stop it first
      ["upstream_failed", 502],
      ["not_found", 404],
    ];
    for (const [code, status] of cases) {
      orch.deleteIssue = () => Promise.reject(new OrchestratorError(code, `simulated ${code}`));
      const res = await fetch(`${base}/api/v1/projects/a/issues/A-1`, { method: "DELETE" });
      assert.equal(res.status, status, `${code} should answer ${status}`);
      assert.equal(((await res.json()) as any).error.code, code);
    }
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

test("POST /issues/<id>/follow-up joins the parent's work stream", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/projects/a/issues/A-1/follow-up`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "A-1-a", title: "address review comments", state: "backlog" }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as any;
    assert.equal(body.issue.follow_up_for, "A-1");
    assert.equal(body.issue.stream_identifier, "A-1", "it delivers onto the parent's branch");

    const board = (await (await fetch(`${base}/api/v1/projects/a/issues`)).json()) as any;
    const row = board.issues.find((i: { identifier: string }) => i.identifier === "A-1-a");
    assert.equal(row.follow_up_for, "A-1");
    assert.equal(row.stream, "A-1");
    // The parent leads its own stream, so the board can group the two together.
    assert.equal(board.issues.find((i: { identifier: string }) => i.identifier === "A-1").stream, "A-1");

    // The detail view puts both issues in one workspace — the point of the feature.
    const parent = (await (await fetch(`${base}/api/v1/projects/a/A-1`)).json()) as any;
    const child = (await (await fetch(`${base}/api/v1/projects/a/A-1-a`)).json()) as any;
    assert.equal(child.workspace.path, parent.workspace.path);
    assert.equal(child.follow_up_for, "A-1");
  });
});

test("POST /issues/<id>/follow-up 404s on an unknown parent and 501s without the capability", async () => {
  await withServer(async (base, mgr) => {
    const missing = await fetch(`${base}/api/v1/projects/a/issues/NOPE-1/follow-up`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "A-9", title: "orphan", state: "backlog" }),
    });
    assert.equal(missing.status, 404, "an unknown parent is not a malformed request");
    assert.equal(((await missing.json()) as any).error.code, "not_found");

    // Simulate an adapter without the optional follow-up capability.
    (mgr.get("a")!.orchestrator as unknown as { canFollowUp(): boolean }).canFollowUp = () => false;
    const unsupported = await fetch(`${base}/api/v1/projects/a/issues/A-1/follow-up`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "A-8", title: "nope", state: "backlog" }),
    });
    assert.equal(unsupported.status, 501);
    assert.equal(((await unsupported.json()) as any).error.code, "not_supported");
  });
});

test("GET /models lists a backend's models and answers the second read from the cache", { timeout: 20000 }, async () => {
  // A fake backend, so no real codex/opencode is ever spawned for a model listing.
  const listing: AgentModel[] = [{ id: "vendor/a", label: "A" }, { id: "vendor/b", default: true }];
  let calls = 0;
  registerAgentFactory({
    kind: "test-http-models",
    create(): AgentSession {
      throw new Error("this backend is never dispatched in this test");
    },
    async listModels() {
      calls += 1;
      return listing;
    },
  });

  await withServer(async (base) => {
    const url = `${base}/api/v1/projects/a/models?kind=test-http-models`;
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.kind, "test-http-models", "?kind picks the backend, not the project default");
    assert.deepEqual(body.models, listing);
    assert.equal(body.stale, false, "a completed probe is not stale");
    assert.ok(typeof body.fetched_at === "string" && body.fetched_at.length > 0);
    assert.equal(calls, 1);

    // Each probe costs a spawned CLI, so a second read inside the TTL must not re-probe.
    const again = (await (await fetch(url)).json()) as any;
    assert.deepEqual(again.models, listing);
    assert.equal(calls, 1, "the second read is served from the cache");

    // A forced refresh landing inside the force floor is deliberately served from the
    // cache too — the answer is a moment old, and the endpoint is unauthenticated.
    const refreshUrl = `${base}/api/v1/projects/a/models/refresh?kind=test-http-models`;
    assert.equal((await fetch(refreshUrl, { method: "POST" })).status, 200);
    assert.equal(calls, 1, "a refresh inside AGENT_MODELS_FORCE_MIN_MS re-uses the listing");

    // Past the floor, the operator's refresh really does re-probe.
    await new Promise((r) => setTimeout(r, 2100));
    const refreshed = await fetch(refreshUrl, { method: "POST" });
    assert.equal(refreshed.status, 200);
    assert.deepEqual(((await refreshed.json()) as any).models, listing);
    assert.equal(calls, 2, "a refresh past the floor bypasses the TTL");

    // GET is the read; refresh is a POST and nothing else.
    assert.equal((await fetch(`${base}/api/v1/projects/a/models`, { method: "POST" })).status, 405);
    assert.equal((await fetch(refreshUrl)).status, 405);
  });
});

test("GET /models falls back to the project's default backend when ?kind is unknown", async () => {
  await withServer(async (base) => {
    const body = (await (await fetch(`${base}/api/v1/projects/a/models?kind=no-such-backend`)).json()) as any;
    assert.equal(body.kind, "codex", "an unrecognized kind is never trusted as a backend name");
  });
});

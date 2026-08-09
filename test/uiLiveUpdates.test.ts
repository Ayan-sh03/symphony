import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, (event: { data: string }) => void>();

  constructor(_url: string) { FakeEventSource.instances.push(this); }
  addEventListener(name: string, listener: (event: { data: string }) => void): void { this.listeners.set(name, listener); }
  close(): void { this.closed = true; }
  open(): void { this.onopen?.(); }
  error(): void { this.onerror?.(); }
  emit(name: string, data: unknown): void { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
}

test("console bootstrap loads the board once, then healthy SSE only reloads a dirty board", async () => {
  const calls: string[] = [];
  const boardRequestCount = () => calls.reduce((count, url) => count + Number(url.endsWith("/issues")), 0);
  (globalThis as any).window = { __SYMPHONY__: { projects: [{ id: "p" }], selected: "p", snapshot: null } };
  (globalThis as any).localStorage = { getItem: () => null, setItem: () => {} };
  (globalThis as any).EventSource = FakeEventSource;
  (globalThis as any).fetch = (url: string) => {
    calls.push(url);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ meta: { can_board: true } }) });
  };

  // @ts-expect-error Console assets are browser ES modules and intentionally have no .d.ts files.
  const api = await import("../src/server/ui/api.js");
  // @ts-expect-error Console assets are browser ES modules and intentionally have no .d.ts files.
  const { store } = await import("../src/server/ui/store.js");
  store.state = { meta: { can_board: true } };
  store.route = { name: "board" };
  api.bootstrapLiveUpdates();
  const source = FakeEventSource.instances[0]!;
  source.open();

  source.emit("snapshot", { snapshot: { meta: { can_board: true } }, board_dirty: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(boardRequestCount(), 1, "normal boot must issue one full board request");
  const appSource = fs.readFileSync(new URL("../src/server/ui/app.js", import.meta.url), "utf8");
  assert.match(appSource, /bootstrapLiveUpdates\(\);/, "the app boot path must use the single-request bootstrap");
  calls.length = 0;

  await api.pollLiveFallback();
  assert.deepEqual(calls, [], "a healthy stream must not poll state, board, or detail");

  source.emit("snapshot", { snapshot: { meta: { can_board: true } }, board_dirty: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [], "agent-only snapshots do not reload the full board");

  source.emit("snapshot", { snapshot: { meta: { can_board: true } }, board_dirty: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["/api/v1/projects/p/issues"], "board updates reload the board once");

  source.error();
  await new Promise((resolve) => setImmediate(resolve));
  calls.length = 0;
  store.route = { name: "detail", id: "P-1" };
  await api.pollLiveFallback();
  assert.deepEqual(calls.sort(), ["/api/v1/projects/p/P-1", "/api/v1/projects/p/issues", "/api/v1/projects/p/state"].sort(), "a disconnected stream falls back to bounded polling");
  api.stopLiveUpdates();

  calls.length = 0;
  store.state = null;
  store.route = { name: "board" };
  api.bootstrapLiveUpdates();
  const nullBootSource = FakeEventSource.instances[1]!;
  nullBootSource.open();
  nullBootSource.emit("snapshot", { snapshot: { meta: { can_board: true } }, board_dirty: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(boardRequestCount(), 1, "a null inlined snapshot still loads the board once SSE supplies state");
  api.stopLiveUpdates();

  calls.length = 0;
  store.state = null;
  api.bootstrapLiveUpdates();
  const failedBeforeSnapshot = FakeEventSource.instances[2]!;
  failedBeforeSnapshot.error();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.sort(), ["/api/v1/projects/p/issues", "/api/v1/projects/p/state"].sort(),
    "the first null-bootstrap fallback recovers state and board without duplicate requests");
  api.stopLiveUpdates();
});

test("project switches isolate delayed state, board, detail, and fallback responses", async (t) => {
  type Pending = { url: string; resolve: (response: unknown) => void };
  const pending: Pending[] = [];
  (globalThis as any).fetch = (url: string) => new Promise((resolve) => pending.push({ url, resolve }));
  FakeEventSource.instances.length = 0;

  // @ts-expect-error Console assets are browser ES modules and intentionally have no .d.ts files.
  const api = await import("../src/server/ui/api.js");
  // @ts-expect-error Console assets are browser ES modules and intentionally have no .d.ts files.
  const { store } = await import("../src/server/ui/store.js");
  t.after(() => {
    api.stopLiveUpdates();
    for (const request of pending.splice(0)) request.resolve({ ok: false, json: () => Promise.resolve({}) });
  });

  const take = (url: string): Pending => {
    const index = pending.findIndex((request) => request.url === url);
    assert.notEqual(index, -1, `expected pending request ${url}; got ${pending.map((request) => request.url).join(", ")}`);
    return pending.splice(index, 1)[0]!;
  };
  const answer = (request: Pending, body: unknown) => request.resolve({ ok: true, json: () => Promise.resolve(body) });
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  store.pid = "a";
  store.state = null; store.board = null; store.detailData = null; store.route = { name: "board" };
  api.restartLiveUpdates();
  const aState = api.fetchState();
  const aStateAgain = api.fetchState();
  assert.equal(pending.filter((request) => request.url.endsWith("/a/state")).length, 1, "dedupe applies within one project generation");

  store.pid = "b";
  store.state = null; store.board = null; store.detailData = null;
  api.restartLiveUpdates();
  FakeEventSource.instances.at(-1)!.error();
  assert.equal(pending.filter((request) => request.url.endsWith("/b/state")).length, 1,
    "project B fallback must not reuse project A's state request");

  answer(take("/api/v1/projects/a/state"), { project: "a", meta: { can_board: true } });
  await Promise.all([aState, aStateAgain]);
  assert.equal(store.state, null, "a delayed project A state cannot commit after switching to B");
  assert.equal(pending.some((request) => request.url.endsWith("/a/issues")), false, "stale A state cannot trigger an A board fallback");

  answer(take("/api/v1/projects/b/state"), { project: "b", meta: { can_board: true } });
  await flush();
  answer(take("/api/v1/projects/b/issues"), { project: "b", issues: [] });
  await flush();
  assert.equal(store.state.project, "b");
  assert.equal(store.board.project, "b", "project B's first fallback commits its own board");
  api.stopLiveUpdates();

  store.state = { project: "b", meta: { can_board: true } }; store.board = null;
  const staleBoard = api.fetchBoard();
  store.pid = "c"; store.state = { project: "c", meta: { can_board: true } }; store.board = null;
  api.restartLiveUpdates();
  const currentBoard = api.fetchBoard();
  answer(take("/api/v1/projects/b/issues"), { project: "b", issues: ["stale"] });
  await staleBoard;
  assert.equal(store.board, null, "a delayed board cannot cross project generations");
  answer(take("/api/v1/projects/c/issues"), { project: "c", issues: [] });
  await currentBoard;
  assert.equal(store.board.project, "c");

  store.route = { name: "detail", id: "SAME-1" }; store.detailData = null;
  const staleDetail = api.loadDetail("SAME-1");
  store.pid = "d"; store.route = { name: "detail", id: "SAME-1" }; store.detailData = null;
  api.restartLiveUpdates();
  const currentDetail = api.loadDetail("SAME-1");
  answer(take("/api/v1/projects/c/SAME-1"), { project: "c", issue_identifier: "SAME-1" });
  await staleDetail;
  assert.equal(store.detailData, null, "same-identifier detail responses remain project-scoped");
  answer(take("/api/v1/projects/d/SAME-1"), { project: "d", issue_identifier: "SAME-1" });
  await currentDetail;
  assert.equal(store.detailData.project, "d");
});

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
  assert.equal(calls.filter((url) => url.endsWith("/issues")).length, 1, "normal boot must issue one full board request");
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
});

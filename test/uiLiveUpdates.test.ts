import { test } from "node:test";
import assert from "node:assert/strict";

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

test("healthy SSE snapshots avoid fallback polling and only reload a dirty board", async () => {
  const calls: string[] = [];
  (globalThis as any).window = { __SYMPHONY__: { projects: [{ id: "p" }], selected: "p", snapshot: null } };
  (globalThis as any).localStorage = { getItem: () => null, setItem: () => {} };
  (globalThis as any).EventSource = FakeEventSource;
  (globalThis as any).fetch = (url: string) => {
    calls.push(url);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ meta: { can_board: true } }) });
  };

  const api = await import("../src/server/ui/api.js");
  const { store } = await import("../src/server/ui/store.js");
  store.state = { meta: { can_board: true } };
  store.route = { name: "board" };
  api.startLiveUpdates();
  const source = FakeEventSource.instances[0]!;
  source.open();

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

/** Fetch layer for the project-scoped JSON API (SPEC §13.7.2). Mutates the store and rerenders. */
import { store, apiBase, rerender } from "./store.js";
import { toast } from "./toast.js";

let eventSource = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let sseConnected = false;
let stateRequest = null;
let projectGeneration = 0;
// Receipt order is authoritative within a project generation: a fetch commits only
// if no SSE snapshot arrived since it started; later fetches or SSE may supersede it.
let stateVersion = 0;

function requestContext() {
  return { pid: store.pid, generation: projectGeneration, base: apiBase() };
}

function isCurrent(context) {
  return context.pid === store.pid && context.generation === projectGeneration;
}

export function fetchState() {
  const context = requestContext();
  if (stateRequest && stateRequest.pid === context.pid && stateRequest.generation === context.generation) return stateRequest.promise;
  const version = stateVersion;
  const request = fetch(context.base + "/state", { headers: { accept: "application/json" } })
    .then((r) => { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
    .then((j) => {
      if (!isCurrent(context) || stateVersion !== version) return;
      stateVersion += 1;
      store.state = j; store.lastOk = Date.now(); store.conn = eventSource && sseConnected ? "sse" : "poll"; rerender();
    })
    .catch(() => {
      if (!isCurrent(context) || stateVersion !== version) return;
      store.conn = Date.now() - store.lastOk > 12000 ? "down" : "stale"; rerender();
    });
  const entry = { ...context, promise: request };
  stateRequest = entry;
  void request.then(() => { if (stateRequest === entry) stateRequest = null; });
  return request;
}

/** One EventSource follows the active project; polling is reserved for a failed stream. */
export function startLiveUpdates() {
  if (!store.auto || eventSource || reconnectTimer) return;
  const context = requestContext();
  const source = new EventSource(context.base + "/events");
  eventSource = source;
  source.addEventListener("snapshot", (event) => {
    if (eventSource !== source || !isCurrent(context)) return;
    try {
      const payload = JSON.parse(event.data);
      if (!payload || !payload.snapshot) return;
      stateVersion += 1;
      store.state = payload.snapshot;
      store.lastOk = Date.now();
      sseConnected = true;
      store.conn = "sse";
      rerender();
      if (payload.board_dirty) fetchBoard();
      refreshOpenDetail();
    } catch {
      // A malformed stream event is ignored; the next snapshot repairs the view.
    }
  });
  source.onopen = () => {
    if (eventSource !== source || !isCurrent(context)) return;
    // Headers only prove the transport opened. The server's first snapshot may
    // still be waiting behind response backpressure, so polling remains active
    // until a valid snapshot completes the application-level handshake above.
    sseConnected = false;
    reconnectDelay = 1000;
    store.conn = "poll";
    rerender();
  };
  source.onerror = () => {
    if (eventSource !== source || !isCurrent(context)) return;
    source.close();
    eventSource = null;
    sseConnected = false;
    store.conn = "stale";
    rerender();
    void pollLiveFallback();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      startLiveUpdates();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };
}

/** Start the console without racing a direct board fetch against SSE's initial dirty snapshot. */
export function bootstrapLiveUpdates() {
  void fetchState();
  startLiveUpdates();
}

export function stopLiveUpdates() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (eventSource) eventSource.close();
  eventSource = null;
  sseConnected = false;
  reconnectDelay = 1000;
}

export function restartLiveUpdates() {
  stopLiveUpdates();
  projectGeneration += 1;
  stateVersion = 0;
  startLiveUpdates();
}

export function setAutoRefresh(enabled) {
  store.auto = enabled;
  if (enabled) {
    startLiveUpdates();
    void fetchState();
    void fetchBoard();
  } else {
    stopLiveUpdates();
  }
  rerender();
}

/** Poll only while SSE is unavailable; a healthy stream already carries state updates. */
export function pollLiveFallback() {
  if (!store.auto || (eventSource && sseConnected)) return Promise.resolve();
  const context = requestContext();
  return fetchState().then(() => {
    if (!isCurrent(context) || (eventSource && sseConnected)) return;
    return Promise.all([fetchBoard(), refreshOpenDetail()]);
  });
}

export function fetchBoard() {
  if (!store.state || !store.state.meta || !store.state.meta.can_board) return Promise.resolve();
  const context = requestContext();
  return fetch(context.base + "/issues", { headers: { accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((j) => { if (isCurrent(context)) { store.board = j; rerender(); } })
    .catch(() => {});
}

// Detail, edit and follow-up share one payload; a late response for a page we have
// left is dropped.
function viewingDetail(identifier) {
  const r = store.route;
  return (r.name === "detail" || r.name === "edit" || r.name === "followup") && r.id === identifier;
}

export function loadDetail(identifier) {
  const context = requestContext();
  return fetch(context.base + "/" + encodeURIComponent(identifier), { headers: { accept: "application/json" } })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then((res) => {
      if (!isCurrent(context) || !viewingDetail(identifier)) return;
      if (res.ok) { store.detailData = res.j; store.detailErr = null; }
      else { store.detailData = null; store.detailErr = (res.j.error && res.j.error.message) || "Not found"; }
      rerender();
    })
    .catch(() => {
      if (!isCurrent(context) || !viewingDetail(identifier)) return;
      if (!store.detailData) { store.detailErr = "Failed to load detail."; rerender(); }
    });
}

export function refreshOpenDetail() {
  if (store.route.name === "detail") loadDetail(store.route.id);
}

export function setState(id, to, btn) {
  if (btn) btn.classList.add("busy");
  fetch(apiBase() + "/issues/" + encodeURIComponent(id) + "/state", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: to }),
  })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then((res) => {
      if (!res.ok) throw new Error((res.j.error && res.j.error.message) || "failed");
      toast(id + " → " + to, "ok");
      return Promise.all([fetchState(), fetchBoard()]);
    })
    .catch((ex) => { toast(String(ex.message || ex), "err"); if (btn) btn.classList.remove("busy"); });
}

export function setDefaultAgent(kind, el) {
  if (el) el.disabled = true;
  fetch(apiBase() + "/default-agent", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }),
  })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then((res) => {
      if (!res.ok) throw new Error((res.j.error && res.j.error.message) || "failed");
      toast("Default agent → " + res.j.default_agent, "ok");
      return fetchState();
    })
    .catch((ex) => { toast(String(ex.message || ex), "err"); })
    .then(() => { if (el) el.disabled = false; });
}

/** Re-probe the host for installed agent CLIs (extension). */
export function refreshAgents(btn) {
  if (btn) btn.classList.add("busy");
  return fetch(apiBase() + "/agents/refresh", { method: "POST" })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((j) => {
      const installed = (j.agents || []).filter((a) => a.usable).map((a) => a.kind);
      toast(installed.length ? "Found " + installed.join(", ") : "No runnable agent found", installed.length ? "ok" : "err");
      return fetchState();
    })
    .catch(() => { toast("Could not check for agents", "err"); })
    .then(() => { if (btn) btn.classList.remove("busy"); });
}

/**
 * Model discovery for one backend (extension, SPEC Appendix B.7). Advisory: the model
 * field is free text and the CLI is the authority, so a failed listing degrades the
 * dropdown and nothing else. `loading` is set without a rerender on purpose — views
 * call `ensureModels` while painting, and repainting mid-render would re-enter.
 */
function loadModels(kind, force, btn) {
  const prev = store.models[kind];
  store.models[kind] = {
    kind,
    models: (prev && prev.models) || [],
    fetched_at: (prev && prev.fetched_at) || null,
    stale: prev ? prev.stale : true,
    loading: true,
    error: null,
  };
  if (btn) btn.classList.add("busy");
  const path = (force ? "/models/refresh" : "/models") + "?kind=" + encodeURIComponent(kind);
  return fetch(apiBase() + path, force ? { method: "POST" } : { headers: { accept: "application/json" } })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then((res) => {
      if (!res.ok) throw new Error((res.j.error && res.j.error.message) || "listing failed");
      // The server answers for the kind it actually resolved, which may differ from
      // the one we asked about (unknown kinds fall back to the effective default).
      const view = res.j;
      const entry = { kind: view.kind || kind, models: view.models || [], fetched_at: view.fetched_at || null,
        stale: view.stale === true, loading: false, error: null };
      store.models[entry.kind] = entry;
      if (entry.kind !== kind) store.models[kind] = entry;
      return entry;
    })
    .catch((ex) => {
      const keep = store.models[kind];
      // Keep whatever was listed before: a bad probe must not empty a dropdown the
      // operator is mid-way through using.
      store.models[kind] = { kind, models: (keep && keep.models) || [], fetched_at: (keep && keep.fetched_at) || null,
        stale: keep ? keep.stale : true, loading: false, error: String(ex.message || ex) };
      return null;
    })
    .then((entry) => { if (btn) btn.classList.remove("busy"); rerender(); return entry; });
}

/** Fetch a backend's models once. Idempotent, so views can call it while rendering. */
export function ensureModels(kind) {
  // An entry of any shape — loading, listed, empty or failed — is an answer already;
  // re-probing on every paint would spawn a CLI per frame. Refresh is explicit.
  if (!kind || store.models[kind]) return;
  void loadModels(kind, false);
}

/** Re-probe a backend for its models on operator request — wired like the agent re-check. */
export function refreshModels(kind, btn) {
  return loadModels(kind, true, btn).then((entry) => {
    if (!entry) { toast("Could not list models for " + kind, "err"); return; }
    if (entry.models.length) toast(kind + " listed " + entry.models.length + " model(s)", "ok");
    else toast(kind + " reported no models", "err");
  });
}

export function setIssueAgent(id, agent, el) {
  if (el) el.disabled = true;
  fetch(apiBase() + "/issues/" + encodeURIComponent(id) + "/agent", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent }),
  })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then((res) => {
      if (!res.ok) throw new Error((res.j.error && res.j.error.message) || "failed");
      toast(id + " agent → " + (agent || "default"), "ok");
      return Promise.all([fetchState(), fetchBoard()]);
    })
    .catch((ex) => { toast(String(ex.message || ex), "err"); if (el) el.disabled = false; });
}

/** Push a delivered issue's branch to the origin remote (repository projects). */
export function pushBranch(id, btn) {
  if (btn) btn.classList.add("busy");
  fetch(apiBase() + "/issues/" + encodeURIComponent(id) + "/push-branch", { method: "POST" })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then((res) => {
      if (!res.ok) throw new Error((res.j.error && res.j.error.message) || "failed");
      toast("Pushed " + res.j.branch + " to origin", "ok");
      const jobs = [fetchState(), fetchBoard()];
      if (store.route.name === "detail") jobs.push(loadDetail(store.route.id));
      return Promise.all(jobs);
    })
    .catch((ex) => { toast(String(ex.message || ex), "err"); if (btn) btn.classList.remove("busy"); });
}

export function stopIssue(id, btn) {
  if (btn) btn.classList.add("busy");
  fetch(apiBase() + "/issues/" + encodeURIComponent(id) + "/stop", { method: "POST" })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then((res) => {
      if (!res.ok) throw new Error((res.j.error && res.j.error.message) || "failed");
      toast(res.j.issue_identifier + " stopped — held until you change its state", "ok");
      return Promise.all([fetchState(), fetchBoard()]);
    })
    .catch((ex) => { toast(String(ex.message || ex), "err"); if (btn) btn.classList.remove("busy"); });
}

/** Remove an issue from the tracker. Resolves true when it is gone (caller navigates). */
export function deleteIssue(id, btn) {
  if (btn) btn.classList.add("busy");
  return fetch(apiBase() + "/issues/" + encodeURIComponent(id), { method: "DELETE" })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then((res) => {
      if (!res.ok) throw new Error((res.j.error && res.j.error.message) || "failed");
      store.armDelete = null;
      toast("Deleted " + res.j.issue_identifier, "ok");
      return true;
    })
    .catch((ex) => { toast(String(ex.message || ex), "err"); if (btn) btn.classList.remove("busy"); return false; });
}

export function pollNow(btn) {
  if (btn) { btn.classList.add("busy"); btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="spin"></span> Polling'; }
  fetch(apiBase() + "/refresh", { method: "POST" })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((j) => { toast(j.coalesced ? "Poll already queued" : "Poll + reconcile queued", "ok"); return fetchState(); })
    .catch(() => { toast("Could not queue poll", "err"); })
    .then(() => { if (btn) { btn.classList.remove("busy"); btn.innerHTML = btn.dataset.label; } });
}

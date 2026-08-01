/** Fetch layer for the project-scoped JSON API (SPEC §13.7.2). Mutates the store and rerenders. */
import { store, apiBase, rerender } from "./store.js";
import { toast } from "./toast.js";

let eventSource = null;
let reconnectTimer = null;
let reconnectDelay = 1000;

export function fetchState() {
  return fetch(apiBase() + "/state", { headers: { accept: "application/json" } })
    .then((r) => { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
    .then((j) => { store.state = j; store.lastOk = Date.now(); store.conn = eventSource ? "sse" : "poll"; rerender(); })
    .catch(() => { store.conn = Date.now() - store.lastOk > 12000 ? "down" : "stale"; rerender(); });
}

/** One EventSource follows the active project; polling remains the fallback path. */
export function startLiveUpdates() {
  if (!store.auto || eventSource || reconnectTimer) return;
  const source = new EventSource(apiBase() + "/events");
  eventSource = source;
  source.addEventListener("snapshot", (event) => {
    if (eventSource !== source) return;
    try {
      const payload = JSON.parse(event.data);
      if (!payload || !payload.snapshot) return;
      store.state = payload.snapshot;
      store.lastOk = Date.now();
      store.conn = "sse";
      rerender();
      if (payload.board_dirty) fetchBoard();
      refreshOpenDetail();
    } catch {
      // A malformed stream event is ignored; the next snapshot repairs the view.
    }
  });
  source.onopen = () => {
    if (eventSource !== source) return;
    reconnectDelay = 1000;
    store.conn = "sse";
    rerender();
  };
  source.onerror = () => {
    if (eventSource !== source) return;
    source.close();
    eventSource = null;
    store.conn = "stale";
    rerender();
    void fetchState();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      startLiveUpdates();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };
}

export function stopLiveUpdates() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (eventSource) eventSource.close();
  eventSource = null;
  reconnectDelay = 1000;
}

export function restartLiveUpdates() {
  stopLiveUpdates();
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

export function fetchBoard() {
  if (!store.state || !store.state.meta || !store.state.meta.can_board) return Promise.resolve();
  return fetch(apiBase() + "/issues", { headers: { accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((j) => { store.board = j; rerender(); })
    .catch(() => {});
}

// Detail, edit and follow-up share one payload; a late response for a page we have
// left is dropped.
function viewingDetail(identifier) {
  const r = store.route;
  return (r.name === "detail" || r.name === "edit" || r.name === "followup") && r.id === identifier;
}

export function loadDetail(identifier) {
  return fetch(apiBase() + "/" + encodeURIComponent(identifier), { headers: { accept: "application/json" } })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then((res) => {
      if (!viewingDetail(identifier)) return;
      if (res.ok) { store.detailData = res.j; store.detailErr = null; }
      else { store.detailData = null; store.detailErr = (res.j.error && res.j.error.message) || "Not found"; }
      rerender();
    })
    .catch(() => {
      if (!viewingDetail(identifier)) return;
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

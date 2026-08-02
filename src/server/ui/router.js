/** Hash routing; every route carries the project id: #/<pid>[/...] (host multi-project extension). */
import { store, validPid, savePid, rerender } from "./store.js";
import { fetchState, fetchBoard, loadDetail, restartLiveUpdates } from "./api.js";

export function hashFor(name, id) {
  const base = "#/" + encodeURIComponent(store.pid);
  if (name === "detail") return base + "/issue/" + encodeURIComponent(id);
  if (name === "edit") return base + "/issue/" + encodeURIComponent(id) + "/edit";
  if (name === "followup") return base + "/issue/" + encodeURIComponent(id) + "/follow-up";
  if (name === "new") return base + "/new";
  if (name === "integrate") return base + "/integrate";
  if (name === "add-project") return base + "/add-project";
  return base;
}

function parseHash() {
  const h = (location.hash || "").replace(/^#\/?/, "");
  const parts = h.split("/").filter((x) => x !== "");
  if (parts.length === 0) return { name: "board" };
  const p = decodeURIComponent(parts[0]);
  if (validPid(p)) { store.pid = p; savePid(p); } else return { name: "board" };
  const rest = parts.slice(1);
  if (rest[0] === "issue" && rest[1]) {
    const id = decodeURIComponent(rest[1]);
    if (rest[2] === "edit") return { name: "edit", id };
    if (rest[2] === "follow-up") return { name: "followup", id };
    return { name: "detail", id };
  }
  if (rest[0] === "new") return { name: "new" };
  if (rest[0] === "integrate") return { name: "integrate" };
  if (rest[0] === "add-project") return { name: "add-project" };
  return { name: "board" };
}

export function navigate(hash) {
  if (location.hash === hash) applyRoute();
  else location.hash = hash;
}

export function goBoard() { navigate(hashFor("board")); }

export function switchProject(np) {
  if (!validPid(np) || np === store.pid) return;
  store.pid = np; savePid(np);
  // Model listings are per project (each resolves its own backend and config).
  store.state = null; store.board = null; store.detailData = null; store.detailErr = null; store.models = {};
  navigate(hashFor("board"));
  restartLiveUpdates();
  fetchState(); fetchBoard();
}

export function applyRoute() {
  const pidBefore = store.pid;
  const next = parseHash();
  let changed = next.name !== store.route.name || next.id !== store.route.id;
  if (store.pid !== pidBefore) {
    // Model listings are per project (each resolves its own backend and config).
  store.state = null; store.board = null; store.detailData = null; store.detailErr = null; store.models = {};
    restartLiveUpdates();
    fetchState(); fetchBoard();
    changed = true;
  }
  store.route = next;
  // The edit and follow-up forms are fed by the same detail payload; it is loaded on
  // route entry only (never re-polled), so nothing repaints over what the operator is typing.
  if (store.route.name === "detail" || store.route.name === "edit" || store.route.name === "followup") {
    if (changed) { store.detailData = null; store.detailErr = null; loadDetail(store.route.id); }
  } else { store.detailData = null; store.detailErr = null; }
  if (changed) {
    store.armDelete = null; // leaving the page disarms the confirm
    // Form-local model/agent picker state belongs to the form that is leaving.
    store.modelCustom = false; store.modelDraft = null; store.formAgent = null;
  }
  rerender();
  if (changed) {
    window.scrollTo(0, 0);
    // Land new-issue visitors in the first field (route entry only — never steal focus on a repaint).
    if (store.route.name === "new") {
      const el = document.getElementById("f-id");
      if (el && !el.value) el.focus();
    }
  }
}

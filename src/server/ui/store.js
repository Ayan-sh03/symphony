/**
 * Console client state (SPEC §13.7.1). One mutable store shared by every module,
 * plus a rerender hook registered by the app entry so any module can trigger a
 * repaint without importing it (keeps the module graph cycle-free).
 */
const boot = window.__SYMPHONY__ || {};

export const PID_KEY = "symphony.project";
export const THEME_KEY = "symphony.theme";

export const store = {
  projects: boot.projects || [],
  canAdd: !!boot.can_add,
  pid: boot.selected || (boot.projects && boot.projects[0] && boot.projects[0].id) || "default",
  state: null,       // latest /state snapshot for the active project
  board: null,       // latest /issues board payload
  boardEtag: null,   // conditional-read token for the active project's board
  route: { name: "board" },
  detailData: null,  // cached detail payload for the open issue
  detailErr: null,   // error string if the detail fetch failed
  projMenuOpen: false,
  armDelete: null,   // issue id whose Delete button is armed (two-click confirm)
  // Model discovery (extension, SPEC Appendix B.7), keyed by agent kind:
  // { kind, models, fetched_at, stale, loading, error }. Advisory only — the list
  // never gates what an operator may type, so a missing entry is not an error state.
  models: {},
  modelCustom: false, // the open form's model field is in free-text mode
  modelDraft: null,   // last model picked from the list, prefills the free-text box
  modelMenuOpen: false, // the picker's menu is open (state, not DOM — a poll must not close it)
  modelFilter: "",    // filter typed into that menu, cleared each time it opens
  formAgent: null,    // agent kind chosen on the open form (null = project default)
  auto: true,
  conn: "poll",      // sse | poll | stale | down
  lastOk: Date.now(),
};

export function validPid(p) {
  return store.projects.some((x) => x.id === p);
}
export function savePid(p) {
  try { localStorage.setItem(PID_KEY, p); } catch { /* private mode */ }
}
try {
  const saved = localStorage.getItem(PID_KEY);
  if (saved && validPid(saved)) store.pid = saved;
} catch { /* private mode */ }

// The server inlines a snapshot for boot.selected; if we restored a different
// project, start empty and fetch fresh.
store.state = store.pid === boot.selected ? boot.snapshot || null : null;

export function apiBase() {
  return "/api/v1/projects/" + encodeURIComponent(store.pid);
}

let renderFn = () => {};
export function setRenderer(fn) { renderFn = fn; }
export function rerender() { renderFn(); }

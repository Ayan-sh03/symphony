/**
 * Console entry (SPEC §13.7.1). Boots from the inlined snapshot, then polls
 * `/api/v1/projects/<pid>/state` for live updates. All painting goes through one
 * unconditional lit-html render — lit diffs the DOM in place, so background polls
 * never wipe focus, open menus, or in-flight form input.
 */
import { html, render } from "./vendor/lit-html/lit-html.js";
import { store, setRenderer, rerender, validPid, THEME_KEY } from "./store.js";
import { fetchState, fetchBoard, refreshOpenDetail, pollNow, setState, setDefaultAgent, setIssueAgent, stopIssue, pushBranch, copyText } from "./api.js";
import { hashFor, navigate, goBoard, switchProject, applyRoute } from "./router.js";
import { toast } from "./toast.js";
import { headerView } from "./views/header.js";
import { boardBody } from "./views/board.js";
import { detailPage } from "./views/detail.js";
import { createPage, addProjectPage } from "./views/forms.js";
import { integratePage } from "./views/integrate.js";
import { pageHead, notFoundPage } from "./views/page.js";

// ---- theme ----
let savedTheme = null;
try { savedTheme = localStorage.getItem(THEME_KEY); } catch { /* private mode */ }
if (!savedTheme) savedTheme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
document.documentElement.setAttribute("data-theme", savedTheme);
function toggleTheme() {
  const t = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ }
  rerender();
}

// ---- render ----
function routeBody(m) {
  const r = store.route;
  if (r.name === "new") return m.can_create ? createPage() : notFoundPage("Creating issues is not supported by this tracker.");
  if (r.name === "integrate") return integratePage();
  if (r.name === "add-project") return store.canAdd ? addProjectPage() : notFoundPage("Adding projects is not enabled on this host.");
  if (r.name === "detail") {
    if (store.detailErr) return notFoundPage(store.detailErr);
    if (!store.detailData) return html`${pageHead(r.id, "")}<div class="page"><p class="sub">Loading…</p></div>`;
    return detailPage(store.detailData);
  }
  return boardBody(m);
}

const app = document.getElementById("app");
function doRender() {
  if (!store.state) return; // keep the last paint until the new project's snapshot arrives
  const m = store.state.meta || {};
  render(html`${headerView(m)}<div class="wrap">${routeBody(m)}</div>`, app);
}
setRenderer(doRender);

// ---- events (delegated; independent of rendering) ----
function closeProjMenu() { if (store.projMenuOpen) { store.projMenuOpen = false; rerender(); } }
document.addEventListener("click", (e) => {
  // Project switcher: toggle, pick, or dismiss on outside click.
  const pick = e.target.closest("[data-pick]");
  if (pick) {
    const v = pick.getAttribute("data-pick");
    closeProjMenu();
    if (v === "__add__") navigate(hashFor("add-project")); else switchProject(v);
    return;
  }
  if (e.target.closest("[data-proj-toggle]")) { store.projMenuOpen = !store.projMenuOpen; rerender(); return; }
  if (store.projMenuOpen && !e.target.closest(".proj-switch")) closeProjMenu();

  const nav = e.target.closest("[data-nav]");
  if (nav) { e.preventDefault(); navigate(nav.getAttribute("data-nav")); return; }
  const act = e.target.closest("[data-act]");
  if (act) {
    const a = act.getAttribute("data-act");
    if (a === "poll") pollNow(act);
    else if (a === "auto") { store.auto = !store.auto; rerender(); toast(store.auto ? "Auto-refresh on" : "Auto-refresh paused", "ok"); }
    else if (a === "theme") toggleTheme();
    return;
  }
  const stp = e.target.closest("[data-stop-id]");
  if (stp) { stopIssue(stp.getAttribute("data-stop-id"), stp); return; }
  const push = e.target.closest("[data-push-id]");
  if (push) { pushBranch(push.getAttribute("data-push-id"), push); return; }
  const cpy = e.target.closest("[data-copy]");
  if (cpy) { copyText(cpy.getAttribute("data-copy"), cpy.getAttribute("data-copy-what") || "Value"); return; }
  const sb = e.target.closest("[data-state-id]");
  if (sb) { setState(sb.getAttribute("data-state-id"), sb.getAttribute("data-state-to"), sb); return; }
  const row = e.target.closest("[data-open]");
  if (row) navigate(hashFor("detail", row.getAttribute("data-open")));
});
document.addEventListener("change", (e) => {
  const da = e.target.closest("[data-default-agent]");
  if (da) { setDefaultAgent(da.value, da); return; }
  const ia = e.target.closest("[data-issue-agent]");
  if (ia) { setIssueAgent(ia.getAttribute("data-issue-agent"), ia.value, ia); return; }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (store.projMenuOpen) { closeProjMenu(); return; }
  if (store.route.name !== "board") goBoard();
});
window.addEventListener("hashchange", applyRoute);

// ---- loops ----
// Normalize the URL so it always carries the active project id (stable, shareable).
{
  const first = decodeURIComponent(((location.hash || "").replace(/^#\/?/, "").split("/")[0]) || "");
  if (!validPid(first)) location.replace(location.pathname + location.search + hashFor("board"));
}
applyRoute();
// The inlined snapshot is only for boot.selected; fetch the active project's fresh
// state so a restored (different) project paints immediately instead of on next poll.
fetchState();
fetchBoard();
setInterval(() => { if (store.auto) { fetchState(); fetchBoard(); refreshOpenDetail(); } }, 2500);
// Keep relative times and the connection line honest between fetches; lit only
// touches text whose value actually changed, so this is cheap and non-destructive.
setInterval(rerender, 1000);

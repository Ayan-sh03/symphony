/**
 * Symphony operational console (SPEC §13.7.1). Server sends a self-contained app
 * shell with the first snapshot embedded for instant paint; the client then polls
 * `/api/v1/state` for live updates and drives the control CTAs (`/api/v1/refresh`,
 * `/api/v1/<identifier>`). Drawn solely from orchestrator state — never required
 * for correctness.
 */
import type { SnapshotView } from "../orchestrator/orchestrator.ts";

/** Render the console shell with the initial snapshot inlined (progressive enhancement). */
export function renderDashboard(initial: SnapshotView): string {
  const bootstrap = JSON.stringify(initial).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Symphony · console</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap">
<style>${CSS}</style>
</head>
<body>
<div id="app" aria-busy="false"></div>
<div id="drawer-root"></div>
<div id="toast-root" aria-live="polite"></div>
<script>window.__SYMPHONY__ = ${bootstrap};</script>
<script>${JS}</script>
</body>
</html>`;
}

const CSS = String.raw`
:root {
  --bg: oklch(0.17 0.012 264);
  --panel: oklch(0.205 0.013 264);
  --panel-2: oklch(0.235 0.015 264);
  --border: oklch(0.30 0.016 264);
  --border-strong: oklch(0.40 0.02 264);
  --ink: oklch(0.965 0.004 264);
  --muted: oklch(0.72 0.012 264);
  --faint: oklch(0.58 0.012 264);
  --accent: oklch(0.72 0.15 268);
  --accent-ink: oklch(0.16 0.02 268);
  --accent-soft: oklch(0.72 0.15 268 / 0.14);
  --ok: oklch(0.76 0.15 158);
  --ok-soft: oklch(0.76 0.15 158 / 0.15);
  --warn: oklch(0.83 0.13 85);
  --warn-soft: oklch(0.83 0.13 85 / 0.15);
  --danger: oklch(0.70 0.19 24);
  --danger-soft: oklch(0.70 0.19 24 / 0.15);
  --shadow: 0 8px 30px oklch(0.10 0.02 264 / 0.5);
  --radius: 12px;
  --mono: "Geist Mono", ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, monospace;
  --sans: "Geist", "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
}
:root[data-theme="light"] {
  --bg: oklch(0.975 0.004 264);
  --panel: oklch(1 0 0);
  --panel-2: oklch(0.975 0.005 264);
  --border: oklch(0.90 0.006 264);
  --border-strong: oklch(0.82 0.01 264);
  --ink: oklch(0.26 0.02 264);
  --muted: oklch(0.48 0.02 264);
  --faint: oklch(0.62 0.015 264);
  --accent: oklch(0.55 0.17 268);
  --accent-ink: oklch(0.99 0.01 268);
  --accent-soft: oklch(0.55 0.17 268 / 0.10);
  --ok: oklch(0.52 0.15 158);
  --ok-soft: oklch(0.52 0.15 158 / 0.12);
  --warn: oklch(0.62 0.13 78);
  --warn-soft: oklch(0.62 0.13 78 / 0.14);
  --danger: oklch(0.55 0.20 24);
  --danger-soft: oklch(0.55 0.20 24 / 0.12);
  --shadow: 0 8px 30px oklch(0.5 0.02 264 / 0.14);
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  font-family: var(--sans);
  background: var(--bg);
  color: var(--ink);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 24px 64px; }

/* Header */
header.bar {
  position: sticky; top: 0; z-index: 30;
  background: color-mix(in oklab, var(--bg) 86%, transparent);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
}
.bar-inner { max-width: 1180px; margin: 0 auto; padding: 14px 24px;
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: 10px; margin-right: auto; }
.brand .glyph { font-size: 20px; line-height: 1; }
.brand h1 { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; margin: 0; }
.brand .tag { color: var(--faint); font-size: 12px; font-weight: 500; }
.status { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px;
  color: var(--muted); font-variant-numeric: tabular-nums; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok);
  box-shadow: 0 0 0 0 var(--ok); }
.status.live .dot { animation: pulse 2.4s var(--ease) infinite; }
.status.stale .dot { background: var(--warn); }
.status.down .dot { background: var(--danger); }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 var(--ok-soft); } 70% { box-shadow: 0 0 0 6px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }

/* Buttons */
.btn { font: inherit; font-size: 13px; font-weight: 550; cursor: pointer;
  border: 1px solid var(--border-strong); background: var(--panel-2); color: var(--ink);
  padding: 7px 13px; border-radius: 9px; display: inline-flex; align-items: center; gap: 7px;
  transition: background .15s var(--ease), border-color .15s var(--ease), transform .06s var(--ease); }
.btn:hover { background: var(--panel); border-color: var(--faint); }
.btn:active { transform: translateY(1px); }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.btn.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; font-weight: 600; }
.btn.primary:hover { background: color-mix(in oklab, var(--accent) 88%, white); }
.btn.icon { padding: 7px 9px; }
.btn[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.btn.busy { pointer-events: none; opacity: 0.7; }
.btn .spin { width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid currentColor; border-top-color: transparent; animation: rot .6s linear infinite; }
@keyframes rot { to { transform: rotate(360deg); } }

/* Meta line */
.meta { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 22px 0 20px; color: var(--faint); font-size: 12.5px; }
.meta b { color: var(--muted); font-weight: 550; }
.meta code { font-family: var(--mono); color: var(--muted); }

/* Metric strip */
.metrics { display: grid; grid-template-columns: repeat(4, 1fr);
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  overflow: hidden; margin-bottom: 28px; }
.metric { padding: 16px 18px; border-left: 1px solid var(--border); }
.metric:first-child { border-left: 0; }
.metric .k { font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--faint); font-weight: 600; }
.metric .v { font-size: 27px; font-weight: 640; letter-spacing: -0.02em; margin-top: 3px;
  font-variant-numeric: tabular-nums; }
.metric.hot .v { color: var(--accent); }
.metric .u { font-size: 14px; color: var(--faint); font-weight: 500; margin-left: 2px; }
@media (max-width: 720px) { .metrics { grid-template-columns: repeat(2, 1fr); }
  .metric:nth-child(3) { border-left: 0; } }

/* Sections */
section { margin-bottom: 32px; }
.sec-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.sec-head h2 { font-size: 14px; font-weight: 620; letter-spacing: -0.01em; margin: 0; }
.sec-head .count { font-size: 12px; color: var(--faint); font-variant-numeric: tabular-nums;
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 20px; padding: 1px 9px; }

.panel { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.tscroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
thead th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
  color: var(--faint); font-weight: 600; padding: 11px 16px; border-bottom: 1px solid var(--border);
  white-space: nowrap; background: var(--panel-2); }
tbody td { padding: 12px 16px; border-bottom: 1px solid var(--border); white-space: nowrap; vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr.clk { cursor: pointer; transition: background .12s var(--ease); }
tbody tr.clk:hover { background: var(--panel-2); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); }
.idcell { display: flex; align-items: center; gap: 8px; }
.idcell .key { font-weight: 600; }
.idcell .chev { color: var(--faint); font-size: 11px; }
.mono { font-family: var(--mono); color: var(--muted); font-size: 12px; }
.sub { color: var(--faint); font-size: 12px; }

/* Badges */
.badge { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 550;
  padding: 2px 9px; border-radius: 20px; background: var(--panel-2); color: var(--muted);
  border: 1px solid var(--border); white-space: nowrap; }
.badge .bd { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.badge.active { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
.badge.ok { color: var(--ok); background: var(--ok-soft); border-color: transparent; }
.badge.warn { color: var(--warn); background: var(--warn-soft); border-color: transparent; }
.badge.danger { color: var(--danger); background: var(--danger-soft); border-color: transparent; }

/* Empty state (teaches the interface) */
.empty { padding: 40px 24px; text-align: center; }
.empty .ic { font-size: 26px; opacity: .55; }
.empty h3 { font-size: 14px; font-weight: 600; margin: 10px 0 4px; }
.empty p { color: var(--muted); max-width: 52ch; margin: 0 auto 14px; font-size: 13px; }
.empty code { font-family: var(--mono); background: var(--panel-2); border: 1px solid var(--border);
  padding: 1px 6px; border-radius: 6px; font-size: 12px; color: var(--ink); }

/* Ratelimit chip row */
.rl { display: flex; flex-wrap: wrap; gap: 10px 22px; padding: 14px 18px; }
.rl .item { display: flex; flex-direction: column; gap: 2px; }
.rl .item .k { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--faint); font-weight: 600; }
.rl .item .v { font-family: var(--mono); font-size: 13px; }
.bar-track { height: 6px; border-radius: 6px; background: var(--panel-2); overflow: hidden; width: 160px; margin-top: 4px; }
.bar-fill { height: 100%; background: var(--accent); border-radius: 6px; transition: width .4s var(--ease); }

/* Drawer */
#drawer-root { position: fixed; inset: 0; z-index: 60; display: none; }
#drawer-root.open { display: block; }
.scrim { position: absolute; inset: 0; background: oklch(0.1 0.02 264 / 0.5); opacity: 0; transition: opacity .2s var(--ease); }
#drawer-root.open .scrim { opacity: 1; }
.drawer { position: absolute; top: 0; right: 0; height: 100%; width: min(440px, 92vw);
  background: var(--panel); border-left: 1px solid var(--border); box-shadow: var(--shadow);
  transform: translateX(100%); transition: transform .26s var(--ease); display: flex; flex-direction: column; }
#drawer-root.open .drawer { transform: translateX(0); }
.drawer-head { display: flex; align-items: center; gap: 10px; padding: 16px 18px; border-bottom: 1px solid var(--border); }
.drawer-head h3 { margin: 0; font-size: 15px; font-weight: 640; }
.drawer-head .btn { margin-left: auto; }
.drawer-body { padding: 18px; overflow-y: auto; }
.kv { display: grid; grid-template-columns: 120px 1fr; gap: 8px 14px; font-size: 13px; }
.kv dt { color: var(--faint); }
.kv dd { margin: 0; word-break: break-word; }
.kv dd.mono { font-family: var(--mono); color: var(--ink); font-size: 12px; }

/* Form */
.form { display: flex; flex-direction: column; gap: 14px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field label { font-size: 12px; font-weight: 550; color: var(--muted); }
.field label .req { color: var(--danger); }
.field .hint { font-size: 11.5px; color: var(--faint); }
.input, .select, .textarea { font: inherit; font-size: 13px; color: var(--ink);
  background: var(--panel-2); border: 1px solid var(--border-strong); border-radius: 9px;
  padding: 9px 11px; width: 100%; transition: border-color .15s var(--ease); }
.textarea { resize: vertical; min-height: 76px; line-height: 1.5; }
.input:focus, .select:focus, .textarea:focus { outline: none; border-color: var(--accent); }
.input::placeholder, .textarea::placeholder { color: var(--faint); }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-actions { display: flex; gap: 8px; margin-top: 4px; }
.form-actions .btn { flex: 1; justify-content: center; }
.field-err { color: var(--danger); font-size: 12px; }

/* Toasts */
#toast-root { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 80;
  display: flex; flex-direction: column; gap: 8px; align-items: center; }
.toast { background: var(--panel); border: 1px solid var(--border-strong); color: var(--ink);
  padding: 9px 15px; border-radius: 10px; box-shadow: var(--shadow); font-size: 13px; font-weight: 500;
  display: flex; align-items: center; gap: 8px;
  animation: rise .22s var(--ease); }
.toast.ok { border-color: var(--ok); }
.toast.err { border-color: var(--danger); }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } }

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
`;

const JS = String.raw`
(function () {
  "use strict";
  var $ = function (sel, el) { return (el || document).querySelector(sel); };
  var state = window.__SYMPHONY__ || null;
  var auto = true;
  var lastOk = Date.now();
  var conn = "live"; // live | stale | down
  var THEME_KEY = "symphony.theme";

  // ---- theme ----
  var savedTheme = null;
  try { savedTheme = localStorage.getItem(THEME_KEY); } catch (e) {}
  if (!savedTheme) savedTheme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", savedTheme);
  function toggleTheme() {
    var t = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
    render();
  }

  // ---- helpers ----
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function nfmt(n) { return (n == null ? 0 : n).toLocaleString(); }
  function ago(iso) {
    if (!iso) return "—";
    var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return Math.floor(s) + "s ago";
    var m = Math.floor(s / 60), r = Math.floor(s % 60);
    if (m < 60) return m + "m " + r + "s ago";
    var h = Math.floor(m / 60); return h + "h " + (m % 60) + "m ago";
  }
  function dur(iso) {
    if (!iso) return "—";
    var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    var m = Math.floor(s / 60), r = Math.floor(s % 60);
    return m > 0 ? m + "m " + r + "s" : r + "s";
  }
  function until(iso) {
    if (!iso) return "—";
    var s = (new Date(iso).getTime() - Date.now()) / 1000;
    if (s <= 0) return "due now";
    return "in " + (s < 60 ? Math.ceil(s) + "s" : Math.floor(s / 60) + "m " + Math.floor(s % 60) + "s");
  }
  function humanSecs(s) {
    s = Math.round(s || 0);
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60); if (m < 60) return m + "m " + (s % 60) + "s";
    var h = Math.floor(m / 60); return h + "h " + (m % 60) + "m";
  }
  function badge(text, kind) {
    return '<span class="badge ' + (kind || "") + '"><span class="bd"></span>' + esc(text) + '</span>';
  }
  function eventKind(ev) {
    if (!ev) return "";
    if (/fail|error|cancel|timeout|stall|unsupported|malformed/.test(ev)) return "danger";
    if (/completed|session_started|approval/.test(ev)) return "ok";
    if (/input_required|startup_failed/.test(ev)) return "warn";
    return "";
  }

  // ---- data ----
  function fetchState() {
    return fetch("/api/v1/state", { headers: { accept: "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (j) { state = j; lastOk = Date.now(); conn = "live"; render(); })
      .catch(function () { conn = (Date.now() - lastOk > 12000) ? "down" : "stale"; paintStatus(); });
  }
  function pollNow(btn) {
    if (btn) { btn.classList.add("busy"); btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="spin"></span> Polling'; }
    fetch("/api/v1/refresh", { method: "POST" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (j) { toast(j.coalesced ? "Poll already queued" : "Poll + reconcile queued", "ok"); return fetchState(); })
      .catch(function () { toast("Could not queue poll", "err"); })
      .then(function () { if (btn) { btn.classList.remove("busy"); btn.innerHTML = btn.dataset.label; } });
  }
  function openDetail(identifier) {
    var root = $("#drawer-root");
    root.innerHTML = '<div class="scrim" data-close></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="Issue detail">'
      + '<div class="drawer-head"><h3>' + esc(identifier) + '</h3><button class="btn icon" data-close aria-label="Close">✕</button></div>'
      + '<div class="drawer-body"><p class="sub">Loading…</p></div></aside>';
    root.classList.add("open");
    fetch("/api/v1/" + encodeURIComponent(identifier), { headers: { accept: "application/json" } })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) { $(".drawer-body", root).innerHTML = res.ok ? detailHtml(res.j) : '<p class="sub">' + esc((res.j.error && res.j.error.message) || "Not found") + "</p>"; })
      .catch(function () { $(".drawer-body", root).innerHTML = '<p class="sub">Failed to load detail.</p>'; });
  }
  function closeDrawer() { var r = $("#drawer-root"); r.classList.remove("open"); setTimeout(function () { if (!r.classList.contains("open")) r.innerHTML = ""; }, 260); }

  function openCreate() {
    var m = (state && state.meta) || {};
    var states = m.active_states || ["todo"];
    var opts = states.map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + "</option>"; }).join("");
    var root = $("#drawer-root");
    root.innerHTML = '<div class="scrim" data-close></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="New issue">'
      + '<div class="drawer-head"><h3>New issue</h3><button class="btn icon" data-close aria-label="Close">✕</button></div>'
      + '<div class="drawer-body"><form class="form" id="newform" autocomplete="off">'
      + '<div class="field"><label for="f-id">Identifier <span class="req">*</span></label>'
        + '<input class="input" id="f-id" name="identifier" placeholder="SYM-3" required></div>'
      + '<div class="field"><label for="f-title">Title <span class="req">*</span></label>'
        + '<input class="input" id="f-title" name="title" placeholder="Short summary of the work" required></div>'
      + '<div class="field"><label for="f-desc">Description</label>'
        + '<textarea class="textarea" id="f-desc" name="description" placeholder="Tell the agent exactly what to do. It works in an isolated workspace, so include everything it needs, and how to know it is done."></textarea>'
        + '<span class="hint">This becomes the agent prompt via {{ issue.description }}.</span></div>'
      + '<div class="row2"><div class="field"><label for="f-state">State</label>'
        + '<select class="select" id="f-state" name="state">' + opts + "</select></div>"
      + '<div class="field"><label for="f-prio">Priority</label>'
        + '<select class="select" id="f-prio" name="priority"><option value="">None</option><option>1</option><option>2</option><option>3</option><option>4</option></select></div></div>'
      + '<div class="field"><label for="f-labels">Labels</label>'
        + '<input class="input" id="f-labels" name="labels" placeholder="docs, backend"><span class="hint">Comma-separated.</span></div>'
      + '<div class="field-err" id="f-err" hidden></div>'
      + '<div class="form-actions"><button type="button" class="btn" data-close>Cancel</button>'
        + '<button type="submit" class="btn primary">Create &amp; dispatch</button></div>'
      + "</form></div></aside>";
    root.classList.add("open");
    setTimeout(function () { var el = $("#f-id"); if (el) el.focus(); }, 60);
    $("#newform").addEventListener("submit", submitCreate);
  }

  function submitCreate(e) {
    e.preventDefault();
    var f = e.target, err = $("#f-err");
    err.hidden = true;
    var payload = {
      identifier: f.identifier.value.trim(),
      title: f.title.value.trim(),
      description: f.description.value.trim() || null,
      state: f.state.value || null,
      priority: f.priority.value ? Number(f.priority.value) : null,
      labels: f.labels.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean)
    };
    if (!payload.identifier || !payload.title) { err.textContent = "Identifier and title are required."; err.hidden = false; return; }
    var btn = f.querySelector('button[type=submit]');
    btn.classList.add("busy"); btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="spin"></span> Creating';
    fetch("/api/v1/issues", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.j.error && res.j.error.message) || "create failed");
        toast("Created " + payload.identifier + " · dispatching", "ok");
        closeDrawer();
        return fetchState();
      })
      .catch(function (ex) { err.textContent = String(ex.message || ex); err.hidden = false;
        btn.classList.remove("busy"); btn.innerHTML = btn.dataset.label; });
  }
  function detailHtml(d) {
    var run = d.running, ret = d.retry;
    var rows = [
      ["Status", badge(d.status, d.status === "running" ? "active" : "warn")],
      ["Issue id", '<span class="mono">' + esc(d.issue_id) + "</span>"],
      ["Workspace", '<span class="mono">' + esc(d.workspace && d.workspace.path) + "</span>"]
    ];
    if (run) {
      rows.push(["Tracker state", badge(run.state, "active")]);
      rows.push(["Session", '<span class="mono">' + esc(run.session_id || "—") + "</span>"]);
      rows.push(["Turns", '<span class="mono">' + esc(run.turn_count) + "</span>"]);
      rows.push(["Last event", (run.last_event ? badge(run.last_event, eventKind(run.last_event)) : "—")]);
      rows.push(["Last update", esc(ago(run.last_event_at))]);
      rows.push(["Elapsed", esc(dur(run.started_at))]);
      rows.push(["Tokens", '<span class="mono">' + nfmt(run.tokens && run.tokens.total_tokens) + " (" + nfmt(run.tokens && run.tokens.input_tokens) + " in / " + nfmt(run.tokens && run.tokens.output_tokens) + " out)</span>"]);
      if (run.last_message) rows.push(["Message", esc(run.last_message)]);
    }
    if (ret) {
      rows.push(["Retry attempt", '<span class="mono">' + esc(ret.attempt) + "</span>"]);
      rows.push(["Due", esc(until(ret.due_at))]);
      rows.push(["Reason", esc(ret.error || "—")]);
    }
    return '<dl class="kv">' + rows.map(function (r) { return "<dt>" + r[0] + "</dt><dd>" + r[1] + "</dd>"; }).join("") + "</dl>";
  }

  // ---- toast ----
  function toast(msg, kind) {
    var el = document.createElement("div");
    el.className = "toast " + (kind || "");
    el.textContent = msg;
    $("#toast-root").appendChild(el);
    setTimeout(function () { el.style.transition = "opacity .3s"; el.style.opacity = "0"; setTimeout(function () { el.remove(); }, 300); }, 2600);
  }

  // ---- render ----
  function paintStatus() {
    var s = $(".status"); if (!s) return;
    s.className = "status " + conn;
    var label = conn === "live" ? "Live" : conn === "stale" ? "Reconnecting" : "Disconnected";
    $(".status .txt").textContent = label + " · updated " + ago(state ? state.generated_at : null);
  }

  function render() {
    if (!state) return;
    var m = state.meta || {};
    var t = state.codex_totals || {};
    var running = state.running || [];
    var retrying = state.retrying || [];
    var themeIcon = document.documentElement.getAttribute("data-theme") === "dark" ? "◐" : "◑";

    var html = ""
    + '<header class="bar"><div class="bar-inner">'
    +   '<div class="brand"><span class="glyph">🎼</span><h1>Symphony</h1><span class="tag">orchestration console</span></div>'
    +   '<span class="status ' + conn + '"><span class="dot"></span><span class="txt"></span></span>'
    +   (m.can_create ? '<button class="btn primary" data-act="new">＋ New issue</button>' : "")
    +   '<button class="btn" data-act="poll">▸ Poll now</button>'
    +   '<button class="btn" data-act="auto" aria-pressed="' + auto + '">' + (auto ? "⏸ Auto: on" : "▷ Auto: off") + '</button>'
    +   '<a class="btn" href="/api/v1/state" target="_blank" rel="noopener">{ } API</a>'
    +   '<button class="btn icon" data-act="theme" aria-label="Toggle theme">' + themeIcon + '</button>'
    + '</div></header>'
    + '<div class="wrap">'
    +   '<div class="meta">'
    +     '<span><b>' + esc(m.tracker_kind || "?") + '</b> tracker</span>'
    +     '<span>agent <b>' + esc(m.agent_kind || "?") + '</b></span>'
    +     '<span>polling every <b>' + Math.round((m.poll_interval_ms || 0) / 1000) + 's</b></span>'
    +     '<span>concurrency <b>' + esc(m.max_concurrent_agents) + '</b></span>'
    +     '<span>active states <code>' + esc((m.active_states || []).join(", ") || "—") + '</code></span>'
    +   '</div>'
    +   '<div class="metrics">'
    +     metric("Running", running.length, "", running.length > 0)
    +     metric("Retrying", retrying.length, "")
    +     metric("Total tokens", nfmt(t.total_tokens), "")
    +     metric("Agent runtime", humanSecs(t.seconds_running), "")
    +   '</div>'
    +   section("Running sessions", running.length, running.length ? runningTable(running) : emptyRunning(m))
    +   section("Retry queue", retrying.length, retrying.length ? retryTable(retrying) : emptyRetry())
    +   rateLimit(state.rate_limits)
    + '</div>';

    $("#app").innerHTML = html;
    paintStatus();
  }

  function metric(k, v, u, hot) {
    return '<div class="metric ' + (hot ? "hot" : "") + '"><div class="k">' + esc(k) + '</div>'
      + '<div class="v">' + esc(v) + (u ? '<span class="u">' + esc(u) + "</span>" : "") + "</div></div>";
  }
  function section(title, count, body) {
    return '<section><div class="sec-head"><h2>' + esc(title) + '</h2><span class="count">' + count + "</span></div>" + body + "</section>";
  }
  function stateBadge(st) {
    var k = /done|complete|closed|merged/i.test(st) ? "ok" : /progress|review|doing/i.test(st) ? "active" : "";
    return badge(st, k);
  }
  function runningTable(rows) {
    var body = rows.map(function (r) {
      var link = r.issue_url ? esc(r.issue_url) : null;
      var tok = r.tokens || {};
      return '<tr class="clk" data-open="' + esc(r.issue_identifier) + '">'
        + '<td><div class="idcell"><span class="key">' + esc(r.issue_identifier) + '</span><span class="chev">›</span></div>'
        + (link ? '<div class="sub"><a href="' + link + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + link + "</a></div>" : "") + "</td>"
        + "<td>" + stateBadge(r.state) + "</td>"
        + "<td>" + (r.last_event ? badge(r.last_event, eventKind(r.last_event)) : '<span class="sub">—</span>')
          + (r.last_message ? '<div class="sub">' + esc(String(r.last_message).slice(0, 60)) + "</div>" : "") + "</td>"
        + '<td class="num">' + esc(r.turn_count) + "</td>"
        + '<td class="num">' + nfmt(tok.total_tokens) + "</td>"
        + '<td class="sub" data-rel="dur:' + esc(r.started_at) + '">' + esc(dur(r.started_at)) + "</td>"
        + '<td class="sub" data-rel="ago:' + esc(r.last_event_at) + '">' + esc(ago(r.last_event_at)) + "</td></tr>";
    }).join("");
    return '<div class="panel tscroll"><table><thead><tr>'
      + "<th>Issue</th><th>State</th><th>Last event</th><th class=num>Turns</th><th class=num>Tokens</th><th>Elapsed</th><th>Updated</th>"
      + "</tr></thead><tbody>" + body + "</tbody></table></div>";
  }
  function retryTable(rows) {
    var body = rows.map(function (r) {
      return '<tr class="clk" data-open="' + esc(r.issue_identifier) + '">'
        + '<td><span class="key">' + esc(r.issue_identifier) + "</span></td>"
        + '<td class="num">' + esc(r.attempt) + "</td>"
        + '<td><span class="badge warn" data-rel="until:' + esc(r.due_at) + '"><span class="bd"></span>' + esc(until(r.due_at)) + "</span></td>"
        + '<td class="sub">' + esc(r.error || "—") + "</td></tr>";
    }).join("");
    return '<div class="panel tscroll"><table><thead><tr>'
      + "<th>Issue</th><th class=num>Attempt</th><th>Next attempt</th><th>Reason</th>"
      + "</tr></thead><tbody>" + body + "</tbody></table></div>";
  }
  function emptyRunning(m) {
    var secs = Math.round((m.poll_interval_ms || 0) / 1000);
    return '<div class="panel empty"><div class="ic">🎧</div><h3>No agents are running</h3>'
      + '<p>Symphony polls the <b>' + esc(m.tracker_kind) + '</b> tracker every ' + secs + 's. Add an issue to <code>issues/</code> '
      + 'or move one into an active state (<code>' + (m.active_states || []).map(esc).join("</code>, <code>") + '</code>), then poll.</p>'
      + '<div style="display:flex;gap:8px;justify-content:center">'
      + (m.can_create ? '<button class="btn primary" data-act="new">＋ New issue</button>' : "")
      + '<button class="btn" data-act="poll">▸ Poll now</button></div></div>';
  }
  function emptyRetry() {
    return '<div class="panel empty"><div class="ic">✓</div><h3>Retry queue is clear</h3>'
      + '<p>Failed attempts and post-run continuation checks land here with a backoff timer. Nothing is waiting.</p></div>';
  }
  function rateLimit(rl) {
    if (!rl) return "";
    var p = rl.primary || {};
    var pct = typeof p.usedPercent === "number" ? p.usedPercent : null;
    var resets = p.resetsAt ? new Date(p.resetsAt * 1000).toLocaleString() : "—";
    var plan = rl.planType ? esc(rl.planType) : "—";
    return section("Agent rate limits", "", '<div class="panel"><div class="rl">'
      + '<div class="item"><span class="k">Plan</span><span class="v">' + plan + "</span></div>"
      + (pct != null ? '<div class="item"><span class="k">Primary window used</span><span class="v">' + pct + '%</span>'
          + '<div class="bar-track"><div class="bar-fill" style="width:' + Math.min(100, pct) + '%"></div></div></div>' : "")
      + '<div class="item"><span class="k">Resets</span><span class="v">' + esc(resets) + "</span></div>"
      + "</div></div>");
  }

  // ---- events (delegated) ----
  document.addEventListener("click", function (e) {
    var act = e.target.closest("[data-act]");
    if (act) {
      var a = act.getAttribute("data-act");
      if (a === "poll") pollNow(act);
      else if (a === "new") openCreate();
      else if (a === "auto") { auto = !auto; render(); toast(auto ? "Auto-refresh on" : "Auto-refresh paused", "ok"); }
      else if (a === "theme") toggleTheme();
      return;
    }
    if (e.target.closest("[data-close]")) { closeDrawer(); return; }
    var row = e.target.closest("[data-open]");
    if (row) openDetail(row.getAttribute("data-open"));
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDrawer(); });

  // Keep relative times honest between fetches without a full re-render.
  function tick() {
    paintStatus();
    var nodes = document.querySelectorAll("[data-rel]");
    for (var i = 0; i < nodes.length; i++) {
      var spec = nodes[i].getAttribute("data-rel");
      var k = spec.slice(0, spec.indexOf(":")), iso = spec.slice(spec.indexOf(":") + 1);
      var txt = k === "dur" ? dur(iso) : k === "until" ? until(iso) : ago(iso);
      if (nodes[i].classList.contains("badge")) nodes[i].lastChild.nodeValue = txt;
      else nodes[i].textContent = txt;
    }
  }

  // ---- loops ----
  render();
  setInterval(function () { if (auto) fetchState(); }, 2500);
  setInterval(tick, 1000);
})();
`;

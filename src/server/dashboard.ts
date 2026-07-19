/**
 * Symphony operational console (SPEC §13.7.1). Server sends a self-contained app
 * shell with the first snapshot embedded for instant paint; the client then polls
 * `/api/v1/state` for live updates and drives the control CTAs (`/api/v1/refresh`,
 * `/api/v1/<identifier>`). Drawn solely from orchestrator state — never required
 * for correctness.
 */
import type { SnapshotView } from "../orchestrator/orchestrator.ts";
import type { ProjectSummary } from "../project/manager.ts";

/** Everything the console shell needs to paint the selected project instantly. */
export interface DashboardBootstrap {
  projects: ProjectSummary[];
  can_add: boolean;
  selected: string;
  snapshot: SnapshotView | null;
}

/** Render the console shell with the selected project's snapshot inlined (progressive enhancement). */
export function renderDashboard(boot: DashboardBootstrap): string {
  const bootstrap = JSON.stringify(boot).replace(/</g, "\\u003c");
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
<div id="toast-root" aria-live="polite"></div>
<script>window.__SYMPHONY__ = ${bootstrap};</script>
<script>${JS}</script>
</body>
</html>`;
}

const CSS = String.raw`
:root {
  --bg: oklch(0.165 0.008 66);
  --panel: oklch(0.198 0.009 66);
  --panel-2: oklch(0.232 0.010 66);
  --border: oklch(0.295 0.011 66);
  --border-strong: oklch(0.40 0.014 66);
  --ink: oklch(0.965 0.006 80);
  --muted: oklch(0.735 0.012 74);
  --faint: oklch(0.585 0.012 74);
  --accent: oklch(0.80 0.128 74);
  --accent-ink: oklch(0.24 0.04 74);
  --accent-soft: oklch(0.80 0.128 74 / 0.15);
  --ok: oklch(0.77 0.15 158);
  --ok-soft: oklch(0.77 0.15 158 / 0.15);
  --warn: oklch(0.74 0.145 52);
  --warn-soft: oklch(0.74 0.145 52 / 0.16);
  --danger: oklch(0.685 0.19 24);
  --danger-soft: oklch(0.685 0.19 24 / 0.15);
  --shadow: 0 10px 40px -12px oklch(0.06 0.02 66 / 0.6);
  --radius: 10px;
  --mono: "Geist Mono", ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, monospace;
  --sans: "Geist", "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --ease: cubic-bezier(0.32, 0.72, 0, 1);
}
:root[data-theme="light"] {
  --bg: oklch(0.985 0.005 84);
  --panel: oklch(1 0 0);
  --panel-2: oklch(0.975 0.006 80);
  --border: oklch(0.905 0.007 76);
  --border-strong: oklch(0.83 0.011 72);
  --ink: oklch(0.255 0.014 66);
  --muted: oklch(0.475 0.018 70);
  --faint: oklch(0.60 0.016 72);
  --accent: oklch(0.60 0.125 66);
  --accent-ink: oklch(0.99 0.01 84);
  --accent-soft: oklch(0.60 0.125 66 / 0.12);
  --ok: oklch(0.53 0.14 158);
  --ok-soft: oklch(0.53 0.14 158 / 0.12);
  --warn: oklch(0.58 0.14 50);
  --warn-soft: oklch(0.58 0.14 50 / 0.14);
  --danger: oklch(0.55 0.20 24);
  --danger-soft: oklch(0.55 0.20 24 / 0.12);
  --shadow: 0 10px 40px -12px oklch(0.5 0.02 66 / 0.16);
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
.brand { display: flex; align-items: center; gap: 10px; margin-right: auto;
  background: none; border: 0; padding: 0; cursor: pointer; color: inherit; font: inherit; }
.brand:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 6px; }
.brand .glyph { display: inline-flex; color: var(--accent); }
.brand .glyph svg { display: block; }
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
  padding: 7px 13px; border-radius: 7px; display: inline-flex; align-items: center; gap: 7px;
  transition: background .12s var(--ease), border-color .12s var(--ease), transform .05s var(--ease); }
.btn:hover { background: var(--panel); border-color: var(--faint); }
.btn:active { transform: translateY(1px); }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.btn.primary { background: var(--ink); color: var(--bg); border-color: transparent; font-weight: 600; }
.btn.primary:hover { background: color-mix(in oklab, var(--ink) 86%, var(--bg)); }
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
.sec-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.sec-head h2 { font-size: 14px; font-weight: 620; letter-spacing: -0.01em; margin: 0; }
.count { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
  min-width: 21px; height: 21px; padding: 0 6px; font-family: var(--mono); font-size: 11.5px;
  font-weight: 600; line-height: 1; color: var(--faint); font-variant-numeric: tabular-nums;
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 999px; }

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
  padding: 2px 8px; border-radius: 6px; background: var(--panel-2); color: var(--muted);
  border: 1px solid var(--border); white-space: nowrap; }
.badge .bd { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.badge.active { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
.badge.ok { color: var(--ok); background: var(--ok-soft); border-color: transparent; }
.badge.warn { color: var(--warn); background: var(--warn-soft); border-color: transparent; }
.badge.danger { color: var(--danger); background: var(--danger-soft); border-color: transparent; }

/* Board */
.board-group { margin-bottom: 16px; }
.group-head { display: flex; align-items: center; gap: 9px; margin: 0 0 8px 16px; }
.group-head .gname { font-size: 11.5px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; }
.group-head .gname.st-backlog { color: var(--faint); }
.group-head .gname.st-active { color: var(--accent); }
.group-head .gname.st-terminal { color: var(--ok); }
.brow { display: flex; align-items: center; gap: 12px; padding: 11px 16px; border-bottom: 1px solid var(--border); }
.brow:last-child { border-bottom: 0; }
.brow.clk { cursor: pointer; transition: background .12s var(--ease); }
.brow.clk:hover { background: var(--panel-2); }
.brow .bkey { font-weight: 600; white-space: nowrap; }
.brow .btitle { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 40px; }
.brow .prio { font-family: var(--mono); font-size: 11px; color: var(--faint); border: 1px solid var(--border); border-radius: 6px; padding: 0 6px; }
.brow .actions { display: flex; gap: 6px; margin-left: auto; align-items: center; }
.run-ind { display: inline-flex; align-items: center; gap: 6px; color: var(--accent); font-size: 12px; font-weight: 550; white-space: nowrap; }
.run-ind .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: pulse 2.4s var(--ease) infinite; }
.btn.sm { padding: 4px 11px; font-size: 12px; border-radius: 6px; }
.agent-tag { font-family: var(--mono); font-size: 11px; color: var(--faint); border: 1px solid var(--border);
  border-radius: 6px; padding: 1px 7px; white-space: nowrap; }
.agent-select { font: inherit; font-family: var(--mono); font-size: 11.5px; color: var(--muted);
  background: var(--panel-2); border: 1px solid var(--border-strong); border-radius: 7px; padding: 3px 6px;
  cursor: pointer; max-width: 150px; transition: border-color .15s var(--ease); }
.agent-select:hover { border-color: var(--faint); }
.agent-select:focus { outline: none; border-color: var(--accent); }

/* Empty state (teaches the interface) */
.empty { padding: 40px 24px; text-align: center; }
.empty .ic { display: inline-flex; color: var(--faint); margin-bottom: 2px; }
.empty .ic svg { display: block; }
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

/* Focused page (detail / new / integrate) */
.page { animation: pagein .2s var(--ease); }
@keyframes pagein { from { opacity: 0; transform: translateY(6px); } }
.back { display: inline-flex; align-items: center; gap: 6px; background: none; border: 0; padding: 6px 0;
  color: var(--faint); font: inherit; font-size: 13px; font-weight: 550; cursor: pointer; transition: color .12s var(--ease); }
.back:hover { color: var(--ink); }
.back:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.page-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
  padding-bottom: 16px; margin-bottom: 22px; border-bottom: 1px solid var(--border); }
.page-head h1 { font-size: 22px; font-weight: 660; letter-spacing: -0.02em; margin: 0; }
.page-head .pkey { font-family: var(--mono); font-size: 13px; color: var(--faint); }
.page-head .spacer { margin-left: auto; }
.page-lead { color: var(--muted); font-size: 13.5px; max-width: 68ch; margin: -8px 0 24px; line-height: 1.6; }
.facts { display: flex; flex-wrap: wrap; gap: 6px 8px; margin-bottom: 22px; }
.fact { display: inline-flex; align-items: baseline; gap: 6px; font-size: 12.5px; color: var(--muted);
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 3px 9px; }
.fact b { color: var(--faint); font-weight: 550; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.fact .mono { font-family: var(--mono); color: var(--ink); font-size: 12px; }
.detail-grid { display: grid; grid-template-columns: 1fr 288px; gap: 22px; align-items: start; }
@media (max-width: 860px) { .detail-grid { grid-template-columns: 1fr; } }
.aside-card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; }
.aside-card + .aside-card { margin-top: 16px; }
.page-form { max-width: 620px; }
.page code { font-family: var(--mono); font-size: 11.5px; background: var(--panel-2); border: 1px solid var(--border);
  padding: 0 5px; border-radius: 5px; color: var(--ink); }
.kv { display: grid; grid-template-columns: 108px 1fr; gap: 9px 14px; font-size: 13px; }
.kv dt { color: var(--faint); }
.kv dd { margin: 0; word-break: break-word; }
.kv dd.mono { font-family: var(--mono); color: var(--ink); font-size: 12px; }

/* Activity log */
.log-head { font-size: 11.5px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em;
  color: var(--faint); margin: 20px 0 10px; display: flex; align-items: center; gap: 8px; }
.log { display: flex; flex-direction: column; gap: 0; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.log-row { display: grid; grid-template-columns: 58px 1fr; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 12.5px; }
.log-row:last-child { border-bottom: 0; }
.log-row .t { color: var(--faint); font-family: var(--mono); font-size: 11px; white-space: nowrap; padding-top: 2px; }
.log-row .ev { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.log-row .evname { font-weight: 550; }
.log-row .evname.ok { color: var(--ok); }
.log-row .evname.warn { color: var(--warn); }
.log-row .evname.danger { color: var(--danger); }
.log-row .evname.msg { color: var(--accent); }
.log-row .evmsg { color: var(--muted); white-space: pre-wrap; word-break: break-word; line-height: 1.45; }
.log-empty { padding: 14px; color: var(--faint); font-size: 12.5px; text-align: center; }

/* Integrate steps */
.isteps { display: flex; flex-direction: column; gap: 10px; }
.istep { display: grid; grid-template-columns: 26px 1fr; gap: 12px; align-items: start; }
.istep .inum { width: 24px; height: 24px; border-radius: 50%; background: var(--accent-soft); color: var(--accent);
  font-weight: 650; font-size: 12px; display: flex; align-items: center; justify-content: center; }
.istep .ititle { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
.istep .idesc { color: var(--muted); font-size: 12.5px; line-height: 1.5; }

/* Form */
.form { display: flex; flex-direction: column; gap: 14px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field label { font-size: 12px; font-weight: 550; color: var(--muted); }
.field label .req { color: var(--danger); }
.field .hint { font-size: 11.5px; color: var(--faint); }
.input, .select, .textarea { font: inherit; font-size: 13px; color: var(--ink);
  background: var(--panel-2); border: 1px solid var(--border-strong); border-radius: 7px;
  padding: 9px 11px; width: 100%; transition: border-color .12s var(--ease); }
.textarea { resize: vertical; min-height: 76px; line-height: 1.5; }
.input:focus, .select:focus, .textarea:focus { outline: none; border-color: var(--accent); }
.select.proj { width: auto; max-width: 190px; padding: 7px 11px; font-size: 13px; font-weight: 550; }
.input::placeholder, .textarea::placeholder { color: var(--faint); }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-actions { display: flex; gap: 8px; margin-top: 4px; }
.form-actions .btn { flex: 1; justify-content: center; }
.field-err { color: var(--danger); font-size: 12px; }

/* Toasts */
#toast-root { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 80;
  display: flex; flex-direction: column; gap: 8px; align-items: center; }
.toast { background: var(--panel); border: 1px solid var(--border-strong); color: var(--ink);
  padding: 9px 15px; border-radius: 8px; box-shadow: var(--shadow); font-size: 13px; font-weight: 500;
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
  var boot = window.__SYMPHONY__ || {};
  var projects = boot.projects || [];
  var canAdd = !!boot.can_add;
  var PID_KEY = "symphony.project";
  function validPid(p) { for (var i = 0; i < projects.length; i++) if (projects[i].id === p) return true; return false; }
  var pid = boot.selected || (projects[0] && projects[0].id) || "default";
  try { var savedPid = localStorage.getItem(PID_KEY); if (savedPid && validPid(savedPid)) pid = savedPid; } catch (e) {}
  function apiBase() { return "/api/v1/projects/" + encodeURIComponent(pid); }
  function savePid(p) { try { localStorage.setItem(PID_KEY, p); } catch (e) {} }
  // The server inlines a snapshot for boot.selected; if we restored a different project, fetch fresh.
  var state = (pid === boot.selected) ? (boot.snapshot || null) : null;
  var board = null;
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
  function fetchState(forceRender) {
    return fetch(apiBase() + "/state", { headers: { accept: "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (j) { state = j; lastOk = Date.now(); conn = "live"; render(forceRender); })
      .catch(function () { conn = (Date.now() - lastOk > 12000) ? "down" : "stale"; paintStatus(); });
  }
  function fetchBoard() {
    if (!state || !state.meta || !state.meta.can_board) return Promise.resolve();
    return fetch(apiBase() + "/issues", { headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (j) { board = j; render(); })
      .catch(function () {});
  }
  function setState(id, to, btn) {
    if (btn) { btn.classList.add("busy"); }
    fetch(apiBase() + "/issues/" + encodeURIComponent(id) + "/state", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: to })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.j.error && res.j.error.message) || "failed");
        toast(id + " → " + to, "ok");
        return Promise.all([fetchState(), fetchBoard()]);
      })
      .catch(function (ex) { toast(String(ex.message || ex), "err"); if (btn) btn.classList.remove("busy"); });
  }
  function setDefaultAgent(kind, el) {
    if (el) el.disabled = true;
    fetch(apiBase() + "/default-agent", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: kind })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.j.error && res.j.error.message) || "failed");
        toast("Default agent → " + res.j.default_agent, "ok");
        return fetchState(true);
      })
      .catch(function (ex) { toast(String(ex.message || ex), "err"); })
      .then(function () { if (el) el.disabled = false; });
  }
  function setIssueAgent(id, agent, el) {
    if (el) el.disabled = true;
    fetch(apiBase() + "/issues/" + encodeURIComponent(id) + "/agent", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: agent })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.j.error && res.j.error.message) || "failed");
        toast(id + " agent → " + (agent || "default"), "ok");
        return Promise.all([fetchState(), fetchBoard()]);
      })
      .catch(function (ex) { toast(String(ex.message || ex), "err"); if (el) el.disabled = false; });
  }
  function pollNow(btn) {
    if (btn) { btn.classList.add("busy"); btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="spin"></span> Polling'; }
    fetch(apiBase() + "/refresh", { method: "POST" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (j) { toast(j.coalesced ? "Poll already queued" : "Poll + reconcile queued", "ok"); return fetchState(); })
      .catch(function () { toast("Could not queue poll", "err"); })
      .then(function () { if (btn) { btn.classList.remove("busy"); btn.innerHTML = btn.dataset.label; } });
  }
  // ---- routing (hash-based; every route carries the project id: #/<pid>[/...]) ----
  // route: { name: "board" | "detail" | "new" | "integrate" | "add-project", id?: string }
  var route = { name: "board" };
  var detailData = null;   // cached detail payload for the open issue
  var detailErr = null;    // error string if the detail fetch failed

  function hashFor(name, id) {
    var base = "#/" + encodeURIComponent(pid);
    if (name === "detail") return base + "/issue/" + encodeURIComponent(id);
    if (name === "new") return base + "/new";
    if (name === "integrate") return base + "/integrate";
    if (name === "add-project") return base + "/add-project";
    return base;
  }
  function parseHash() {
    var h = (location.hash || "").replace(/^#\/?/, "");
    var parts = h.split("/").filter(function (x) { return x !== ""; });
    if (parts.length === 0) return { name: "board" };
    var p = decodeURIComponent(parts[0]);
    if (validPid(p)) { pid = p; savePid(p); } else return { name: "board" };
    var rest = parts.slice(1);
    if (rest[0] === "issue" && rest[1]) return { name: "detail", id: decodeURIComponent(rest[1]) };
    if (rest[0] === "new") return { name: "new" };
    if (rest[0] === "integrate") return { name: "integrate" };
    if (rest[0] === "add-project") return { name: "add-project" };
    return { name: "board" };
  }
  function navigate(hash) { if (location.hash === hash) applyRoute(); else location.hash = hash; }
  function goBoard() { navigate(hashFor("board")); }
  function switchProject(np) {
    if (!validPid(np) || np === pid) return;
    pid = np; savePid(np);
    state = null; board = null; detailData = null; detailErr = null;
    navigate(hashFor("board"));
    fetchState(); fetchBoard();
  }
  function applyRoute() {
    var pidBefore = pid;
    var next = parseHash();
    var changed = next.name !== route.name || next.id !== route.id;
    if (pid !== pidBefore) { state = null; board = null; detailData = null; detailErr = null; fetchState(); fetchBoard(); changed = true; }
    route = next;
    if (route.name === "detail") {
      if (changed) { detailData = null; detailErr = null; loadDetail(route.id); }
    } else { detailData = null; detailErr = null; }
    render();
    if (changed) window.scrollTo(0, 0);
  }
  function loadDetail(identifier) {
    return fetch(apiBase() + "/" + encodeURIComponent(identifier), { headers: { accept: "application/json" } })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (route.name !== "detail" || route.id !== identifier) return;
        if (res.ok) { detailData = res.j; detailErr = null; }
        else { detailData = null; detailErr = (res.j.error && res.j.error.message) || "Not found"; }
        render();
      })
      .catch(function () {
        if (route.name !== "detail" || route.id !== identifier) return;
        if (!detailData) { detailErr = "Failed to load detail."; render(); }
      });
  }
  function refreshOpenDetail() { if (route.name === "detail") loadDetail(route.id); }

  function integratePage() {
    var m = (state && state.meta) || {};
    var agents = m.agent_kinds || [m.agent_kind];
    var trackers = m.tracker_kinds || [m.tracker_kind];
    function chips(list, active) {
      return list.map(function (k) {
        return '<span class="badge ' + (k === active ? "active" : "") + '">' + (k === active ? '<span class="bd"></span>' : "") + esc(k) + "</span>";
      }).join(" ");
    }
    var steps = [
      ["Implement <code>AgentSession</code>", "Create <code>src/agent/&lt;your-agent&gt;.ts</code> with <code>start()</code> → <code>runTurn()</code>* → <code>stop()</code>. Launch your backend in the per-issue workspace and drive one turn per <code>runTurn</code>."],
      ["Emit <code>AgentUpdate</code>s", "Call <code>opts.onUpdate</code> with events like <code>session_started</code>, <code>turn_started</code>, <code>agent_message</code>, <code>command</code>, <code>turn_completed</code>, <code>turn_failed</code>. These feed the metrics and this activity log."],
      ["Register the backend", "Add a factory in <code>src/agent/registry.ts</code> via <code>registerAgentFactory({ kind, create })</code>."],
      ["Select it", "Set <code>agent.kind: &lt;your-agent&gt;</code> in <code>WORKFLOW.md</code>. Read your own config from <code>opts.config</code>."],
      ["Test", "Follow <code>test/orchestrator.test.ts</code> (<code>makeFakeFactory</code>) — register a fake backend and assert dispatch → result → done."]
    ];
    var stepHtml = steps.map(function (s, i) {
      return '<div class="istep"><div class="inum">' + (i + 1) + '</div><div><div class="ititle">' + s[0] + '</div><div class="idesc">' + s[1] + "</div></div></div>";
    }).join("");
    var defAgent = m.default_agent || m.agent_kind;
    var defSelect = agents.length > 1
      ? '<select class="select" data-default-agent>' + agents.map(function (k) {
          return '<option value="' + esc(k) + '"' + (k === defAgent ? " selected" : "") + ">" + esc(k) + "</option>";
        }).join("") + "</select><span class=\"hint\">Runs any task without its own agent set. Applies immediately.</span>"
      : '<div>' + chips(agents, defAgent) + '</div><span class="hint">Register another backend to switch the default per task.</span>';
    return pageHead("Integrate your own agent", "")
      + '<div class="page">'
      + '<p class="page-lead">Symphony talks to any coding agent through one <code>AgentSession</code> interface. The orchestrator, tracker, workspace, and this console are backend-neutral — adding an agent means writing one class and registering it.</p>'
      + '<div class="detail-grid"><div>'
      + '<div class="log-head">Add a backend in 5 steps</div><div class="isteps">' + stepHtml + "</div>"
      + '<p class="sub" style="margin-top:18px">Full walkthrough, the event vocabulary, and the tracker-adapter contract are in <code>INTEGRATION.md</code> in the repo.</p>'
      + '</div><div>'
      + '<div class="aside-card"><div class="field" style="margin:0"><label>Default agent</label>' + defSelect + "</div></div>"
      + '<div class="aside-card"><div class="log-head" style="margin-top:0">Registered agents</div><div>' + chips(agents, defAgent) + "</div>"
      + '<div class="log-head">Registered trackers</div><div>' + chips(trackers, m.tracker_kind) + "</div></div>"
      + "</div></div></div>";
  }

  function createPage() {
    var m = (state && state.meta) || {};
    // Offer backlog states first (new work parks in backlog by default) then active.
    var states = (m.backlog_states || []).concat(m.active_states || ["todo"]);
    if (!states.length) states = ["todo"];
    var opts = states.map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + "</option>"; }).join("");
    return pageHead("New issue", "")
      + '<div class="page"><form class="form page-form" id="newform" autocomplete="off">'
      + '<div class="field"><label for="f-id">Identifier <span class="req">*</span></label>'
        + '<input class="input" id="f-id" name="identifier" placeholder="SYM-3" required></div>'
      + '<div class="field"><label for="f-title">Title <span class="req">*</span></label>'
        + '<input class="input" id="f-title" name="title" placeholder="Short summary of the work" required></div>'
      + '<div class="field"><label for="f-desc">Description</label>'
        + '<textarea class="textarea" id="f-desc" name="description" placeholder="Tell the agent exactly what to do. It works in an isolated workspace, so include everything it needs, and how to know it is done."></textarea>'
        + '<span class="hint">This becomes the agent prompt via {{ issue.description }}.</span></div>'
      + '<div class="row2"><div class="field"><label for="f-state">State</label>'
        + '<select class="select" id="f-state" name="state">' + opts + "</select>"
        + '<span class="hint">Backlog waits; an active state runs now.</span></div>'
      + '<div class="field"><label for="f-prio">Priority</label>'
        + '<select class="select" id="f-prio" name="priority"><option value="">None</option><option>1</option><option>2</option><option>3</option><option>4</option></select></div></div>'
      + agentField(m)
      + '<div class="field"><label for="f-labels">Labels</label>'
        + '<input class="input" id="f-labels" name="labels" placeholder="docs, backend"><span class="hint">Comma-separated.</span></div>'
      + '<div class="field-err" id="f-err" hidden></div>'
      + '<div class="form-actions"><button type="button" class="btn" data-nav="' + hashFor("board") + '">Cancel</button>'
        + '<button type="submit" class="btn primary">Create &amp; dispatch</button></div>'
      + "</form></div>";
  }

  function agentField(m) {
    var kinds = m.agent_kinds || [m.default_agent];
    // Only worth choosing when more than one backend is registered.
    if (kinds.length < 2) return '<input type="hidden" id="f-agent" name="agent" value="">';
    var def = m.default_agent;
    var opts = '<option value="">Default (' + esc(def) + ")</option>"
      + kinds.map(function (k) { return '<option value="' + esc(k) + '">' + esc(k) + "</option>"; }).join("");
    return '<div class="field"><label for="f-agent">Agent</label>'
      + '<select class="select" id="f-agent" name="agent">' + opts + "</select>"
      + '<span class="hint">Which coding agent runs this task.</span></div>';
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
      agent: (f.agent && f.agent.value) ? f.agent.value : null,
      labels: f.labels.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean)
    };
    if (!payload.identifier || !payload.title) { err.textContent = "Identifier and title are required."; err.hidden = false; return; }
    var btn = f.querySelector('button[type=submit]');
    btn.classList.add("busy"); btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="spin"></span> Creating';
    fetch(apiBase() + "/issues", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.j.error && res.j.error.message) || "create failed");
        toast("Created " + payload.identifier + " · dispatching", "ok");
        goBoard();
        return Promise.all([fetchState(), fetchBoard()]);
      })
      .catch(function (ex) { err.textContent = String(ex.message || ex); err.hidden = false;
        btn.classList.remove("busy"); btn.innerHTML = btn.dataset.label; });
  }
  // Look up a human title for an identifier from the loaded board, if any.
  function detailTitle(identifier) {
    if (!board || !board.issues) return null;
    for (var i = 0; i < board.issues.length; i++) if (board.issues[i].identifier === identifier) return board.issues[i].title;
    return null;
  }
  function fact(label, valHtml) { return '<span class="fact"><b>' + esc(label) + "</b>" + valHtml + "</span>"; }
  // The three parts of the detail page that change on each poll, built separately so
  // a live refresh can patch them in place instead of re-rendering (and re-animating)
  // the whole page — that full rebuild every 2.5s is what made the page blink.
  function detailFragments(d) {
    var run = d.running, ret = d.retry;
    var statusKind = d.status === "running" ? "active" : d.status === "completed" ? "ok" : d.status === "queued" ? "active" : "warn";

    var facts = badge(d.status, statusKind);
    if (d.agent) facts += fact("agent", '<span class="mono">' + esc(d.agent) + "</span>");
    if (run) {
      facts += fact("turns", '<span class="mono">' + esc(run.turn_count) + "</span>");
      facts += fact("tokens", '<span class="mono">' + nfmt(run.tokens && run.tokens.total_tokens) + "</span>");
      facts += fact("elapsed", '<span class="mono">' + esc(dur(run.started_at)) + "</span>");
    } else if (d.ended_at) {
      facts += fact("ended", esc(ago(d.ended_at)));
    }

    var rows = [["Issue id", '<span class="mono">' + esc(d.issue_id) + "</span>"]];
    rows.push(["Tracker state", badge(run ? run.state : d.state, run ? "active" : "")]);
    rows.push(["Workspace", '<span class="mono">' + esc(d.workspace && d.workspace.path) + "</span>"]);
    if (run) {
      rows.push(["Session", '<span class="mono">' + esc(run.session_id || "—") + "</span>"]);
      rows.push(["Last event", (run.last_event ? badge(run.last_event, eventKind(run.last_event)) : "—")]);
      rows.push(["Last update", esc(ago(run.last_event_at))]);
      rows.push(["Tokens", '<span class="mono">' + nfmt(run.tokens && run.tokens.input_tokens) + " in / " + nfmt(run.tokens && run.tokens.output_tokens) + " out</span>"]);
      if (run.last_message) rows.push(["Message", esc(run.last_message)]);
    }
    if (ret) {
      rows.push(["Retry attempt", '<span class="mono">' + esc(ret.attempt) + "</span>"]);
      rows.push(["Due", esc(until(ret.due_at))]);
      rows.push(["Reason", esc(ret.error || "—")]);
    }
    if (d.last_error && !ret) rows.push(["Last error", esc(d.last_error)]);
    var kv = '<dl class="kv">' + rows.map(function (r) { return "<dt>" + r[0] + "</dt><dd>" + r[1] + "</dd>"; }).join("") + "</dl>";
    return { facts: facts, kv: kv, log: logHtml(d.recent_events || []) };
  }
  function detailPage(d) {
    var f = detailFragments(d);
    var title = detailTitle(d.issue_identifier);
    return pageHead(title || d.issue_identifier, title ? d.issue_identifier : "")
      + '<div class="page"><div class="facts" id="d-facts">' + f.facts + "</div>"
      + '<div class="detail-grid"><div id="d-log">' + f.log + "</div>"
      + '<div class="aside-card" id="d-kv">' + f.kv + "</div></div></div>";
  }
  // Update only the changing fragments if the detail shell is already mounted.
  // Returns false when there is no shell yet (first paint), so the caller full-renders.
  function patchDetail(d) {
    var fa = $("#d-facts"), lo = $("#d-log"), kv = $("#d-kv");
    if (!fa || !lo || !kv) return false;
    var f = detailFragments(d);
    fa.innerHTML = f.facts; lo.innerHTML = f.log; kv.innerHTML = f.kv;
    return true;
  }
  function logKind(ev) {
    if (ev === "agent_message") return "msg";
    if (/completed|session_started/.test(ev)) return "ok";
    if (/fail|error|cancel|timeout|stall|unsupported/.test(ev)) return "danger";
    if (/input_required|startup_failed/.test(ev)) return "warn";
    return "";
  }
  function logLabel(ev) { return String(ev || "").replace(/_/g, " "); }
  function logHtml(events) {
    var head = '<div class="log-head">Activity log <span class="count">' + events.length + "</span></div>";
    if (!events.length) return head + '<div class="log"><div class="log-empty">No agent activity recorded yet.</div></div>';
    var rows = events.slice().reverse().map(function (e) {
      var msg = e.message ? '<span class="evmsg">' + esc(e.message) + "</span>" : "";
      return '<div class="log-row"><span class="t">' + esc(shortTime(e.at)) + '</span>'
        + '<span class="ev"><span class="evname ' + logKind(e.event) + '">' + esc(logLabel(e.event)) + "</span>" + msg + "</span></div>";
    }).join("");
    return head + '<div class="log">' + rows + "</div>";
  }
  function shortTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
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

  function projectSwitcher() {
    if (projects.length <= 1 && !canAdd) return "";
    var opts = projects.map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (p.id === pid ? " selected" : "") + ">" + esc(p.name) + "</option>";
    }).join("");
    if (canAdd) opts += '<option value="__add__">＋ Add project…</option>';
    return '<select class="select proj" data-project aria-label="Project">' + opts + "</select>";
  }
  function headerHtml(m) {
    var themeIcon = document.documentElement.getAttribute("data-theme") === "dark" ? "◐" : "◑";
    var onBoard = route.name === "board";
    return '<header class="bar"><div class="bar-inner">'
    +   '<button class="brand" data-nav="' + hashFor("board") + '" aria-label="Symphony home"><span class="glyph"><svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 10.5v3.5M7 6v8M11 3v12M15 8v6"/></svg></span><h1>Symphony</h1><span class="tag">orchestration console</span></button>'
    +   projectSwitcher()
    +   '<span class="status ' + conn + '"><span class="dot"></span><span class="txt"></span></span>'
    +   (m.can_create ? '<button class="btn primary" data-nav="' + hashFor("new") + '"' + (route.name === "new" ? ' aria-pressed="true"' : "") + '>＋ New issue</button>' : "")
    +   (onBoard ? '<button class="btn" data-act="poll">▸ Poll now</button>' : "")
    +   (onBoard ? '<button class="btn" data-act="auto" aria-pressed="' + auto + '">' + (auto ? "⏸ Auto: on" : "▷ Auto: off") + '</button>' : "")
    +   '<button class="btn" data-nav="' + hashFor("integrate") + '"' + (route.name === "integrate" ? ' aria-pressed="true"' : "") + '>Integrate</button>'
    +   '<a class="btn" href="' + apiBase() + '/state" target="_blank" rel="noopener">{ } API</a>'
    +   '<button class="btn icon" data-act="theme" aria-label="Toggle theme">' + themeIcon + '</button>'
    + '</div></header>';
  }
  function pageHead(title, key) {
    return '<button class="back" data-nav="' + hashFor("board") + '"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg> Board</button>'
      + '<div class="page-head"><h1>' + esc(title) + "</h1>" + (key ? '<span class="pkey">' + esc(key) + "</span>" : "") + "</div>";
  }
  function boardBody(m) {
    var t = state.codex_totals || {};
    var running = state.running || [];
    var retrying = state.retrying || [];
    return '<div class="meta">'
    +     '<span><b>' + esc(m.tracker_kind || "?") + '</b> tracker</span>'
    +     '<span>agent <b>' + esc(m.default_agent || m.agent_kind || "?") + '</b></span>'
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
    +   boardSection(m)
    +   section("Running sessions", running.length, running.length ? runningTable(running) : emptyRunning(m))
    +   section("Retry queue", retrying.length, retrying.length ? retryTable(retrying) : emptyRetry())
    +   rateLimit(state.rate_limits, state.rate_limits_agent);
  }
  function routeBody(m) {
    if (route.name === "new") return m.can_create ? createPage() : notFoundPage("Creating issues is not supported by this tracker.");
    if (route.name === "integrate") return integratePage();
    if (route.name === "add-project") return canAdd ? addProjectPage() : notFoundPage("Adding projects is not enabled on this host.");
    if (route.name === "detail") {
      if (detailErr) return notFoundPage(detailErr);
      if (!detailData) return pageHead(route.id, "") + '<div class="page"><p class="sub">Loading…</p></div>';
      return detailPage(detailData);
    }
    return boardBody(m);
  }
  function notFoundPage(msg) {
    return pageHead("Not found", "") + '<div class="page"><div class="panel empty"><h3>' + esc(msg) + "</h3>"
      + '<p>The item you were looking at is no longer available.</p>'
      + '<button class="btn primary" data-nav="' + hashFor("board") + '">Back to board</button></div></div>';
  }
  function addProjectPage() {
    return pageHead("Add project", "")
      + '<div class="page"><form class="form page-form" id="addprojform" autocomplete="off">'
      + '<div class="field"><label for="f-wf">Workflow path <span class="req">*</span></label>'
        + '<input class="input" id="f-wf" name="workflow" placeholder="../my-app/WORKFLOW.md" required>'
        + '<span class="hint">Path to a WORKFLOW.md — or a project directory containing one — resolved where Symphony runs. Its issues + workspace stay isolated under that directory.</span></div>'
      + '<div class="field"><label for="f-name">Name</label>'
        + '<input class="input" id="f-name" name="name" placeholder="My App"><span class="hint">Optional display name; defaults to the folder name.</span></div>'
      + '<div class="field-err" id="ap-err" hidden></div>'
      + '<div class="form-actions"><button type="button" class="btn" data-nav="' + hashFor("board") + '">Cancel</button>'
        + '<button type="submit" class="btn primary">Add project</button></div>'
      + "</form></div>";
  }
  function submitAddProject(e) {
    e.preventDefault();
    var f = e.target, err = $("#ap-err");
    err.hidden = true;
    var payload = { workflow: f.workflow.value.trim(), name: f.name.value.trim() || null };
    if (!payload.workflow) { err.textContent = "Workflow path is required."; err.hidden = false; return; }
    var btn = f.querySelector('button[type=submit]');
    btn.classList.add("busy"); btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="spin"></span> Adding';
    fetch("/api/v1/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.j.error && res.j.error.message) || "add failed");
        var np = res.j.project;
        projects.push(np);
        toast("Added " + np.name, "ok");
        switchProject(np.id);
      })
      .catch(function (ex) { err.textContent = String(ex.message || ex); err.hidden = false;
        btn.classList.remove("busy"); btn.innerHTML = btn.dataset.label; });
  }

  function render(forceRender) {
    if (!state) return;
    var m = state.meta || {};
    // Never rebuild a form out from under the user mid-typing.
    if (route.name === "new" && $("#newform")) { paintStatus(); return; }
    if (route.name === "add-project" && $("#addprojform")) { paintStatus(); return; }
    // The integration guide has static content. Keeping it mounted avoids replaying
    // its page-entry animation on every background state poll.
    if (!forceRender && route.name === "integrate" && $(".page")) { paintStatus(); return; }
    // On a live refresh, patch the detail page in place — a full rebuild replays the
    // page-entrance animation every poll, which reads as a blink.
    if (route.name === "detail" && detailData && !detailErr && patchDetail(detailData)) { paintStatus(); return; }
    $("#app").innerHTML = headerHtml(m) + '<div class="wrap">' + routeBody(m) + "</div>";
    paintStatus();
    if (route.name === "new") { var el = $("#f-id"); if (el && el !== document.activeElement && !el.value) el.focus(); }
  }

  function metric(k, v, u, hot) {
    return '<div class="metric ' + (hot ? "hot" : "") + '"><div class="k">' + esc(k) + '</div>'
      + '<div class="v">' + esc(v) + (u ? '<span class="u">' + esc(u) + "</span>" : "") + "</div></div>";
  }
  function section(title, count, body) {
    return '<section><div class="sec-head"><h2>' + esc(title) + '</h2><span class="count">' + count + "</span></div>" + body + "</section>";
  }
  function boardSection(m) {
    if (!m.can_board) return "";
    if (!board) return section("Board", "", '<div class="panel empty"><p class="sub">Loading issues…</p></div>');
    var backlog = (board.backlog_states || []).map(function (s) { return s.toLowerCase(); });
    var terminal = (board.terminal_states || []).map(function (s) { return s.toLowerCase(); });
    var total = board.issues.length;
    var groupsHtml = board.order.map(function (st) {
      var items = board.issues.filter(function (i) { return i.state.toLowerCase() === st.toLowerCase(); });
      if (!items.length) return "";
      var lc = st.toLowerCase();
      var cls = backlog.indexOf(lc) >= 0 ? "st-backlog" : terminal.indexOf(lc) >= 0 ? "st-terminal" : "st-active";
      var rows = items.map(function (i) { return boardRow(i, board, m); }).join("");
      return '<div class="board-group"><div class="group-head"><span class="gname ' + cls + '">' + esc(st) + '</span>'
        + '<span class="count">' + items.length + '</span></div><div class="panel">' + rows + "</div></div>";
    }).join("");
    if (!total) {
      groupsHtml = emptyRunning(m);
    }
    return section("Board", total, groupsHtml);
  }
  function boardRow(i, b, m) {
    var key = i.url ? '<a class="bkey" href="' + esc(i.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + esc(i.identifier) + "</a>" : '<span class="bkey">' + esc(i.identifier) + "</span>";
    var prio = i.priority != null ? '<span class="prio">P' + esc(i.priority) + "</span>" : "";
    var actions = "";
    if (i.runtime === "running") actions = '<span class="run-ind"><span class="dot"></span>working · turn ' + esc(i.turn_count || 1) + "</span>";
    else if (i.runtime === "retrying") actions = '<span class="run-ind">retry queued</span>';
    else if (i.is_terminal) actions = '<button class="btn sm" data-state-id="' + esc(i.id) + '" data-state-to="' + esc((b.backlog_states[0] || "backlog")) + '">↺ Reopen</button>';
    else if (i.is_active) actions = '<button class="btn sm" data-state-id="' + esc(i.id) + '" data-state-to="' + esc((b.backlog_states[0] || "backlog")) + '">Hold</button>';
    else actions = '<button class="btn primary sm" data-state-id="' + esc(i.id) + '" data-state-to="' + esc(b.start_state) + '">▸ Start</button>';
    return '<div class="brow clk" data-open="' + esc(i.identifier) + '">' + key + '<span class="btitle">' + esc(i.title) + "</span>" + prio
      + agentControl(i, m)
      + '<div class="actions">' + actions + "</div></div>";
  }
  // Effective backend for a board row: a live select when a choice exists and the
  // task is not already running, otherwise a static badge.
  function agentControl(i, m) {
    var kinds = (m && m.agent_kinds) || [];
    var editable = m && m.can_set_agent && kinds.length > 1 && i.runtime === "idle";
    if (!editable) {
      var lbl = i.agent + (i.agent_override ? "" : " ·default");
      return '<span class="agent-tag" title="Agent backend">' + esc(lbl) + "</span>";
    }
    var def = m.default_agent;
    var opts = '<option value=""' + (i.agent_override ? "" : " selected") + ">Default (" + esc(def) + ")</option>"
      + kinds.map(function (k) {
          return '<option value="' + esc(k) + '"' + (k === i.agent_override ? " selected" : "") + ">" + esc(k) + "</option>";
        }).join("");
    return '<select class="agent-select" data-issue-agent="' + esc(i.id) + '" onclick="event.stopPropagation()" title="Agent backend">' + opts + "</select>";
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
    return '<div class="panel empty"><div class="ic"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 12v2M8 9v6M12 6v9M16 9v6M20 11v3"/></svg></div><h3>No agents are running</h3>'
      + '<p>Symphony polls the <b>' + esc(m.tracker_kind) + '</b> tracker every ' + secs + 's. Add an issue to <code>issues/</code> '
      + 'or move one into an active state (<code>' + (m.active_states || []).map(esc).join("</code>, <code>") + '</code>), then poll.</p>'
      + '<div style="display:flex;gap:8px;justify-content:center">'
      + (m.can_create ? '<button class="btn primary" data-nav="' + hashFor("new") + '">＋ New issue</button>' : "")
      + '<button class="btn" data-act="poll">▸ Poll now</button></div></div>';
  }
  function emptyRetry() {
    return '<div class="panel empty"><div class="ic"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg></div><h3>Retry queue is clear</h3>'
      + '<p>Failed attempts and post-run continuation checks land here with a backoff timer. Nothing is waiting.</p></div>';
  }
  function rateLimit(rl, agent) {
    if (!rl) return "";
    var p = rl.primary || {};
    var pct = typeof p.usedPercent === "number" ? p.usedPercent : null;
    var resets = p.resetsAt ? new Date(p.resetsAt * 1000).toLocaleString() : "—";
    var plan = rl.planType ? esc(rl.planType) : "—";
    var head = (agent ? esc(agent) + " " : "") + "rate limits";
    return section(head, "", '<div class="panel"><div class="rl">'
      + '<div class="item"><span class="k">Plan</span><span class="v">' + plan + "</span></div>"
      + (pct != null ? '<div class="item"><span class="k">Primary window used</span><span class="v">' + pct + '%</span>'
          + '<div class="bar-track"><div class="bar-fill" style="width:' + Math.min(100, pct) + '%"></div></div></div>' : "")
      + '<div class="item"><span class="k">Resets</span><span class="v">' + esc(resets) + "</span></div>"
      + "</div></div>");
  }

  // ---- events (delegated) ----
  document.addEventListener("click", function (e) {
    var nav = e.target.closest("[data-nav]");
    if (nav) { e.preventDefault(); navigate(nav.getAttribute("data-nav")); return; }
    var act = e.target.closest("[data-act]");
    if (act) {
      var a = act.getAttribute("data-act");
      if (a === "poll") pollNow(act);
      else if (a === "auto") { auto = !auto; render(); toast(auto ? "Auto-refresh on" : "Auto-refresh paused", "ok"); }
      else if (a === "theme") toggleTheme();
      return;
    }
    var sb = e.target.closest("[data-state-id]");
    if (sb) { setState(sb.getAttribute("data-state-id"), sb.getAttribute("data-state-to"), sb); return; }
    var row = e.target.closest("[data-open]");
    if (row) navigate(hashFor("detail", row.getAttribute("data-open")));
  });
  document.addEventListener("submit", function (e) {
    if (e.target && e.target.id === "newform") submitCreate(e);
    else if (e.target && e.target.id === "addprojform") submitAddProject(e);
  });
  document.addEventListener("change", function (e) {
    var pp = e.target.closest("[data-project]");
    if (pp) {
      if (pp.value === "__add__") { pp.value = pid; navigate(hashFor("add-project")); return; }
      switchProject(pp.value);
      return;
    }
    var da = e.target.closest("[data-default-agent]");
    if (da) { setDefaultAgent(da.value, da); return; }
    var ia = e.target.closest("[data-issue-agent]");
    if (ia) { setIssueAgent(ia.getAttribute("data-issue-agent"), ia.value, ia); return; }
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && route.name !== "board") goBoard(); });
  window.addEventListener("hashchange", applyRoute);

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
  // Normalize the URL so it always carries the active project id (stable, shareable).
  (function () {
    var first = decodeURIComponent(((location.hash || "").replace(/^#\/?/, "").split("/")[0]) || "");
    if (!validPid(first)) location.replace(location.pathname + location.search + hashFor("board"));
  })();
  applyRoute();
  // The inlined snapshot is only for boot.selected; fetch the active project's fresh
  // state so a restored (different) project paints immediately instead of on next poll.
  fetchState();
  fetchBoard();
  setInterval(function () { if (auto) { fetchState(); fetchBoard(); refreshOpenDetail(); } }, 2500);
  setInterval(tick, 1000);
})();
`;

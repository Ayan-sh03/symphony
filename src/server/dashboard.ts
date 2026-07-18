/**
 * Server-rendered dashboard (SPEC §13.7.1). Draws solely from the orchestrator
 * snapshot; a client can also consume /api/v1/state directly.
 */
import type { SnapshotView } from "../orchestrator/orchestrator.ts";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderDashboard(s: SnapshotView): string {
  const runningRows = (s.running as Array<Record<string, unknown>>)
    .map((r) => {
      const tokens = r.tokens as Record<string, number>;
      const url = r.issue_url ? `<a href="${esc(r.issue_url)}">${esc(r.issue_identifier)}</a>` : esc(r.issue_identifier);
      return `<tr>
        <td>${url}</td>
        <td>${esc(r.state)}</td>
        <td>${esc(r.session_id ?? "—")}</td>
        <td class="num">${esc(r.turn_count)}</td>
        <td>${esc(r.last_event ?? "—")}</td>
        <td class="num">${esc(tokens?.total_tokens ?? 0)}</td>
        <td>${esc(r.started_at)}</td>
      </tr>`;
    })
    .join("");

  const retryRows = (s.retrying as Array<Record<string, unknown>>)
    .map(
      (r) => `<tr>
        <td>${esc(r.issue_identifier)}</td>
        <td class="num">${esc(r.attempt)}</td>
        <td>${esc(r.due_at)}</td>
        <td>${esc(r.error ?? "")}</td>
      </tr>`,
    )
    .join("");

  const t = s.codex_totals;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Symphony</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; background: #0d1117; color: #e6edf3; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8b949e; margin-bottom: 20px; }
  .cards { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 14px 18px; min-width: 130px; }
  .card .v { font-size: 24px; font-weight: 600; }
  .card .k { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 28px; overflow-x: auto; display: block; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #21262d; white-space: nowrap; }
  th { color: #8b949e; font-weight: 600; font-size: 12px; text-transform: uppercase; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  a { color: #58a6ff; }
  .empty { color: #6e7681; padding: 8px 10px; }
  h2 { font-size: 15px; margin: 0 0 8px; }
</style>
</head>
<body>
  <h1>🎼 Symphony</h1>
  <div class="sub">generated ${esc(s.generated_at)} · auto-refresh 5s</div>
  <div class="cards">
    <div class="card"><div class="v">${esc(s.counts.running)}</div><div class="k">Running</div></div>
    <div class="card"><div class="v">${esc(s.counts.retrying)}</div><div class="k">Retrying</div></div>
    <div class="card"><div class="v">${esc(t.total_tokens)}</div><div class="k">Total tokens</div></div>
    <div class="card"><div class="v">${esc(Math.round(t.seconds_running))}s</div><div class="k">Runtime</div></div>
  </div>

  <h2>Running sessions</h2>
  <table>
    <thead><tr><th>Issue</th><th>State</th><th>Session</th><th class="num">Turns</th><th>Last event</th><th class="num">Tokens</th><th>Started</th></tr></thead>
    <tbody>${runningRows || `<tr><td colspan="7" class="empty">no active sessions</td></tr>`}</tbody>
  </table>

  <h2>Retry queue</h2>
  <table>
    <thead><tr><th>Issue</th><th class="num">Attempt</th><th>Due</th><th>Error</th></tr></thead>
    <tbody>${retryRows || `<tr><td colspan="4" class="empty">retry queue empty</td></tr>`}</tbody>
  </table>
</body>
</html>`;
}

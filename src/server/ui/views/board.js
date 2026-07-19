/** Board route: meta line, metric strip, tracker board, running sessions, retry queue, rate limits. */
import { html, nothing } from "../vendor/lit-html/lit-html.js";
import { repeat } from "../vendor/lit-html/directives/repeat.js";
import { live } from "../vendor/lit-html/directives/live.js";
import { store } from "../store.js";
import { hashFor } from "../router.js";
import { ago, dur, until, humanSecs, nfmt, badge, stateBadge, eventKind } from "../format.js";

const stop = (e) => e.stopPropagation();

function metric(k, v, u, hot) {
  return html`<div class="metric ${hot ? "hot" : ""}"><div class="k">${k}</div>
    <div class="v">${v}${u ? html`<span class="u">${u}</span>` : nothing}</div></div>`;
}

function section(title, count, body) {
  return html`<section><div class="sec-head"><h2>${title}</h2><span class="count">${count}</span></div>${body}</section>`;
}

// Effective backend for a board row: a live select when a choice exists and the
// task is not already running, otherwise a static badge.
function agentControl(i, m) {
  const kinds = (m && m.agent_kinds) || [];
  const editable = m && m.can_set_agent && kinds.length > 1 && i.runtime === "idle";
  if (!editable) {
    return html`<span class="agent-tag" title="Agent backend">${i.agent + (i.agent_override ? "" : " ·default")}</span>`;
  }
  // `?selected` picks the right option on first paint; `live(.value)` keeps the DOM
  // tracking server state on later repaints without fighting an open native dropdown.
  return html`<select class="agent-select" data-issue-agent=${i.id} .value=${live(i.agent_override || "")} @click=${stop} title="Agent backend">
    <option value="" ?selected=${!i.agent_override}>Default (${m.default_agent})</option>
    ${kinds.map((k) => html`<option value=${k} ?selected=${k === i.agent_override}>${k}</option>`)}
  </select>`;
}

function boardRow(i, b, m) {
  const key = i.url
    ? html`<a class="bkey" href=${i.url} target="_blank" rel="noopener" @click=${stop}>${i.identifier}</a>`
    : html`<span class="bkey">${i.identifier}</span>`;
  let actions;
  if (i.runtime === "running") actions = html`<span class="run-ind"><span class="dot"></span>working · turn ${i.turn_count || 1}</span>`;
  else if (i.runtime === "retrying") actions = html`<span class="run-ind">retry queued</span>`;
  else if (i.is_terminal) actions = html`<button class="btn sm" data-state-id=${i.id} data-state-to=${b.backlog_states[0] || "backlog"}>↺ Reopen</button>`;
  else if (i.is_active) actions = html`<button class="btn sm" data-state-id=${i.id} data-state-to=${b.backlog_states[0] || "backlog"}>Hold</button>`;
  else actions = html`<button class="btn primary sm" data-state-id=${i.id} data-state-to=${b.start_state}>▸ Start</button>`;
  return html`<div class="brow clk" data-open=${i.identifier}>${key}<span class="btitle">${i.title}</span>
    ${i.priority != null ? html`<span class="prio">P${i.priority}</span>` : nothing}
    ${agentControl(i, m)}
    <div class="actions">${actions}</div></div>`;
}

function boardSection(m) {
  if (!m.can_board) return nothing;
  const board = store.board;
  if (!board) return section("Board", "", html`<div class="panel empty"><p class="sub">Loading issues…</p></div>`);
  const backlog = (board.backlog_states || []).map((s) => s.toLowerCase());
  const terminal = (board.terminal_states || []).map((s) => s.toLowerCase());
  const total = board.issues.length;
  if (!total) return section("Board", total, emptyRunning(m));
  const groups = board.order.map((st) => {
    const items = board.issues.filter((i) => i.state.toLowerCase() === st.toLowerCase());
    if (!items.length) return nothing;
    const lc = st.toLowerCase();
    const cls = backlog.includes(lc) ? "st-backlog" : terminal.includes(lc) ? "st-terminal" : "st-active";
    return html`<div class="board-group"><div class="group-head"><span class="gname ${cls}">${st}</span>
      <span class="count">${items.length}</span></div>
      <div class="panel">${repeat(items, (i) => i.id, (i) => boardRow(i, board, m))}</div></div>`;
  });
  return section("Board", total, groups);
}

function runningTable(rows) {
  return html`<div class="panel tscroll"><table><thead><tr>
    <th>Issue</th><th>State</th><th>Last event</th><th class="num">Turns</th><th class="num">Tokens</th><th>Elapsed</th><th>Updated</th>
    </tr></thead><tbody>${repeat(rows, (r) => r.issue_identifier, (r) => {
      const tok = r.tokens || {};
      return html`<tr class="clk" data-open=${r.issue_identifier}>
        <td><div class="idcell"><span class="key">${r.issue_identifier}</span><span class="chev">›</span></div>
          ${r.issue_url ? html`<div class="sub"><a href=${r.issue_url} target="_blank" rel="noopener" @click=${stop}>${r.issue_url}</a></div>` : nothing}</td>
        <td>${stateBadge(r.state)}</td>
        <td>${r.last_event ? badge(r.last_event, eventKind(r.last_event)) : html`<span class="sub">—</span>`}
          ${r.last_message ? html`<div class="sub">${String(r.last_message).slice(0, 60)}</div>` : nothing}</td>
        <td class="num">${r.turn_count}</td>
        <td class="num">${nfmt(tok.total_tokens)}</td>
        <td class="sub">${dur(r.started_at)}</td>
        <td class="sub">${ago(r.last_event_at)}</td></tr>`;
    })}</tbody></table></div>`;
}

function retryTable(rows) {
  return html`<div class="panel tscroll"><table><thead><tr>
    <th>Issue</th><th class="num">Attempt</th><th>Next attempt</th><th>Reason</th>
    </tr></thead><tbody>${repeat(rows, (r) => r.issue_identifier, (r) => html`<tr class="clk" data-open=${r.issue_identifier}>
      <td><span class="key">${r.issue_identifier}</span></td>
      <td class="num">${r.attempt}</td>
      <td>${badge(until(r.due_at), "warn")}</td>
      <td class="sub">${r.error || "—"}</td></tr>`)}</tbody></table></div>`;
}

function emptyRunning(m) {
  const secs = Math.round((m.poll_interval_ms || 0) / 1000);
  const states = m.active_states || [];
  return html`<div class="panel empty"><div class="ic"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 12v2M8 9v6M12 6v9M16 9v6M20 11v3"/></svg></div><h3>No agents are running</h3>
    <p>Symphony polls the <b>${m.tracker_kind}</b> tracker every ${secs}s. Add an issue to <code>issues/</code>
    or move one into an active state (${states.map((s, i) => html`${i ? ", " : ""}<code>${s}</code>`)}), then poll.</p>
    <div style="display:flex;gap:8px;justify-content:center">
      ${m.can_create ? html`<button class="btn primary" data-nav=${hashFor("new")}>＋ New issue</button>` : nothing}
      <button class="btn" data-act="poll">▸ Poll now</button></div></div>`;
}

function emptyRetry() {
  return html`<div class="panel empty"><div class="ic"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg></div><h3>Retry queue is clear</h3>
    <p>Failed attempts and post-run continuation checks land here with a backoff timer. Nothing is waiting.</p></div>`;
}

function rateLimit(rl, agent) {
  if (!rl) return nothing;
  const p = rl.primary || {};
  const pct = typeof p.usedPercent === "number" ? p.usedPercent : null;
  const resets = p.resetsAt ? new Date(p.resetsAt * 1000).toLocaleString() : "—";
  const head = (agent ? agent + " " : "") + "rate limits";
  return section(head, "", html`<div class="panel"><div class="rl">
    <div class="item"><span class="k">Plan</span><span class="v">${rl.planType || "—"}</span></div>
    ${pct != null ? html`<div class="item"><span class="k">Primary window used</span><span class="v">${pct}%</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, pct)}%"></div></div></div>` : nothing}
    <div class="item"><span class="k">Resets</span><span class="v">${resets}</span></div>
    </div></div>`);
}

export function boardBody(m) {
  const state = store.state;
  const t = state.codex_totals || {};
  const running = state.running || [];
  const retrying = state.retrying || [];
  return html`<div class="meta">
      <span><b>${m.tracker_kind || "?"}</b> tracker</span>
      <span>agent <b>${m.default_agent || m.agent_kind || "?"}</b></span>
      <span>polling every <b>${Math.round((m.poll_interval_ms || 0) / 1000)}s</b></span>
      <span>concurrency <b>${m.max_concurrent_agents}</b></span>
      <span>active states <code>${(m.active_states || []).join(", ") || "—"}</code></span>
    </div>
    <div class="metrics">
      ${metric("Running", running.length, "", running.length > 0)}
      ${metric("Retrying", retrying.length, "")}
      ${metric("Total tokens", nfmt(t.total_tokens), "")}
      ${metric("Agent runtime", humanSecs(t.seconds_running), "")}
    </div>
    ${boardSection(m)}
    ${section("Running sessions", running.length, running.length ? runningTable(running) : emptyRunning(m))}
    ${section("Retry queue", retrying.length, retrying.length ? retryTable(retrying) : emptyRetry())}
    ${rateLimit(state.rate_limits, state.rate_limits_agent)}`;
}

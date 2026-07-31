/** Header bar: brand, project switcher, connection status, and the control CTAs. */
import { html, nothing } from "../vendor/lit-html/lit-html.js";
import { store, apiBase } from "../store.js";
import { hashFor } from "../router.js";
import { ago } from "../format.js";

function projectSwitcher() {
  if (store.projects.length <= 1 && !store.canAdd) return nothing;
  const cur = store.projects.find((p) => p.id === store.pid);
  const label = cur ? cur.name : store.pid;
  return html`<div class="proj-switch">
    <button class="proj-btn" type="button" data-proj-toggle aria-haspopup="menu" aria-expanded=${store.projMenuOpen} aria-label="Switch project">
      <span class="pdot"></span><span class="plabel">${label}</span>
      <svg class="caret" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="proj-menu${store.projMenuOpen ? " open" : ""}" role="menu">
      <div class="proj-cap">Project</div>
      ${store.projects.map((p) => html`<button class="proj-item" role="menuitem" data-pick=${p.id} aria-current=${p.id === store.pid}>
        <span class="pdot"></span><span>${p.name}</span>
        <svg class="tick" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
      </button>`)}
      ${store.canAdd ? html`<button class="proj-item add" role="menuitem" data-pick="__add__">＋ Add project…</button>` : nothing}
    </div>
  </div>`;
}

function statusText() {
  const label = store.conn === "sse" ? "Live (SSE)" : store.conn === "poll" ? "Live (poll)" : store.conn === "stale" ? "Reconnecting" : "Disconnected";
  return label + " · updated " + ago(store.state ? store.state.generated_at : null);
}

export function headerView(m) {
  const themeIcon = document.documentElement.getAttribute("data-theme") === "dark" ? "◐" : "◑";
  const onBoard = store.route.name === "board";
  return html`<header class="bar"><div class="bar-inner">
    <div class="hgroup">
      <button class="brand" data-nav=${hashFor("board")} aria-label="Symphony home"><span class="glyph"><svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 10.5v3.5M7 6v8M11 3v12M15 8v6"/></svg></span><h1>Symphony</h1><span class="tag">orchestration console</span></button>
      ${projectSwitcher()}
    </div>
    <span class="status ${store.conn}"><span class="dot"></span><span class="txt">${statusText()}</span></span>
    ${m.can_create ? html`<button class="btn primary" data-nav=${hashFor("new")} aria-pressed=${store.route.name === "new" ? "true" : nothing}>＋ New issue</button>` : nothing}
    ${onBoard ? html`<button class="btn" data-act="poll">▸ Poll now</button>` : nothing}
    ${onBoard ? html`<button class="btn" data-act="auto" aria-pressed=${store.auto}>${store.auto ? "⏸ Auto: on" : "▷ Auto: off"}</button>` : nothing}
    <button class="btn" data-nav=${hashFor("integrate")} aria-pressed=${store.route.name === "integrate" ? "true" : nothing}>Integrate</button>
    <a class="btn" href="${apiBase()}/state" target="_blank" rel="noopener">{ } API</a>
    <button class="btn icon" data-act="theme" aria-label="Toggle theme">${themeIcon}</button>
  </div></header>`;
}

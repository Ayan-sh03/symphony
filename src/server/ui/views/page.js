/** Shared chrome for focused pages (detail / new / integrate / add-project). */
import { html } from "../vendor/lit-html/lit-html.js";
import { hashFor } from "../router.js";

export function pageHead(title, key) {
  return html`<button class="back" data-nav=${hashFor("board")}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg> Board</button>
    <div class="page-head"><h1>${title}</h1>${key ? html`<span class="pkey">${key}</span>` : ""}</div>`;
}

export function notFoundPage(msg) {
  return html`${pageHead("Not found", "")}
    <div class="page"><div class="panel empty"><h3>${msg}</h3>
      <p>The item you were looking at is no longer available.</p>
      <button class="btn primary" data-nav=${hashFor("board")}>Back to board</button></div></div>`;
}

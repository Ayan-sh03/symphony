/** Formatting helpers shared across console views (SPEC §13.7.1). */
import { html } from "./vendor/lit-html/lit-html.js";

export function nfmt(n) { return (n == null ? 0 : n).toLocaleString(); }

export function ago(iso) {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.floor(s) + "s ago";
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  if (m < 60) return m + "m " + r + "s ago";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m ago";
}

export function dur(iso) {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return m > 0 ? m + "m " + r + "s" : r + "s";
}

export function until(iso) {
  if (!iso) return "—";
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s <= 0) return "due now";
  return "in " + (s < 60 ? Math.ceil(s) + "s" : Math.floor(s / 60) + "m " + Math.floor(s % 60) + "s");
}

export function humanSecs(s) {
  s = Math.round(s || 0);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

export function shortTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
}

export function badge(text, kind) {
  return html`<span class="badge ${kind || ""}"><span class="bd"></span>${text}</span>`;
}

export function stateBadge(st) {
  const k = /done|complete|closed|merged/i.test(st) ? "ok" : /progress|review|doing/i.test(st) ? "active" : "";
  return badge(st, k);
}

export function eventKind(ev) {
  if (!ev) return "";
  if (/fail|error|cancel|timeout|stall|unsupported|malformed/.test(ev)) return "danger";
  if (/completed|session_started|approval/.test(ev)) return "ok";
  if (/input_required|startup_failed/.test(ev)) return "warn";
  return "";
}

export function logKind(ev) {
  if (ev === "agent_message") return "msg";
  if (/completed|session_started/.test(ev)) return "ok";
  if (/fail|error|cancel|timeout|stall|unsupported/.test(ev)) return "danger";
  if (/input_required|startup_failed/.test(ev)) return "warn";
  return "";
}

export function logLabel(ev) { return String(ev || "").replace(/_/g, " "); }

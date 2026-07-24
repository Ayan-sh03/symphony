/** Copy helpers for the console (delivery branch/SHA).
 * navigator.clipboard only exists in a secure context, so a console served over
 * plain HTTP to anything but localhost has to fall back to the old selection
 * trick — otherwise every Copy button in the delivery panel just fails. */
import { toast } from "./toast.js";

function legacyCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  // Off-screen but still focusable: execCommand only copies a live selection.
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
  document.body.appendChild(ta);
  try {
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

/** Copy text to the clipboard with a toast. `what` names the value in the toast. */
export function copyText(text, what) {
  const label = what || "Value";
  const ok = () => toast(label + " copied", "ok");
  const fail = () => { if (legacyCopy(text)) ok(); else toast("Copy failed", "err"); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(ok, fail);
  } else {
    fail();
  }
}

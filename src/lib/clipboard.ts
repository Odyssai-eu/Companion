/**
 * Safe clipboard write that works on both HTTPS and HTTP origins.
 *
 * The Async Clipboard API (`navigator.clipboard.writeText`) is only
 * available in secure contexts — HTTPS, localhost, or 127.0.0.1. On a
 * LAN deploy of Companion served over plain `http://192.168.x.y:3100`
 * (the standard internal setup), Safari treats `navigator.clipboard` as
 * `undefined` and Chrome resolves `writeText` to a Promise that
 * rejects with a permission error.
 *
 * We try the modern API first (which gives proper user feedback on a
 * secure origin), then fall back to the legacy `document.execCommand`
 * trick via a hidden textarea — that path still works on insecure
 * origins and on older browsers.
 *
 * Returns `true` if the copy is believed to have succeeded.
 *
 * Mirrors the `_fallbackUuid` pattern used elsewhere for
 * `crypto.randomUUID()` on insecure contexts.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // 1. Modern path — works on HTTPS and localhost.
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied (insecure origin, user gesture missing, etc.)
      // Fall through to the legacy path.
    }
  }

  // 2. Legacy path — works on http:// origins where the Async API is
  //    refused. Requires a same-event-loop synchronous execCommand
  //    triggered by a user gesture (which is exactly the situation
  //    every caller is in: button click handler).
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  // Off-screen but inside the layout so contentEditable + selection work
  // across browsers — `display:none` is unreliable for execCommand.
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.width = "1px";
  ta.style.height = "1px";
  ta.style.padding = "0";
  ta.style.border = "0";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  document.body.appendChild(ta);
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}

/**
 * Resolve the `Secure` flag for the session cookie from the COOKIE_SECURE env.
 *
 * Accepts `0`/`1` and `false`/`true` (case-insensitive, trimmed). When unset or
 * unrecognised, defaults to ON in production (`NODE_ENV === "production"`).
 *
 * Why the escape hatch matters: Companion's common operator setup is plain HTTP
 * on a LAN (`http://<host>:3100`, no TLS terminator). A `Secure` cookie is
 * silently dropped by the browser over HTTP, so every API call 401s despite a
 * successful login. Set `COOKIE_SECURE=0` there. Force it on with `=1` behind an
 * HTTPS-terminating proxy the app process itself can't see.
 *
 * Tolerating `false`/`true` is deliberate: an installer or operator writing
 * `COOKIE_SECURE=false` — the natural boolean — used to be ignored (only `0`/`1`
 * were honoured), falling back to production=Secure and breaking HTTP login.
 * Observed on .39 twice (2026-05-25, then 2026-06-24 — same root cause).
 */
export function resolveCookieSecure(): boolean {
  const v = process.env.COOKIE_SECURE?.trim().toLowerCase();
  if (v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  return process.env.NODE_ENV === "production";
}

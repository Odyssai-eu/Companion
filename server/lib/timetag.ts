/**
 * Time-tag injection for LLM messages.
 *
 * Format: `[ISO_local | Δ: pretty]` (or just `[ISO_local]` when no prior).
 *
 * Why it matters: a stateless LLM has no notion of wall-clock time. Stamping
 * each user message with absolute time + a delta against the user's *global*
 * last interaction (across all conversations) lets the model reason about
 * gaps — "the user came back after 9h", "this is a rapid follow-up", etc.
 *
 * The tag is prepended to the user message content **at request time** only;
 * the database stores the user's raw text. See chat.ts.
 */

const PAD2 = (n: number) => String(n).padStart(2, "0");

/** Format a Date in the user's IANA timezone as ISO with offset:
 *    `2026-04-28T09:15:32+02:00`
 *
 *  We hand-build it because toLocaleString lacks an ISO-with-offset preset
 *  and Node's Intl.DateTimeFormat with timeZoneName="longOffset" returns
 *  "GMT+02:00" which we'd have to massage anyway. */
export function isoInTz(d: Date, tz: string): string {
  // Get the user-zone wall-clock components via Intl.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  let hh = get("hour");
  if (hh === "24") hh = "00"; // 24:00 quirk on some locales
  const mi = get("minute");
  const ss = get("second");

  // Compute the offset by reformatting twice (UTC vs target tz) and diffing
  // wall-clock minutes. Crude but accurate.
  const offsetMinutes = tzOffsetMinutes(d, tz);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const oh = PAD2(Math.floor(abs / 60));
  const om = PAD2(abs % 60);

  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${sign}${oh}:${om}`;
}

function tzOffsetMinutes(d: Date, tz: string): number {
  const fmt = (zone: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(d);

  const local = fmt(tz);
  const utc = fmt("UTC");
  const toMs = (parts: Intl.DateTimeFormatPart[]) => {
    const get = (t: string) =>
      Number(parts.find((p) => p.type === t)?.value ?? "0");
    let h = get("hour");
    if (h === 24) h = 0;
    return Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      h,
      get("minute"),
      get("second"),
    );
  };

  return Math.round((toMs(local) - toMs(utc)) / 60_000);
}

/** Pretty-format a millisecond delta as "1d3h", "2h17m", "45s", … */
export function prettyDelta(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;

  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;

  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return remM ? `${h}h${remM}m` : `${h}h`;

  const d = Math.floor(h / 24);
  const remH = h % 24;
  if (d < 7) return remH ? `${d}d${remH}h` : `${d}d`;

  const w = Math.floor(d / 7);
  const remD = d % 7;
  if (w < 4) return remD ? `${w}w${remD}d` : `${w}w`;

  const mo = Math.floor(d / 30);
  return `${mo}mo`;
}

export function buildTag(opts: {
  now: Date;
  previous: Date | null;
  timezone: string;
}): string {
  const iso = isoInTz(opts.now, opts.timezone);
  if (!opts.previous) return `[${iso}]`;
  const delta = prettyDelta(opts.now.getTime() - opts.previous.getTime());
  return `[${iso} | Δ: ${delta}]`;
}

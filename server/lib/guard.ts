/**
 * Confidential Guard — send-path classification hook.
 *
 * Before a user message leaves for the provider, the last user turn is
 * POSTed to the configured guard service (GLiNER2 PII sidecar), which
 * returns the sensitive categories it found (GDPR identifiers, health
 * data, financials, credentials, …). The chat handler uses the verdict
 * to (a) warn the user via an SSE `_event:"guard_warning"` frame and
 * (b) optionally force the turn onto the local engine instead of a
 * cloud provider.
 *
 * Fail-soft like the Parser hook: a guard service error must NEVER
 * block a chat turn — we log and return null (= no verdict, no action).
 */

import type { GuardAddonConfig } from "../routes/addon-guard";

export type GuardFinding = {
  category: string;
  severity: "low" | "medium" | "high";
  spans: string[];
};

export type GuardVerdict = {
  sensitive: boolean;
  maxSeverity: "none" | "low" | "medium" | "high";
  findings: GuardFinding[];
  ms: number;
  /** Set by the chat handler when the verdict triggered a local re-route. */
  forcedLocal?: boolean;
  /** Model the turn was re-routed to (when forcedLocal). */
  forcedModel?: string;
};

const GUARD_TIMEOUT_MS = 6_000;

/** Classify one user message against the guard service. Returns null on
 *  any failure (service down, timeout, bad payload) — fail-soft. */
export async function classifyText(
  text: string,
  cfg: Pick<GuardAddonConfig, "url" | "threshold">,
): Promise<GuardVerdict | null> {
  const t0 = Date.now();
  try {
    const res = await fetch(cfg.url as string, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        threshold: typeof cfg.threshold === "number" ? cfg.threshold : 0.5,
      }),
      signal: AbortSignal.timeout(GUARD_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[guard] service returned HTTP ${res.status} — skipping`);
      return null;
    }
    const body = (await res.json()) as {
      sensitive?: boolean;
      max_severity?: string;
      findings?: GuardFinding[];
    };
    if (typeof body.sensitive !== "boolean") return null;
    return {
      sensitive: body.sensitive,
      maxSeverity: (body.max_severity ?? "none") as GuardVerdict["maxSeverity"],
      findings: Array.isArray(body.findings) ? body.findings : [],
      ms: Date.now() - t0,
    };
  } catch (e) {
    console.warn(`[guard] classification failed: ${(e as Error).message} — skipping`);
    return null;
  }
}

/** Extract the plain text of the last user message (same shape handling
 *  as the auto-router pre-step in chat.ts). */
export function lastUserText(
  messages: Array<{ role: string; content: unknown }>,
): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return "";
  const content = lastUser.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : ((p as { text?: string }).text ?? "")))
      .join("\n");
  }
  return "";
}

/**
 * Admin memory healthcheck (#36, item 5) — "vérifier que ça marche".
 *
 * GET /api/admin/memory/health  (admin only)
 *
 * Probes each memory organ and reports up/down so the operator can see, at a
 * glance, which tier is silently absent instead of discovering it the hard way
 * (an empty injection that looks like "the model has no memory"). The organs
 * and their URL sources mirror server/lib/memory.ts exactly:
 *
 *   - nemo    — NEMO_MEMORY_URL  (env)           → GET  {url}/health
 *   - company — global_settings.company_rag_url  → GET  {url}/health
 *   - embed   — RAG_EMBED_URL    (env)           → GET  {url}/health
 *   - qdrant  — RAG_QDRANT_URL   (env)           → GET  {url}/healthz
 *   - karpathy— MEMORY_SERVICE_URL (env)         → GET  {url}/health
 *
 * Each probe is best-effort with a short timeout. The endpoint NEVER throws —
 * it always returns the full array. An unset URL is reported as
 * `ok:false, status:"not configured"` (distinct from a configured-but-down
 * organ, which reports the HTTP status or the fetch error string).
 */
import { Hono } from "hono";

import { getCompanyRagUrl } from "../lib/global-settings";
import { requireRole } from "../middleware/auth";

const adminMemoryHealthRoute = new Hono();
adminMemoryHealthRoute.use("*", requireRole("admin"));

// Match memory.ts: trailing slash stripped on nemo; the others read raw.
const NEMO_MEMORY_URL = (process.env.NEMO_MEMORY_URL || "").replace(/\/$/, "");
const RAG_EMBED_URL = process.env.RAG_EMBED_URL ?? "";
const RAG_QDRANT_URL = process.env.RAG_QDRANT_URL ?? "";
const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || "";

const PROBE_TIMEOUT_MS = Number(process.env.MEMORY_HEALTH_TIMEOUT_MS ?? 4000);

type OrganHealth = {
  organ: string;
  url: string;
  ok: boolean;
  status: string;
  latencyMs: number;
  detail: string;
};

/** Probe one organ's health URL. Never throws — encodes failure into the
 *  returned record. `path` is appended to `baseUrl` to form the probe target
 *  (e.g. "/health", "/healthz"). */
async function probe(
  organ: string,
  baseUrl: string,
  path: string,
): Promise<OrganHealth> {
  if (!baseUrl) {
    return {
      organ,
      url: "",
      ok: false,
      status: "not configured",
      latencyMs: 0,
      detail: "URL unset — this tier is disabled in this deployment.",
    };
  }
  // Join base + path defensively (avoid double slashes).
  const target = `${baseUrl.replace(/\/$/, "")}${path}`;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(target, { signal: ctrl.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - t0;
    return {
      organ,
      url: target,
      ok: res.ok,
      status: String(res.status),
      latencyMs,
      detail: res.ok ? "up" : `HTTP ${res.status} ${res.statusText}`.trim(),
    };
  } catch (err) {
    clearTimeout(timer);
    const latencyMs = Date.now() - t0;
    const message = (err as Error)?.message ?? String(err);
    return {
      organ,
      url: target,
      ok: false,
      status: "down",
      latencyMs,
      detail:
        (err as Error)?.name === "AbortError"
          ? `timeout after ${PROBE_TIMEOUT_MS}ms`
          : message,
    };
  }
}

adminMemoryHealthRoute.get("/", async (c) => {
  // Company URL is DB-backed (global_settings), not an env var.
  const companyUrl = await getCompanyRagUrl();

  // All probes in parallel — each is independently best-effort.
  const results = await Promise.all([
    probe("nemo", NEMO_MEMORY_URL, "/health"),
    probe("company", companyUrl, "/health"),
    probe("embed", RAG_EMBED_URL, "/health"),
    probe("qdrant", RAG_QDRANT_URL, "/healthz"),
    probe("karpathy", MEMORY_SERVICE_URL, "/health"),
  ]);

  return c.json(results);
});

export default adminMemoryHealthRoute;

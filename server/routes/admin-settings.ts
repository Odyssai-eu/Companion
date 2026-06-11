/**
 * Admin global settings — deployment-wide config (singleton row).
 *
 * GET   /api/admin/settings            read the global settings
 * PATCH /api/admin/settings            update them (admin only)
 *
 * Currently exposes `memoryBackend` ('lightrag' | 'wiki'): which memory
 * system feeds chat. Mutually exclusive — flipping it both switches the
 * read path (chat queries LightRAG vs the wiki) and idles the wiki-compile
 * scheduler when LightRAG is active.
 */
import { Hono } from "hono";

import {
  getCompanyRagUrl,
  getMemoryBackend,
  setCompanyRagUrl,
  setMemoryBackend,
  type MemoryBackend,
} from "../lib/global-settings";
import { isNemoAvailable } from "../lib/memory";
import { requireRole } from "../middleware/auth";

const adminSettingsRoute = new Hono();
adminSettingsRoute.use("*", requireRole("admin"));

adminSettingsRoute.get("/", async (c) => {
  return c.json({
    memoryBackend: await getMemoryBackend(),
    // Org-wide company LightRAG (:8766 by default). "" = company tier off.
    companyRagUrl: await getCompanyRagUrl(),
    // Surfaced so the UI can warn if 'lightrag' is selected but the service
    // isn't deployed (NEMO_MEMORY_URL unset) — chat would silently fall back.
    lightragDeployed: isNemoAvailable(),
  });
});

adminSettingsRoute.patch("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));

  if (body?.memoryBackend !== undefined) {
    const backend = body.memoryBackend as MemoryBackend;
    if (backend !== "lightrag" && backend !== "wiki") {
      return c.json({ error: "memoryBackend must be 'lightrag' or 'wiki'" }, 400);
    }
    await setMemoryBackend(backend);
  }

  if (body?.companyRagUrl !== undefined) {
    const url = String(body.companyRagUrl).trim();
    if (url && !/^https?:\/\//.test(url)) {
      return c.json({ error: "companyRagUrl must be an http(s) URL or empty" }, 400);
    }
    await setCompanyRagUrl(url);
  }

  return c.json({
    ok: true,
    memoryBackend: await getMemoryBackend(),
    companyRagUrl: await getCompanyRagUrl(),
  });
});

export default adminSettingsRoute;

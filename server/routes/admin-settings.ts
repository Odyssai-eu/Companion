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
  getMemoryBackend,
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
    // Surfaced so the UI can warn if 'lightrag' is selected but the service
    // isn't deployed (NEMO_MEMORY_URL unset) — chat would silently fall back.
    lightragDeployed: isNemoAvailable(),
  });
});

adminSettingsRoute.patch("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const backend = body?.memoryBackend as MemoryBackend | undefined;
  if (backend !== "lightrag" && backend !== "wiki") {
    return c.json(
      { error: "memoryBackend must be 'lightrag' or 'wiki'" },
      400,
    );
  }
  await setMemoryBackend(backend);
  return c.json({ ok: true, memoryBackend: backend });
});

export default adminSettingsRoute;

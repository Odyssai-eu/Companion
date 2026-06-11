/**
 * Admin global settings — deployment-wide config (singleton row).
 *
 * GET   /api/admin/settings            read the global settings
 * PATCH /api/admin/settings            update them (admin only)
 *
 * Memory is always RAG now (the wiki backend toggle was retired). The only
 * editable memory setting is the org-wide company LightRAG URL (:8766) —
 * user/team memory is the bundled nemo service, not a configurable link.
 */
import { Hono } from "hono";

import {
  getCompanyRagUrl,
  setCompanyRagUrl,
} from "../lib/global-settings";
import { isNemoAvailable } from "../lib/memory";
import { requireRole } from "../middleware/auth";

const adminSettingsRoute = new Hono();
adminSettingsRoute.use("*", requireRole("admin"));

adminSettingsRoute.get("/", async (c) => {
  return c.json({
    // Org-wide company LightRAG (:8766 by default). "" = company tier off.
    companyRagUrl: await getCompanyRagUrl(),
    // Whether the bundled nemo (user/team) is reachable at all (env-set).
    nemoDeployed: isNemoAvailable(),
  });
});

adminSettingsRoute.patch("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));

  if (body?.companyRagUrl !== undefined) {
    const url = String(body.companyRagUrl).trim();
    if (url && !/^https?:\/\//.test(url)) {
      return c.json({ error: "companyRagUrl must be an http(s) URL or empty" }, 400);
    }
    await setCompanyRagUrl(url);
  }

  return c.json({ ok: true, companyRagUrl: await getCompanyRagUrl() });
});

export default adminSettingsRoute;

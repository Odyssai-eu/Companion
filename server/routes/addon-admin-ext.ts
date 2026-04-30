/**
 * Admin Extended add-on — exposes the multi-user / multi-station admin panel
 * (users, nodes, groups, file syncs, guest tokens). The actual functionality
 * lives under `/api/admin/*` (admin-users, admin-nodes, admin-groups,
 * admin-sync, admin-guest-tokens). This route exists only so the Add-ons page
 * can lazy-create the row for users that predate the add-on.
 *
 *   GET /api/addons/admin-ext/info → { addonId, enabled }
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index";
import { addons } from "../db/schema";

type Env = { Variables: { userId: string } };
const adminExtRoute = new Hono<Env>();

const ADDON_NAME = "Admin Extended";
const ADDON_DESCRIPTION =
  "Manage users, nodes, groups, file syncs and guest tokens. " +
  "Required for multi-user / multi-station setups.";
const ADDON_VERSION = "0.1.0";

async function findOrInit(userId: string) {
  const [existing] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(addons)
    .values({
      userId,
      name: ADDON_NAME,
      kind: "plugin",
      description: ADDON_DESCRIPTION,
      version: ADDON_VERSION,
      enabled: false,
    })
    .returning();
  return created;
}

adminExtRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  return c.json({ addonId: addon.id, enabled: addon.enabled });
});

export default adminExtRoute;

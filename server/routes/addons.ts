/**
 * Add-ons CRUD — Settings → Add-ons.
 *
 *   GET    /api/addons                       → the caller's EFFECTIVE list
 *   POST   /api/addons                       → register an ad-hoc add-on
 *   PATCH  /api/addons/by-name/:name         → toggle / configure by identity
 *   PATCH  /api/addons/:id                   → same, addressed by row id
 *   DELETE /api/addons/by-name/:name/override→ drop my override, re-inherit
 *   DELETE /api/addons/:id                   → delete my own row
 *
 * SINCE 0060 A CARD IS NOT A ROW. An add-on the caller sees may come from
 * their own row, from the instance row every account inherits, or from
 * nothing at all (the catalogue entry, on a deployment where the operator
 * has not configured it yet). `resolveAddonsForUser` flattens the three
 * into one list with an `inherited` flag; see server/lib/instance-rows.ts.
 *
 * WRITES NEVER TOUCH AN INSTANCE ROW. Every mutation here goes through
 * `materializeUserAddon()`, which creates an EMPTY row for the caller the
 * first time they change anything and returns its id. Without that, a user
 * flipping a toggle on an inherited card would flip it for the whole
 * deployment — this router is behind `requireUser`, not `requireRole`, and
 * its only guard was ever "is this row mine". Instance rows are edited from
 * /api/admin/instance-addons.
 *
 * BY NAME, NOT BY ID, is the primary address. An inherited card has no row
 * of the caller's to point at, and a catalogue-only card has no row at all;
 * `name` is the identity in every other part of the system anyway (nine
 * `const ADDON_NAME`, the UI's panel switch, six data migrations). The
 * `/:id` form is kept because it is the pre-0060 API surface and the admin
 * account's own cards still resolve to a real id.
 */
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index";
import { addons } from "../db/schema";
import {
  dropUserAddonOverride,
  materializeUserAddon,
  pruneInheritedEchoes,
  publicAddonView,
  readOwnAddonConfig,
  resolveAddonForUser,
  resolveAddonsForUser,
} from "../lib/instance-rows";

type Env = { Variables: { userId: string } };
const addonsRoute = new Hono<Env>();

const createSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(["core", "plugin", "mcp"]).default("plugin"),
  description: z.string().max(500).optional(),
  version: z.string().max(40).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});

const updateSchema = z.object({
  description: z.string().max(500).nullish(),
  version: z.string().max(40).nullish(),
  // null = "drop my override and inherit the instance switch again".
  enabled: z.boolean().nullish(),
  config: z.record(z.unknown()).nullish(),
});

addonsRoute.get("/", async (c) => {
  const userId = c.get("userId");
  const rows = await resolveAddonsForUser(userId);
  return c.json({ addons: rows.map(publicAddonView) });
});

addonsRoute.post("/", zValidator("json", createSchema), async (c) => {
  const userId = c.get("userId");
  const data = c.req.valid("json");
  // An add-on the caller invents. It is their own row by construction, so
  // there is no instance to inherit from and no copy-on-write to do — but
  // it must not create a SECOND row for a name they already own, or the
  // resolver would silently pick one of the two.
  const existing = await resolveAddonForUser(userId, data.name);
  if (existing?.ownRowId) {
    return c.json({ error: "addon_exists" }, 409);
  }
  const [row] = await db
    .insert(addons)
    .values({
      userId,
      name: data.name,
      kind: data.kind,
      description: data.description,
      version: data.version,
      enabled: data.enabled ?? false,
      config: data.config,
    })
    .returning();
  const resolved = await resolveAddonForUser(userId, row.name);
  return c.json({ addon: resolved ? publicAddonView(resolved) : null }, 201);
});

/**
 * Apply a patch to the caller's OWN row for `name`, materialising it first
 * if they were inheriting. The single write path — both PATCH forms and
 * the toggle funnel through here.
 */
async function patchOwnAddon(
  userId: string,
  name: string,
  data: z.infer<typeof updateSchema>,
) {
  const ownId = await materializeUserAddon(userId, name);
  const patch: Partial<typeof addons.$inferInsert> = { updatedAt: new Date() };
  if (data.description !== undefined) patch.description = data.description ?? null;
  if (data.version !== undefined) patch.version = data.version ?? null;
  if (data.enabled !== undefined) patch.enabled = data.enabled ?? null;
  if (data.config !== undefined) {
    // A wholesale config replace from the generic PATCH is the same trap as
    // the per-add-on panels: the client posts back what it was shown, which
    // for an inheritor is the instance's own values. Keys that merely echo
    // the inherited value never become an override — see
    // pruneInheritedEchoes. `null` stays null: that is an explicit "drop my
    // override entirely", not an echo.
    const next = (data.config ?? null) as Record<string, unknown> | null;
    patch.config = next
      ? await pruneInheritedEchoes(
          name,
          await readOwnAddonConfig(userId, name),
          next,
        )
      : null;
  }
  await db.update(addons).set(patch).where(eq(addons.id, ownId));
  return resolveAddonForUser(userId, name);
}

addonsRoute.patch(
  "/by-name/:name",
  zValidator("json", updateSchema),
  async (c) => {
    const userId = c.get("userId");
    const name = decodeURIComponent(c.req.param("name"));
    const current = await resolveAddonForUser(userId, name);
    // Unknown to the catalogue AND absent from both row sets: there is
    // nothing to configure, and materialising would invent an add-on no
    // code knows how to render.
    if (!current) return c.json({ error: "not_found" }, 404);
    const updated = await patchOwnAddon(userId, name, c.req.valid("json"));
    return c.json({ addon: updated ? publicAddonView(updated) : null });
  },
);

addonsRoute.patch("/:id", zValidator("json", updateSchema), async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [existing] = await db
    .select({ userId: addons.userId, name: addons.name })
    .from(addons)
    .where(eq(addons.id, id))
    .limit(1);
  if (!existing) return c.json({ error: "not_found" }, 404);
  // Somebody else's personal row — 404 exactly as before 0060.
  if (existing.userId !== null && existing.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  // An instance row id reaches here whenever the caller patches an
  // inherited card. Copy-on-write: the patch lands on a row of their own,
  // never on the shared one.
  const updated = await patchOwnAddon(userId, existing.name, c.req.valid("json"));
  return c.json({ addon: updated ? publicAddonView(updated) : null });
});

/**
 * "Reset to instance settings", the add-on equivalent of
 * POST /api/inference/reset-to-instance. Deletes the caller's row so every
 * field goes back to following the instance — the row is only ever an
 * override, so removing it loses nothing that was not a deliberate
 * divergence.
 */
addonsRoute.delete("/by-name/:name/override", async (c) => {
  const userId = c.get("userId");
  const name = decodeURIComponent(c.req.param("name"));
  const dropped = await dropUserAddonOverride(userId, name);
  if (!dropped) return c.json({ error: "no_override" }, 404);
  const resolved = await resolveAddonForUser(userId, name);
  return c.json({ ok: true, addon: resolved ? publicAddonView(resolved) : null });
});

addonsRoute.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [existing] = await db
    .select({ userId: addons.userId, kind: addons.kind })
    .from(addons)
    .where(eq(addons.id, id))
    .limit(1);
  if (!existing) return c.json({ error: "not_found" }, 404);
  if (existing.userId === null) {
    // Deleting the instance row here would remove the add-on for every
    // account on the deployment, from a route any authenticated user can
    // reach. The override-drop above is what "remove this card" means for
    // a user; removing it for everyone is an admin action.
    return c.json({ error: "instance_row_readonly" }, 403);
  }
  if (existing.userId !== userId) return c.json({ error: "not_found" }, 404);
  if (existing.kind === "core") {
    return c.json({ error: "cannot_delete_core" }, 400);
  }
  await db.delete(addons).where(eq(addons.id, id));
  return c.body(null, 204);
});

export default addonsRoute;

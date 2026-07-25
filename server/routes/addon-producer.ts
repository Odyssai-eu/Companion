/**
 * Document Producer add-on. The mirror of the Parser: the Parser turns
 * attached files INTO markdown on the way IN (Docling); this turns the
 * model's reply INTO a real Office file on the way OUT (render service —
 * markdown -> .docx via pandoc, JSON spec -> .xlsx via openpyxl).
 *
 * The model emits a fenced block in its reply:
 *   <doc:docx name="rapport.docx">…markdown…</doc:docx>
 *   <doc:xlsx name="ca.xlsx">…JSON spec…</doc:xlsx>
 * The output hook (see ../lib/producer.ts) extracts each block, POSTs it to
 * the user's configured render service, and attaches the returned file.
 * Slides are NOT here — a deck is HTML via the frontend-slides path.
 *
 * Public-app rule: NO hardcoded infra URL. The render endpoint is per-user
 * config (empty until the user sets it in the add-on panel), exactly like the
 * Parser's Docling URL. See memory no-hardcoded-urls.
 *
 *   GET   /api/addons/producer/info    → status + config
 *   PUT   /api/addons/producer/config  → set url / enabled
 *   POST  /api/addons/producer/test    → ping the render service /health,
 *                                        return { ok, pandoc, ms }.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { addons } from "../db/schema";
import {
  materializeUserAddon,
  pruneInheritedEchoes,
  readOwnAddonConfig,
  resolveKnownAddon,
} from "../lib/instance-rows";

type Env = { Variables: { userId: string } };
const producerRoute = new Hono<Env>();

const ADDON_NAME = "Document Producer";

// No hardcoded infra URL — the render service base is config-driven (empty
// until the user configures it). A baked LAN IP breaks portability / client
// install. The base points at the render service root (e.g.
// http://<host>:8001/render); the hook appends /docx and /xlsx.
export const DEFAULT_PRODUCER_URL = "";

export type ProducerAddonConfig = {
  url?: string;
};

/** The add-on as this user sees it — own row over instance row, key by
 *  key. Replaces findOrInitProducerAddon(): resolution never writes, so a
 *  read can no longer materialise the empty row that shadows the
 *  instance. See server/lib/instance-rows.ts. */
async function loadProducerAddon(userId: string) {
  return resolveKnownAddon(userId, ADDON_NAME);
}

/** Loaded by the chat completion path (output hook) so the render URL is
 *  resolved per request. Returns null when the add-on is disabled or has no
 *  URL configured — mirrors loadParserConfigForUser. */
export async function loadProducerConfigForUser(
  userId: string,
): Promise<{ url: string; addonId: string | null } | null> {
  const row = await loadProducerAddon(userId);
  if (!row.enabled) return null;
  const cfg = row.config as ProducerAddonConfig;
  if (!cfg.url) return null; // enabled but unconfigured → no hardcoded fallback
  return { url: cfg.url.replace(/\/+$/, ""), addonId: row.id };
}

export async function isProducerEnabled(userId: string): Promise<boolean> {
  return Boolean(await loadProducerConfigForUser(userId));
}

producerRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await loadProducerAddon(userId);
  const cfg = addon.config as ProducerAddonConfig;
  const url = cfg.url || DEFAULT_PRODUCER_URL;
  return c.json({
    addonId: addon.id,
    inherited: addon.inherited,
    inheritedConfigKeys: addon.inheritedConfigKeys,
    enabled: addon.enabled,
    url,
    configured: Boolean(url),
  });
});

const configSchema = z.object({
  enabled: z.boolean().optional(),
  url: z.string().url().max(500).optional(),
});

producerRoute.put("/config", zValidator("json", configSchema), async (c) => {
  const userId = c.get("userId");
  const data = c.req.valid("json");
  // Copy-on-write + delta write — see the long note in addon-parser.ts:
  // the patch layers on the caller's OWN config so untouched keys keep
  // inheriting instead of being snapshotted.
  const ownId = await materializeUserAddon(userId, ADDON_NAME);
  const cfg = (await readOwnAddonConfig(userId, ADDON_NAME)) as ProducerAddonConfig;
  // Which keys were ALREADY the user's own, before this request touched
  // anything. pruneInheritedEchoes needs it to tell a real override from the
  // form echoing back a value it only displayed because it was inherited.
  const before = { ...cfg } as Record<string, unknown>;
  if (data.url !== undefined) cfg.url = data.url;
  const patch: {
    config: Record<string, unknown>;
    updatedAt: Date;
    enabled?: boolean;
  } = {
    config: await pruneInheritedEchoes(
      ADDON_NAME,
      before,
      cfg as unknown as Record<string, unknown>,
    ),
    updatedAt: new Date(),
  };
  if (typeof data.enabled === "boolean") patch.enabled = data.enabled;

  await db.update(addons).set(patch).where(eq(addons.id, ownId));
  const updated = await loadProducerAddon(userId);
  const out = updated.config as ProducerAddonConfig;
  return c.json({
    ok: true,
    enabled: updated.enabled,
    url: out.url || DEFAULT_PRODUCER_URL,
    configured: Boolean(out.url || DEFAULT_PRODUCER_URL),
  });
});

/** Ping the configured render service /health so the settings panel can
 *  verify connectivity (and whether pandoc is present for docx). */
producerRoute.post("/test", async (c) => {
  const userId = c.get("userId");
  const addon = await loadProducerAddon(userId);
  const cfg = addon.config as ProducerAddonConfig;
  const base = (cfg.url || DEFAULT_PRODUCER_URL).replace(/\/+$/, "");
  if (!base) return c.json({ ok: false, error: "not_configured" }, 400);

  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return c.json(
        { ok: false, status: res.status, error: detail.slice(0, 400) || `HTTP ${res.status}` },
        502,
      );
    }
    const body = (await res.json()) as { pandoc?: boolean; xlsx?: boolean };
    return c.json({
      ok: true,
      pandoc: Boolean(body.pandoc),
      xlsx: body.xlsx !== false,
      ms: Date.now() - t0,
    });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 502);
  }
});

export default producerRoute;

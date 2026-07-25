/**
 * Document Parser add-on. Parses attached documents
 * (PDF/DOCX/DOC/PPTX/XLSX/CSV/MD/HTML) into markdown via the Docling
 * service BEFORE the message reaches the model, so text-only models
 * (MiniMax) can read them. The parse hook runs server-side in
 * assembleMessages (see ../lib/parser.ts) — this add-on only stores the
 * connection details + on/off switch, same shape as addon-comfyui.ts.
 *
 *   GET   /api/addons/parser/info    → status + config
 *   PUT   /api/addons/parser/config  → set url / pdfMode / enabled
 *   POST  /api/addons/parser/test    → forward a multipart file to Docling,
 *                                       return { ok, chars, pages, ms } so the
 *                                       panel can verify connectivity.
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
const parserRoute = new Hono<Env>();

const ADDON_NAME = "Parser";

// No hardcoded infra URL. The Docling endpoint is config-driven — the user
// sets it in the add-on panel (empty until configured). See memory
// no-hardcoded-urls: a baked LAN IP breaks portability / client install.
export const DEFAULT_PARSER_URL = "";
export const DEFAULT_MAX_UPLOAD_BYTES = 20_000_000;

export type ParserAddonConfig = {
  url?: string;
  pdfMode?: "text" | "vision";
  maxUploadBytes?: number;
};

/**
 * The add-on as this user sees it: their own row on top of the instance
 * row, key by key.
 *
 * Replaces the old `findOrInitParserAddon()`, which INSERTED an empty row
 * on the first /info ping. That write was the direct cause of the bug 0060
 * fixes — six rows with an empty `config` on the second account, "enabled"
 * with no URL behind them — and under inheritance it would be fatal rather
 * than merely useless: an empty own row shadows the instance and the
 * add-on could never inherit anything. Resolution writes nothing; the
 * user's row is created only when they actually save something.
 */
async function loadParserAddon(userId: string) {
  return resolveKnownAddon(userId, ADDON_NAME);
}

/** Loaded by the chat send path (assembleMessages → parser hook) so the
 *  Docling URL + mode are resolved per request, not at module import.
 *  Returns null when the add-on is disabled — mirrors
 *  loadComfyuiConfigForUser. */
export async function loadParserConfigForUser(
  userId: string,
): Promise<
  | (Required<Pick<ParserAddonConfig, "url" | "pdfMode" | "maxUploadBytes">> & {
      addonId: string | null;
    })
  | null
> {
  const row = await loadParserAddon(userId);
  if (!row.enabled) return null;
  const cfg = row.config as ParserAddonConfig;
  // Enabled but no Docling URL configured → treat as not configured so the
  // send-path skips parsing (no hardcoded fallback).
  if (!cfg.url) return null;
  return {
    url: cfg.url,
    pdfMode: cfg.pdfMode === "vision" ? "vision" : "text",
    maxUploadBytes:
      typeof cfg.maxUploadBytes === "number" && cfg.maxUploadBytes > 0
        ? cfg.maxUploadBytes
        : DEFAULT_MAX_UPLOAD_BYTES,
    addonId: row.id,
  };
}

export async function isParserEnabled(userId: string): Promise<boolean> {
  return Boolean(await loadParserConfigForUser(userId));
}

parserRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await loadParserAddon(userId);
  const cfg = addon.config as ParserAddonConfig;
  const url = cfg.url || DEFAULT_PARSER_URL;
  return c.json({
    addonId: addon.id,
    inherited: addon.inherited,
    inheritedConfigKeys: addon.inheritedConfigKeys,
    enabled: addon.enabled,
    url,
    pdfMode: cfg.pdfMode === "vision" ? "vision" : "text",
    maxUploadBytes:
      typeof cfg.maxUploadBytes === "number" && cfg.maxUploadBytes > 0
        ? cfg.maxUploadBytes
        : DEFAULT_MAX_UPLOAD_BYTES,
    configured: Boolean(url),
  });
});

const configSchema = z.object({
  enabled: z.boolean().optional(),
  url: z.string().url().max(500).optional(),
  pdfMode: z.enum(["text", "vision"]).optional(),
  maxUploadBytes: z.number().int().positive().max(200_000_000).optional(),
});

parserRoute.put("/config", zValidator("json", configSchema), async (c) => {
  const userId = c.get("userId");
  const data = c.req.valid("json");
  // Copy-on-write, then a DELTA write.
  //
  // The patch is layered on the caller's OWN config, never on the resolved
  // one. This handler (like all eight of its siblings) rewrites `config`
  // wholesale, so building it from the merged object would freeze the
  // instance's values into the user's row the first time they save — the
  // snapshot 0059 rejected, arriving sideways. Starting from the own
  // config means an untouched key stays absent and keeps inheriting.
  const ownId = await materializeUserAddon(userId, ADDON_NAME);
  const cfg = (await readOwnAddonConfig(userId, ADDON_NAME)) as ParserAddonConfig;
  // Which keys were ALREADY the user's own, before this request touched
  // anything. pruneInheritedEchoes needs it to tell a real override from the
  // form echoing back a value it only displayed because it was inherited.
  const before = { ...cfg } as Record<string, unknown>;
  if (data.url !== undefined) cfg.url = data.url;
  if (data.pdfMode !== undefined) cfg.pdfMode = data.pdfMode;
  if (data.maxUploadBytes !== undefined) cfg.maxUploadBytes = data.maxUploadBytes;
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
  const updated = await loadParserAddon(userId);
  const out = updated.config as ParserAddonConfig;
  return c.json({
    ok: true,
    enabled: updated.enabled,
    url: out.url || DEFAULT_PARSER_URL,
    pdfMode: out.pdfMode === "vision" ? "vision" : "text",
    maxUploadBytes:
      typeof out.maxUploadBytes === "number" && out.maxUploadBytes > 0
        ? out.maxUploadBytes
        : DEFAULT_MAX_UPLOAD_BYTES,
    configured: Boolean(out.url || DEFAULT_PARSER_URL),
  });
});

/** Upload a small file and forward it to the configured Docling endpoint.
 *  Lets the settings panel verify connectivity end-to-end without going
 *  through the chat path. */
parserRoute.post("/test", async (c) => {
  const userId = c.get("userId");
  const addon = await loadParserAddon(userId);
  const cfg = addon.config as ParserAddonConfig;
  const url = cfg.url || DEFAULT_PARSER_URL;

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ ok: false, error: "invalid_multipart" }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ ok: false, error: "no_file" }, 400);
  }

  const t0 = Date.now();
  try {
    const out = new FormData();
    out.append("file", file, file.name || "upload");
    const res = await fetch(url, {
      method: "POST",
      body: out,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return c.json(
        {
          ok: false,
          status: res.status,
          error: detail.slice(0, 400) || `HTTP ${res.status}`,
        },
        502,
      );
    }
    const body = (await res.json()) as {
      markdown?: string;
      pages?: number;
      elapsed_ms?: number;
    };
    return c.json({
      ok: true,
      chars: (body.markdown ?? "").length,
      pages: body.pages ?? 0,
      ms: body.elapsed_ms ?? Date.now() - t0,
    });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 502);
  }
});

export default parserRoute;

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

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { addons } from "../db/schema";

type Env = { Variables: { userId: string } };
const parserRoute = new Hono<Env>();

const ADDON_NAME = "Parser";

export const DEFAULT_PARSER_URL = "http://192.168.86.44:8083/parse";
export const DEFAULT_MAX_UPLOAD_BYTES = 20_000_000;

export type ParserAddonConfig = {
  url?: string;
  pdfMode?: "text" | "vision";
  maxUploadBytes?: number;
};

export async function findOrInitParserAddon(userId: string) {
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
      description:
        "Parse attached documents (PDF, DOCX, PPTX, XLSX, CSV, MD, HTML) " +
        "into markdown via the Docling service before the message is sent, " +
        "so text-only models can read them. Points Companion at your Docling " +
        "endpoint.",
      version: "0.1.0",
      enabled: false,
    })
    .returning();
  return created;
}

/** Loaded by the chat send path (assembleMessages → parser hook) so the
 *  Docling URL + mode are resolved per request, not at module import.
 *  Returns null when the add-on is disabled — mirrors
 *  loadComfyuiConfigForUser. */
export async function loadParserConfigForUser(
  userId: string,
): Promise<
  | (Required<Pick<ParserAddonConfig, "url" | "pdfMode" | "maxUploadBytes">> & {
      addonId: string;
    })
  | null
> {
  const [row] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (!row || !row.enabled) return null;
  const cfg = (row.config ?? {}) as ParserAddonConfig;
  return {
    url: cfg.url || DEFAULT_PARSER_URL,
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
  const addon = await findOrInitParserAddon(userId);
  const cfg = (addon.config ?? {}) as ParserAddonConfig;
  const url = cfg.url || DEFAULT_PARSER_URL;
  return c.json({
    addonId: addon.id,
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
  const addon = await findOrInitParserAddon(userId);
  const cfg = { ...((addon.config ?? {}) as ParserAddonConfig) };
  if (data.url !== undefined) cfg.url = data.url;
  if (data.pdfMode !== undefined) cfg.pdfMode = data.pdfMode;
  if (data.maxUploadBytes !== undefined) cfg.maxUploadBytes = data.maxUploadBytes;
  const patch: {
    config: Record<string, unknown>;
    updatedAt: Date;
    enabled?: boolean;
  } = {
    config: cfg as unknown as Record<string, unknown>,
    updatedAt: new Date(),
  };
  if (typeof data.enabled === "boolean") patch.enabled = data.enabled;

  const [updated] = await db
    .update(addons)
    .set(patch)
    .where(eq(addons.id, addon.id))
    .returning();
  const out = (updated.config ?? {}) as ParserAddonConfig;
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
  const addon = await findOrInitParserAddon(userId);
  const cfg = (addon.config ?? {}) as ParserAddonConfig;
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

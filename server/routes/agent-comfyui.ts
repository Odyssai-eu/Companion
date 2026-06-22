/**
 * ComfyUI agent invocation. Forward bridge calls (OdyssAI-Imager) to the
 * client, with a thin translation layer so the front-end doesn't need to
 * speak the bridge's native shapes.
 *
 * Routes:
 *   GET  /api/agents/comfyui/templates
 *     → proxies the bridge GET /v1/templates, exposes slug + description +
 *       model + declared inputs. Falls back to a static list if the bridge
 *       is unreachable so the modal still renders.
 *
 *   POST /api/agents/comfyui/slash
 *     body: { template, prompt, width?, height?, steps?, seed?, cfg?,
 *             negative_prompt?, conversationId }
 *     → submits to the bridge POST /v1/templates/{slug}/run (fire-and-forget),
 *       then polls GET /v1/status/{prompt_id} until the bridge reports
 *       completion, fetches each image from the ComfyUI compute host
 *       (/view), base64-encodes them, and returns them inline. The browser
 *       can't reach the compute host directly so URL-only wouldn't render.
 *
 * Why polling and not SSE:
 *   - The new templates route is fire-and-forget on purpose. The bridge
 *     returns a prompt_id immediately and exposes the result via
 *     /v1/status/{prompt_id} polling. Holding an SSE stream open across
 *     a multi-minute generation just to stay consistent with the legacy
 *     /v1/generate shape is wasted complexity now that the modal is the
 *     sole caller.
 *
 * Why a relay and not a client-direct call:
 *   - The bridge and compute host may sit behind a private network the
 *     browser can't reach.
 *   - The bearer token (IMAGER_BRIDGE_TOKEN) stays server-side; the
 *     browser never sees it.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { loadComfyuiConfigForUser } from "./addon-comfyui";

type Env = { Variables: { userId: string } };
const comfyuiAgentRoute = new Hono<Env>();

// Static fallback used when the bridge is unreachable on first paint.
// Mirrors the templates shipped today (see Imager/registry/inputs_map.yaml).
// `defaults` matches the workflow's baked values — UI opens with the
// intended aspect ratio instead of a generic 1024x1024 placeholder.
const FALLBACK_TEMPLATES = [
  "flux1-schnell-t2i-v1",
  "flux1-dev-t2i-v1",
  "photo-article-tmb",
  "image-z-image-turbo",
  "image-rapide",
];

// Cinemascope 21:9 across the board (per the inputs_map.yaml descriptions).
// Kept in sync by hand; the live bridge response wins when it's up.
const FALLBACK_DEFAULTS: Record<string, Record<string, number>> = {
  "flux1-schnell-t2i-v1": { width: 1664, height: 928, steps: 4 },
  "flux1-dev-t2i-v1": { width: 1664, height: 928, steps: 20 },
  "photo-article-tmb": { width: 1664, height: 928, steps: 20 },
  "image-z-image-turbo": { width: 1664, height: 928, steps: 5 },
  "image-rapide": { width: 1664, height: 928, steps: 12 },
};

type BridgeTemplate = {
  slug: string;
  description?: string;
  model?: string;
  inputs: string[];
  defaults?: Record<string, number>;
};

type BridgeTemplatesResponse = {
  templates: BridgeTemplate[];
  service?: string;
  version?: string;
};

async function fetchBridgeTemplates(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<BridgeTemplatesResponse | null> {
  try {
    const r = await fetch(baseUrl + "/v1/templates", {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as BridgeTemplatesResponse;
    if (!Array.isArray(data.templates)) return null;
    return data;
  } catch {
    return null;
  }
}

// ── Templates list ────────────────────────────────────────────────────────

comfyuiAgentRoute.get("/templates", async (c) => {
  const userId = c.get("userId");
  const cfg = await loadComfyuiConfigForUser(userId).catch(() => null);

  // Not configured → return the static fallback so the modal renders.
  // (The modal will let the user pick but error on submit.)
  if (!cfg?.bridgeUrl) {
    return c.json({
      templates: FALLBACK_TEMPLATES.map((slug) => ({
        slug,
        description: null,
        model: null,
        inputs: ["prompt", "width", "height", "steps"],
        defaults: FALLBACK_DEFAULTS[slug] ?? {
          width: 1024,
          height: 1024,
          steps: 20,
        },
      })),
      source: "fallback",
    });
  }

  const baseUrl = cfg.bridgeUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (cfg.bridgeToken) headers.Authorization = `Bearer ${cfg.bridgeToken}`;

  const live = await fetchBridgeTemplates(baseUrl, headers);
  if (live) {
    return c.json({ ...live, source: "bridge" });
  }

  // Bridge unreachable → fallback list. The modal will surface the error
  // on submit anyway, but at least the dropdown is populated.
  return c.json({
    templates: FALLBACK_TEMPLATES.map((slug) => ({
      slug,
      description: null,
      model: null,
      inputs: ["prompt", "width", "height", "steps"],
    })),
    source: "fallback",
  });
});

// ── Slash helper ──────────────────────────────────────────────────────────
//
// Drains the new polling contract (POST /v1/templates/{slug}/run +
// poll GET /v1/status/{prompt_id}) and returns the same JSON shape the
// modal expects: { prompt_id, duration_s, images[], transcript_tail[] }.

const slashSchema = z.object({
  conversationId: z.string().uuid(),
  template: z.string().min(1).max(80),
  prompt: z.string().min(1).max(8000),
  negative_prompt: z.string().max(4000).optional(),
  width: z.number().int().min(64).max(4096).optional(),
  height: z.number().int().min(64).max(4096).optional(),
  steps: z.number().int().min(1).max(200).optional(),
  cfg: z.number().min(0).max(100).optional(),
  seed: z.number().int().min(0).optional(),
});

type ImageAttachment = {
  filename: string;
  mime: string;
  dataBase64: string;
};

type TranscriptEntry = { event: string; data: unknown };

// How long to poll before giving up. Matches the bridge's own 6min
// timeout and the legacy /v1/generate ceiling.
const POLL_TIMEOUT_MS = 6 * 60 * 1000;
const POLL_INTERVAL_MS = 3_000;

comfyuiAgentRoute.post(
  "/slash",
  zValidator("json", slashSchema),
  async (c) => {
    const userId = c.get("userId");
    const body = c.req.valid("json");

    const cfg = await loadComfyuiConfigForUser(userId);
    if (!cfg) {
      return c.json(
        {
          error: "comfyui_not_configured",
          detail:
            "The ComfyUI Imager add-on is not enabled or no bridge URL is " +
            "set. Open Settings → Add-ons → ComfyUI Imager to configure it.",
        },
        400,
      );
    }
    if (!cfg.bridgeUrl) {
      return c.json(
        {
          error: "comfyui_not_configured",
          detail:
            "The ComfyUI Imager add-on has no bridge URL configured. " +
            "Open Settings → Add-ons → ComfyUI Imager to set it.",
        },
        400,
      );
    }

    const baseUrl = cfg.bridgeUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (cfg.bridgeToken) headers.Authorization = `Bearer ${cfg.bridgeToken}`;

    // The new run route only accepts prompt + (width, height, steps).
    // Knobs the workflow doesn't expose (cfg, seed, negative_prompt,
    // batch) stay client-side; the workflow keeps its baked values.
    const runBody: Record<string, unknown> = { prompt: body.prompt };
    if (body.width !== undefined) runBody.width = body.width;
    if (body.height !== undefined) runBody.height = body.height;
    if (body.steps !== undefined) runBody.steps = body.steps;

    // ── 1. Submit (fire-and-forget) ────────────────────────────────────
    const t0 = Date.now();
    let promptId: string;
    let model: string | undefined;
    try {
      const r = await fetch(
        `${baseUrl}/v1/templates/${encodeURIComponent(body.template)}/run`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(runBody),
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        return c.json(
          {
            error: "comfyui_bridge_error",
            status: r.status,
            detail: txt.slice(0, 500),
          },
          502,
        );
      }
      const submitJson = (await r.json()) as {
        prompt_id?: string;
        model?: string;
      };
      if (!submitJson.prompt_id) {
        return c.json(
          { error: "comfyui_bridge_error", detail: "no prompt_id returned" },
          502,
        );
      }
      promptId = submitJson.prompt_id;
      model = submitJson.model;
    } catch (e) {
      return c.json(
        { error: "comfyui_unreachable", detail: (e as Error).message },
        502,
      );
    }

    // ── 2. Poll /v1/status/{prompt_id} ─────────────────────────────────
    const transcript: TranscriptEntry[] = [
      {
        event: "submitted",
        data: { prompt_id: promptId, template: body.template, model },
      },
    ];

    type StatusResponse = {
      prompt_id: string;
      status: string;
      completed?: boolean;
      images?: Record<string, Array<Record<string, unknown>>>;
    };

    let finalStatus: StatusResponse | null = null;
    const deadline = t0 + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      try {
        const r = await fetch(`${baseUrl}/v1/status/${promptId}`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        if (!r.ok) continue; // transient; keep polling
        const status = (await r.json()) as StatusResponse;
        transcript.push({ event: "status", data: status });
        if (status.status === "error") {
          return c.json(
            {
              error: "comfyui_error",
              detail: `generation failed for prompt ${promptId}`,
              transcript,
            },
            502,
          );
        }
        if (status.status === "done") {
          finalStatus = status;
          break;
        }
      } catch {
        // Network blip; keep polling until the deadline.
      }
    }

    if (!finalStatus) {
      return c.json(
        {
          error: "comfyui_timeout",
          detail: `polling /v1/status/${promptId} hit ${POLL_TIMEOUT_MS}ms ceiling`,
          prompt_id: promptId,
          transcript,
        },
        504,
      );
    }

    // ── 3. Collect images ──────────────────────────────────────────────
    //
    // `images` is keyed by node id. The bridge returns the raw ComfyUI
    // history shape: each value is `{ images: [{filename, subfolder,
    // type}, ...] }` for the modern output schema. Older workflows (and
    // some custom nodes) return the array directly instead. Handle both
    // so we don't lock the parser to one bridge version.
    const flat: Array<{
      filename: string;
      subfolder?: string;
      type?: string;
    }> = [];
    for (const nodeOutputs of Object.values(finalStatus.images ?? {})) {
      let candidates: unknown[] | null = null;
      if (Array.isArray(nodeOutputs)) {
        candidates = nodeOutputs;
      } else if (
        nodeOutputs &&
        typeof nodeOutputs === "object" &&
        Array.isArray((nodeOutputs as { images?: unknown }).images)
      ) {
        candidates = (nodeOutputs as { images: unknown[] }).images;
      }
      if (!candidates) continue;
      for (const out of candidates) {
        if (out && typeof out === "object" && typeof (out as { filename?: unknown }).filename === "string") {
          const o = out as { filename: string; subfolder?: unknown; type?: unknown };
          flat.push({
            filename: o.filename,
            subfolder: typeof o.subfolder === "string" ? o.subfolder : "",
            type: typeof o.type === "string" ? o.type : "output",
          });
        }
      }
    }

    if (flat.length === 0) {
      return c.json(
        {
          error: "no_images_returned",
          detail: "bridge reported done but no image filenames in outputs",
          prompt_id: promptId,
          transcript,
        },
        502,
      );
    }

    // ── 4. Fetch each image via the bridge's /v1/image proxy ─────────
    //
    // The bridge exposes /v1/image/{filename}?subfolder=&type= which
    // proxies ComfyUI's /view on the compute host. The browser can't
    // reach the compute host directly (private network), and even from
    // the Companion server the host:port of ComfyUI is a separate
    // detail we don't need to know — the bridge knows it.
    const images: ImageAttachment[] = [];
    for (const img of flat) {
      const params = new URLSearchParams({
        type: img.type ?? "output",
      });
      if (img.subfolder) params.set("subfolder", img.subfolder);
      const imageUrl = `${baseUrl}/v1/image/${encodeURIComponent(img.filename)}?${params.toString()}`;
      try {
        const r = await fetch(imageUrl, {
          headers: { Accept: "image/*" },
          signal: AbortSignal.timeout(60_000),
        });
        if (!r.ok) continue;
        const mime = r.headers.get("content-type") || "image/png";
        const buf = Buffer.from(await r.arrayBuffer());
        images.push({
          filename: img.filename,
          mime,
          dataBase64: buf.toString("base64"),
        });
      } catch {
        // Skip; modal will see a shorter attachment list.
      }
    }

    if (images.length === 0) {
      return c.json(
        {
          error: "image_fetch_failed",
          detail: "bridge reported done but all /view fetches failed",
          prompt_id: promptId,
          transcript,
        },
        502,
      );
    }

    return c.json({
      prompt_id: promptId,
      duration_s: Math.round((Date.now() - t0) / 100) / 10,
      // Echo the bridge URL + template slug so the modal can persist a
      // self-contained attachment reference per message. Without this
      // the bridge URL would have to be re-resolved from the add-on
      // config at render time, and changing the configured bridge
      // later would silently break old messages.
      bridge_url: baseUrl,
      template: body.template,
      images,
      transcript_tail: transcript.slice(-5),
    });
  },
);

export default comfyuiAgentRoute;

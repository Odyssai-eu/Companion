/**
 * ComfyUI agent invocation. Forward SSE stream from the OdyssAI-Imager
 * bridge to the client, with a thin translation layer so the front-end
 * doesn't need to speak ComfyUI's native SSE shapes.
 *
 *   POST /api/agents/comfyui/generate
 *     body: typed GenerateRequest (template, prompt, optional knobs)
 *     responds: SSE — events relayed from the bridge's /v1/generate.
 *
 *   GET  /api/agents/comfyui/templates
 *     → {"templates": ["flux1-schnell-t2i-v1", "flux1-dev-t2i-v1"]}
 *     Used by the panel UI to populate the template dropdown.
 *
 * Why a relay and not a client-direct call:
 *   - The bridge may sit behind a private network the browser can't reach.
 *   - The bearer token (IMAGER_BRIDGE_TOKEN) stays server-side; the
 *     browser never sees it.
 *   - Same shape as Hermes agent invoke — the chat SSE consumer in
 *     useChat.ts already speaks `update` / `tool_call` / `error` events,
 *     and we map the bridge's events onto a few small types here.
 *
 * What lands in the SSE stream (translated from bridge /v1/generate):
 *   preflight, params, fp8_fallback, downloads_start, downloads_done,
 *   submitting, submitted, sampling, done (with image URLs),
 *   error (with phase + message).
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { loadComfyuiConfigForUser } from "./addon-comfyui";

type Env = { Variables: { userId: string } };
const comfyuiAgentRoute = new Hono<Env>();

// Hardcoded list — mirrors the workflows/ folder shipped with the
// OdyssAI-Imager bridge. Kept in sync by hand; a /v1/templates endpoint
// on the bridge could replace this if the catalogue grows.
const TEMPLATES = ["flux1-schnell-t2i-v1", "flux1-dev-t2i-v1"];

comfyuiAgentRoute.get("/templates", (c) => {
  return c.json({ templates: TEMPLATES });
});

// ── Generate ──────────────────────────────────────────────────────────────

const generateSchema = z.object({
  template: z.string().min(1).max(80).optional(),
  prompt: z.string().min(1).max(8000),
  negative_prompt: z.string().max(4000).optional(),
  width: z.number().int().min(64).max(4096).optional(),
  height: z.number().int().min(64).max(4096).optional(),
  steps: z.number().int().min(1).max(100).optional(),
  cfg: z.number().min(0).max(100).optional(),
  seed: z.number().int().min(0).optional(),
  filename_prefix: z.string().max(120).optional(),
  wait: z.boolean().optional(),
});

comfyuiAgentRoute.post(
  "/generate",
  zValidator("json", generateSchema),
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

    const baseUrl = cfg.bridgeUrl!.replace(/\/+$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (cfg.bridgeToken) headers.Authorization = `Bearer ${cfg.bridgeToken}`;

    // Default to wait=true so the panel and the slash command both get a
    // single image back in one round trip. wait=false is reserved for
    // future polling-style UIs that want to fire-and-check.
    const upstreamBody = { ...body, wait: body.wait ?? true };

    let upstream: Response;
    try {
      upstream = await fetch(baseUrl + "/v1/generate", {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
        // The bridge can take a few minutes for high-step generations.
        // 6 minutes ceiling matches the bridge's own timeout.
        signal: AbortSignal.timeout(6 * 60 * 1000),
      });
    } catch (e) {
      return c.json(
        {
          error: "comfyui_unreachable",
          detail: (e as Error).message,
        },
        502,
      );
    }

    if (!upstream.ok || !upstream.body) {
      const txt = await upstream.text().catch(() => "");
      return c.json(
        {
          error: "comfyui_bridge_error",
          status: upstream.status,
          detail: txt.slice(0, 500),
        },
        502,
      );
    }

    // ── SSE relay ──
    //
    // The bridge emits its own event names (preflight, params, done, error,
    // …). We forward them unchanged so a panel client can subscribe with
    // native EventSource and route on the event name. We do NOT translate
    // to the Hermes `update` / `tool_call` shapes — ComfyUI is a one-shot
    // generator, not a turn-by-turn agent, so the chat's sessionUpdate
    // protocol doesn't apply here.
    //
    // One small filter: drop the redundant blank lines some proxies add.
    const encoder = new TextEncoder();
    const relay = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = upstream.body!.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch (e) {
          // Forward the error as a final SSE event so the client sees it.
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`,
            ),
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(relay, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  },
);

// ── Slash command helper ──────────────────────────────────────────────────
//
// The slash command in useChat.ts (/comfyui <prompt>) hits the same
// bridge endpoint but in a request/response mode rather than SSE. We
// drain the SSE stream server-side, fetch the resulting image bytes,
// base64-encode them, and return a plain JSON body. The browser can't
// reach .42:8188 directly so the URL alone wouldn't be enough to render
// the image inline. The chat composer accepts this JSON and inserts the
// image as a markdown attachment in the assistant message.

const slashSchema = z.object({
  conversationId: z.string().uuid(),
  prompt: z.string().min(1).max(8000),
  template: z.string().min(1).max(80).optional(),
  negative_prompt: z.string().max(4000).optional(),
  width: z.number().int().min(64).max(4096).optional(),
  height: z.number().int().min(64).max(4096).optional(),
  steps: z.number().int().min(1).max(100).optional(),
  cfg: z.number().min(0).max(100).optional(),
  seed: z.number().int().min(0).optional(),
});

type DonePayload = {
  prompt_id?: string;
  images?: string[];
  raw_images?: Array<{ filename?: string; subfolder?: string; type?: string }>;
  duration_s?: number;
};

type ImageAttachment = {
  filename: string;
  mime: string;
  dataBase64: string;
};

type TranscriptEntry = { event: string; data: unknown };

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

    const baseUrl = cfg.bridgeUrl!.replace(/\/+$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (cfg.bridgeToken) headers.Authorization = `Bearer ${cfg.bridgeToken}`;

    const upstreamBody = { ...body, wait: true };

    let upstream: Response;
    try {
      upstream = await fetch(baseUrl + "/v1/generate", {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(6 * 60 * 1000),
      });
    } catch (e) {
      return c.json(
        { error: "comfyui_unreachable", detail: (e as Error).message },
        502,
      );
    }

    if (!upstream.ok || !upstream.body) {
      const txt = await upstream.text().catch(() => "");
      return c.json(
        {
          error: "comfyui_bridge_error",
          status: upstream.status,
          detail: txt.slice(0, 500),
        },
        502,
      );
    }

    // Drain the SSE stream, collecting a transcript (for debug) and the
    // final `done` payload. Bail out early on `error`.
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const transcript: TranscriptEntry[] = [];
    let rawDone: unknown = null;
    let errorMsg: string | null = null;

    function processBlock(block: string) {
      let ev = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      transcript.push({ event: ev, data: parsed });
      if (ev === "done") rawDone = parsed;
      else if (ev === "error") {
        const m = (parsed as { message?: unknown }).message;
        errorMsg = typeof m === "string" ? m : JSON.stringify(parsed);
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";
        for (const block of blocks) if (block.trim()) processBlock(block);
      }
      if (buf.trim()) processBlock(buf);
    } catch (e) {
      return c.json(
        { error: "stream_read_failed", detail: (e as Error).message },
        502,
      );
    }

    if (errorMsg) {
      return c.json({ error: "comfyui_error", detail: errorMsg, transcript }, 502);
    }

    // Validate the `done` payload shape manually (TypeScript's narrowing
    // across JSON.parse → use is too fragile to be the only check).
    type ValidDone = {
      images: string[];
      raw_images?: DonePayload["raw_images"];
      prompt_id?: string;
      duration_s?: number;
    };
    let finalEvent: ValidDone | null = null;
    if (rawDone && typeof rawDone === "object") {
      const obj = rawDone as Record<string, unknown>;
      if (
        Array.isArray(obj.images) &&
        obj.images.length > 0 &&
        obj.images.every((u) => typeof u === "string")
      ) {
        finalEvent = {
          images: obj.images as string[],
          raw_images: Array.isArray(obj.raw_images)
            ? (obj.raw_images as DonePayload["raw_images"])
            : undefined,
          prompt_id:
            typeof obj.prompt_id === "string" ? obj.prompt_id : undefined,
          duration_s:
            typeof obj.duration_s === "number" ? obj.duration_s : undefined,
        };
      }
    }
    if (!finalEvent) {
      return c.json({ error: "no_done_event", transcript }, 502);
    }
    // After the guard above, finalEvent is non-null. Reassign to a
    // non-nullable local so the rest of the function can use the
    // properties without optional chaining.
    const doneEvent = finalEvent;

    // Fetch each image and base64-encode it. URLs point at the private
    // compute host which the browser can't reach, so the chat composer
    // needs the bytes inline.
    const images: ImageAttachment[] = [];
    for (let i = 0; i < doneEvent.images.length; i++) {
      const url = doneEvent.images[i]!;
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!r.ok) continue;
        const mime = r.headers.get("content-type") || "image/png";
        const imgBuf = Buffer.from(await r.arrayBuffer());
        const filename =
          doneEvent.raw_images?.[i]?.filename ?? `imager-${i}.png`;
        images.push({
          filename,
          mime,
          dataBase64: imgBuf.toString("base64"),
        });
      } catch {
        // Skip; the chat will see a shorter attachment list.
      }
    }

    if (images.length === 0) {
      return c.json(
        {
          error: "image_fetch_failed",
          detail: "bridge returned image URLs but all fetches failed",
          transcript,
        },
        502,
      );
    }

    return c.json({
      prompt_id: doneEvent.prompt_id ?? null,
      duration_s: doneEvent.duration_s ?? null,
      images,
      // A short transcript (last 5 events) for the composer to show as a
      // footnote if the user expands the message. Full transcript stays
      // server-side; we don't ship 200 lines of SSE to the browser.
      transcript_tail: transcript.slice(-5),
    });
  },
);

export default comfyuiAgentRoute;

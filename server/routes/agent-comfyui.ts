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

export default comfyuiAgentRoute;

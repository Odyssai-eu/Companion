import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index";
import { endpoints, servers } from "../db/schema";
import { buildBase } from "../lib/url";
import { handleAnthropicChat } from "./chat-anthropic";

const chatRoute = new Hono();

chatRoute.post("/completions", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_json" }, 400);
  }
  const {
    serverId,
    messages,
    model,
    temperature,
    max_tokens,
    top_p,
    top_k,
    min_p,
    repetition_penalty,
    seed,
    thinking,
    reasoning_effort,
    system_prompt,
  } = body as {
    serverId?: string;
    messages?: unknown;
    model?: string;
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    top_k?: number;
    min_p?: number;
    repetition_penalty?: number;
    seed?: number;
    thinking?: boolean;
    reasoning_effort?: string;
    system_prompt?: string;
  };
  if (!serverId || !Array.isArray(messages) || messages.length === 0) {
    return c.json({ error: "missing_serverId_or_messages" }, 400);
  }

  const userId = c.get("userId");
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!server || server.userId !== userId) {
    return c.json({ error: "server_not_found" }, 404);
  }
  const eps = await db
    .select()
    .from(endpoints)
    .where(eq(endpoints.serverId, serverId))
    .orderBy(asc(endpoints.createdAt));
  const primary = eps.find((e) => e.role === "primary") ?? eps[0];
  if (!primary) {
    return c.json({ error: "no_endpoint" }, 400);
  }

  const base = buildBase(primary.ip, primary.port);

  // Prepend system prompt if provided (OpenAI format; Anthropic handler
  // extracts it into its native field).
  const withSystem =
    system_prompt && system_prompt.trim().length > 0
      ? [
          { role: "system", content: system_prompt.trim() },
          ...(messages as { role: string; content: string }[]),
        ]
      : (messages as { role: "user" | "assistant" | "system"; content: string }[]);

  // Resolve model (either user-picked, or ask upstream what's loaded)
  let resolvedModel = model && model !== "auto" ? model : undefined;
  if (!resolvedModel) {
    const authHeaders: Record<string, string> = {};
    if (server.authBearer)
      authHeaders.Authorization = `Bearer ${server.authBearer}`;
    resolvedModel = await pickLoadedModel(base, authHeaders);
  }
  if (!resolvedModel) {
    return c.json(
      {
        error: "no_model",
        detail:
          "Engine didn't report any loaded model. Load one on the server, then retry.",
      },
      400,
    );
  }

  if (server.engineKind === "anthropic") {
    return handleAnthropicChat(c, {
      base,
      authBearer: server.authBearer,
      model: resolvedModel,
      messages: withSystem as Parameters<typeof handleAnthropicChat>[1]["messages"],
      temperature,
      max_tokens,
    });
  }

  // OpenAI-compat path (exo, Ollama, LM Studio, vLLM, OpenRouter)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (server.authBearer) {
    headers.Authorization = `Bearer ${server.authBearer}`;
    // OpenRouter asks attribution headers on each call
    headers["HTTP-Referer"] = "https://dev.thecomp.ai";
    headers["X-Title"] = "Thecomp.ai";
  }

  const upstreamBody: Record<string, unknown> = {
    model: resolvedModel,
    messages: withSystem,
    stream: true,
  };
  if (temperature !== undefined) upstreamBody.temperature = temperature;
  if (max_tokens !== undefined) upstreamBody.max_tokens = max_tokens;
  if (top_p !== undefined) upstreamBody.top_p = top_p;
  if (top_k !== undefined) upstreamBody.top_k = top_k;
  if (min_p !== undefined) upstreamBody.min_p = min_p;
  if (repetition_penalty !== undefined)
    upstreamBody.repetition_penalty = repetition_penalty;
  if (seed !== undefined) upstreamBody.seed = seed;
  if (thinking) upstreamBody.enable_thinking = true;
  if (thinking && reasoning_effort)
    upstreamBody.reasoning_effort = reasoning_effort;

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
    });
  } catch (err) {
    return c.json(
      { error: "upstream_unreachable", detail: String(err) },
      502,
    );
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return c.json(
      { error: "upstream_error", status: upstream.status, body: text },
      upstream.status as 400 | 401 | 403 | 404 | 500 | 502,
    );
  }

  c.header(
    "Content-Type",
    upstream.headers.get("content-type") ?? "text/event-stream",
  );
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");
  return c.body(upstream.body);
});

/**
 * Find a model that is actually loaded and ready to serve — not just known.
 *
 * - exo's `/state` lists placed instances under `instances.*.MlxJacclInstance
 *   .shardAssignments.modelId`. We prefer this because `/v1/models` there
 *   returns *every registered* model, including ones that aren't placed, and
 *   chatting against one returns 404 "No instance found for model".
 * - For Ollama / OpenRouter / Anthropic, `/v1/models` lists served models
 *   accurately, so we fall back to its first entry.
 */
async function pickLoadedModel(
  base: string,
  headers: Record<string, string>,
): Promise<string | undefined> {
  // Try exo /state first.
  try {
    const res = await fetch(`${base}/state`, { headers });
    if (res.ok) {
      const state = (await res.json()) as {
        instances?: Record<
          string,
          {
            MlxJacclInstance?: {
              shardAssignments?: { modelId?: string };
            };
          }
        >;
      };
      const placed = Object.values(state.instances ?? {})
        .map((i) => i.MlxJacclInstance?.shardAssignments?.modelId)
        .filter((m): m is string => typeof m === "string" && m.length > 0);
      if (placed.length > 0) return placed[0];
    }
  } catch {
    // ignore — not an exo server
  }

  // Fall back to OpenAI-style /v1/models.
  try {
    const res = await fetch(`${base}/v1/models`, { headers });
    if (res.ok) {
      const body = (await res.json()) as {
        data?: { id?: string }[];
      };
      return body.data?.[0]?.id;
    }
  } catch {
    // ignore
  }

  return undefined;
}

export default chatRoute;

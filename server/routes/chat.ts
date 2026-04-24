import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index";
import { endpoints, servers, users } from "../db/schema";

const chatRoute = new Hono();

async function currentUserId() {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (!row) throw new Error("No user seeded yet");
  return row.id;
}

chatRoute.post("/completions", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_json" }, 400);
  }
  const { serverId, messages, model, temperature, max_tokens } = body as {
    serverId?: string;
    messages?: unknown;
    model?: string;
    temperature?: number;
    max_tokens?: number;
  };
  if (!serverId || !Array.isArray(messages) || messages.length === 0) {
    return c.json({ error: "missing_serverId_or_messages" }, 400);
  }

  const userId = await currentUserId();
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

  const base = `http://${primary.ip}:${primary.port}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (server.authBearer) {
    headers.Authorization = `Bearer ${server.authBearer}`;
  }

  // Anthropic uses a different wire protocol (messages API with content blocks
  // and a distinct SSE event stream). Until we wire a translator, surface a
  // clear error instead of silently 404'ing.
  if (server.engineKind === "anthropic") {
    return c.json(
      {
        error: "engine_not_yet_supported",
        detail:
          "Anthropic passthrough is coming in the next release. Use an OpenAI-compatible server for now.",
      },
      501,
    );
  }

  let resolvedModel = model;
  if (!resolvedModel || resolvedModel === "auto") {
    resolvedModel = await pickLoadedModel(base, headers);
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

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: resolvedModel,
        messages,
        stream: true,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(max_tokens !== undefined ? { max_tokens } : {}),
      }),
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

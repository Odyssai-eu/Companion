/**
 * Omnigent add-on — bidirectional bridge client. Points Companion at a
 * `thecompai-omnigent-bridge` (FastAPI) that drives one or more autonomous
 * Omnigent agents. Unlike Hermes / Pi (one-way: Companion drives the agent),
 * Omnigent is "deux sens":
 *
 *   DOWN  Companion → bridge: the chat model calls the `omnigent_*` tools
 *         (see server/lib/tools.ts). Each tool POSTs to the bridge `/run`,
 *         consumes the bridge SSE to completion server-side, and returns a
 *         consolidated tool result to the chat loop.
 *   UP    bridge → Companion: while a session runs, the Omnigent agent can
 *         call back into Companion's OWN tools. The bridge POSTs to
 *         `/api/addons/omnigent/tool-callback` with the per-session
 *         `callback_token`; we authenticate it, run `executeTool` in that
 *         user's context, and return `{result}`.
 *
 *   GET   /api/addons/omnigent/info           → status + config
 *   PUT   /api/addons/omnigent/config         → set serverUrl, apiKey, …
 *   PATCH /api/addons/omnigent/config         → alias of PUT (same handler)
 *   POST  /api/addons/omnigent/probe          → curl the bridge /health
 *   POST  /api/addons/omnigent/run            → start a session, stream SSE
 *                                               (HTTP surface of the down path)
 *   GET   /api/addons/omnigent/sessions/:id   → session status pass-through
 *   POST  /api/addons/omnigent/tool-callback  → REVERSE channel (no cookie;
 *                                               bearer = per-session token)
 *
 * Config jsonb on the addons row:
 *   { serverUrl, apiKey, defaultAgent, enabledAgents[], enabledTools[] }
 *   enabledTools = which Companion tools the agent may call back into.
 *
 * No dedicated DB migration: this reuses the `addons` jsonb (like Hermes /
 * Pi). The per-session callback-token map is process-local in-memory — a
 * freshly-minted token whose lifetime is exactly the run, so it never needs
 * to outlive the process or be shared across replicas (single-node dev).
 */

import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { addons } from "../db/schema";
import { executeTool, resolveExposableTools } from "../lib/tools";

type Env = { Variables: { userId: string } };
const omnigentRoute = new Hono<Env>();

const ADDON_NAME = "Omnigent";

export type OmnigentAddonConfig = {
  serverUrl?: string;
  apiKey?: string;
  defaultAgent?: string;
  enabledAgents?: string[];
  /** Companion tool names the agent is allowed to call back into. */
  enabledTools?: string[];
};

// ── Live-session callback-token registry (process-local) ────────────────────
//
// When a down-path run starts we mint a random callback_token, hand it to the
// bridge, and remember which (userId, bridge session) it authorises. The
// reverse channel authenticates by looking the token up here. Entries are
// dropped when the run's SSE closes (finally block in runOmnigentSession).
//
// Provisional, flag for reconciliation: the bridge contract says the reverse
// POST carries `bridge_session_id`; we don't *require* it to match (the token
// alone authorises + scopes to the user), but we record it for observability
// and so a future tightening can assert token↔session binding.

type CallbackSession = {
  userId: string;
  /** Tool names the agent may call back into (config.enabledTools). */
  enabledTools: Set<string>;
  bridgeSessionId?: string;
  createdAt: number;
};

const callbackSessions = new Map<string, CallbackSession>();

/** Drop callback tokens older than this even if a run never cleaned up
 *  (defensive against a dropped SSE that skipped the finally block). */
const CALLBACK_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 h

function sweepExpiredCallbackTokens() {
  const cutoff = Date.now() - CALLBACK_TOKEN_TTL_MS;
  for (const [token, sess] of callbackSessions) {
    if (sess.createdAt < cutoff) callbackSessions.delete(token);
  }
}

// ── Config load / init ──────────────────────────────────────────────────────

export async function findOrInitOmnigentAddon(userId: string) {
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
        "Delegate to autonomous Omnigent agents from chat. The model can " +
        "call omnigent_run / omnigent_orchestrate to hand a task to one or " +
        "more agents on the thecompai-omnigent-bridge, and the agent can " +
        "call back into Companion's own tools (bidirectional). Configure " +
        "the bridge URL, key, agents, and which tools to expose below.",
      version: "0.1.0",
      enabled: false,
    })
    .returning();
  return created;
}

/** Loaded by the omnigent_* tools (and the internal run path) to know where
 *  to send tasks and what the agent may call back into. Returns null when the
 *  add-on is off or unconfigured — callers surface a "not configured" error. */
export async function loadOmnigentConfigForUser(
  userId: string,
): Promise<(OmnigentAddonConfig & { addonId: string }) | null> {
  const [row] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (!row || !row.enabled) return null;
  const cfg = (row.config ?? {}) as OmnigentAddonConfig;
  if (!cfg.serverUrl) return null;
  return { ...cfg, addonId: row.id };
}

// ── Down path: run a session against the bridge ─────────────────────────────

export type OmnigentRunInput = {
  task: string;
  /** Agent profile to dispatch. The bridge builds the bundle from this and
   *  knows only `polly` | `debby` | `custom` (bundle.py KNOWN_AGENTS). `polly`
   *  IS the multi-agent orchestrator with cross-vendor review — there is no
   *  separate orchestrate flag on the bridge, intent is encoded purely via the
   *  agent profile. Omit to fall back to the configured default / `custom`. */
  agent?: string;
};

/** SSE event re-emitted up to a caller that wants to stream
 *  (the HTTP POST /run surface). The tool path ignores `onEvent` and just
 *  consumes to completion for a consolidated result. */
export type OmnigentBridgeEvent =
  | { kind: "tool_start"; [k: string]: unknown }
  | { kind: "tool_done"; [k: string]: unknown }
  | { kind: "approval"; [k: string]: unknown }
  | { kind: "status"; [k: string]: unknown }
  | { kind: "text"; text: string }
  | { kind: string; [k: string]: unknown };

export type OmnigentRunResult = {
  ok: boolean;
  sessionId: string | null;
  /** Concatenated `text` events — the agent's natural-language output. */
  text: string;
  /** Compact digest of the tool_start/tool_done/approval/status events the
   *  bridge emitted, so the chat model (and the UI) can see what happened
   *  inside the agent run without a live sub-stream. */
  events: Array<Record<string, unknown>>;
  status: string | null;
  error?: string;
};

/** Resolve Companion's own callback URL. The bridge calls this back. Prefer an
 *  explicit override (COMPANION_PUBLIC_URL / PUBLIC_BASE_URL) so the bridge —
 *  which runs on a different host — reaches us by something other than
 *  localhost. Falls back to the request origin when available. */
function resolveCallbackUrl(originHint?: string): string {
  const base =
    process.env.COMPANION_PUBLIC_URL ||
    process.env.PUBLIC_BASE_URL ||
    originHint ||
    "";
  const trimmed = base.replace(/\/+$/, "");
  return trimmed + "/api/addons/omnigent/tool-callback";
}

/**
 * Start an Omnigent session and consume its SSE stream to completion.
 *
 * In-process (not over HTTP) so the down path keeps the authenticated userId
 * without round-tripping a cookie back to ourselves. The HTTP POST /run route
 * is a thin wrapper over this for the documented bridge contract / manual use.
 *
 * @param onEvent optional sink; when provided, every bridge event is forwarded
 *                live (used by the streaming HTTP surface). The tool path omits
 *                it and reads the consolidated OmnigentRunResult instead.
 */
export async function runOmnigentSession(
  userId: string,
  input: OmnigentRunInput,
  opts?: { originHint?: string; onEvent?: (ev: OmnigentBridgeEvent) => void },
): Promise<OmnigentRunResult> {
  const cfg = await loadOmnigentConfigForUser(userId);
  if (!cfg) {
    return {
      ok: false,
      sessionId: null,
      text: "",
      events: [],
      status: null,
      error:
        "The Omnigent add-on is not enabled or no bridge URL is set. " +
        "Configure it in Settings → Add-ons → Omnigent.",
    };
  }

  const base = cfg.serverUrl!.replace(/\/+$/, "");
  // Agent profile resolution — the bridge knows only polly|debby|custom and
  // builds the bundle from it. Fall back to the configured default, then to
  // "custom" (the bridge's generic single-agent escape hatch) so the addon,
  // not the bridge's settings.default_agent, decides the default.
  const agent = input.agent || cfg.defaultAgent || "custom";

  // Resolve the user's enabledTools → the {name, description, parameters_schema}
  // shape the bridge expects, so the agent knows what it may call back into.
  const enabledToolNames = cfg.enabledTools ?? [];
  const enabledTools = await resolveExposableTools(userId, enabledToolNames);

  // Mint a per-session callback token and register it BEFORE the run so a
  // very-early reverse call can authenticate.
  sweepExpiredCallbackTokens();
  const callbackToken = "omcb_" + randomBytes(24).toString("hex");
  const callbackUrl = resolveCallbackUrl(opts?.originHint);
  callbackSessions.set(callbackToken, {
    userId,
    enabledTools: new Set(enabledToolNames),
    createdAt: Date.now(),
  });

  let sessionId: string | null = null;
  try {
    // 1. POST /run → { session_id }
    const runRes = await fetch(base + "/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        agent,
        task: input.task,
        companion_callback_url: enabledTools.length ? callbackUrl : undefined,
        enabled_tools: enabledTools.length ? enabledTools : undefined,
        callback_token: enabledTools.length ? callbackToken : undefined,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!runRes.ok) {
      const detail = await runRes.text().catch(() => "");
      callbackSessions.delete(callbackToken);
      return {
        ok: false,
        sessionId: null,
        text: "",
        events: [],
        status: null,
        error: `bridge /run failed: HTTP ${runRes.status} ${detail.slice(0, 300)}`,
      };
    }
    const runBody = (await runRes.json().catch(() => ({}))) as {
      session_id?: string;
    };
    sessionId = runBody.session_id ?? null;
    if (!sessionId) {
      callbackSessions.delete(callbackToken);
      return {
        ok: false,
        sessionId: null,
        text: "",
        events: [],
        status: null,
        error: "bridge /run returned no session_id",
      };
    }
    // Bind the token to the session now that we know it (observability +
    // future tightening of token↔session).
    const sess = callbackSessions.get(callbackToken);
    if (sess) sess.bridgeSessionId = sessionId;

    // 2. Consume GET /sessions/{id}/stream to completion.
    const collected = await consumeBridgeStream(
      base,
      sessionId,
      cfg.apiKey,
      opts?.onEvent,
    );
    return {
      ok: collected.status !== "error",
      sessionId,
      text: collected.text,
      events: collected.events,
      status: collected.status,
      error: collected.error,
    };
  } catch (e) {
    return {
      ok: false,
      sessionId,
      text: "",
      events: [],
      status: null,
      error: (e as Error).message,
    };
  } finally {
    callbackSessions.delete(callbackToken);
  }
}

/** Read the bridge SSE stream for a session until it closes, accumulating the
 *  agent's text and a digest of structured events. Each SSE `data:` line is a
 *  `{kind, ...}` object per the bridge contract. */
async function consumeBridgeStream(
  base: string,
  sessionId: string,
  apiKey: string | undefined,
  onEvent?: (ev: OmnigentBridgeEvent) => void,
): Promise<{
  text: string;
  events: Array<Record<string, unknown>>;
  status: string | null;
  error?: string;
}> {
  const url = base + `/sessions/${encodeURIComponent(sessionId)}/stream`;
  const upstream = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => "");
    return {
      text: "",
      events: [],
      status: "error",
      error: `bridge stream failed: HTTP ${upstream.status} ${txt.slice(0, 200)}`,
    };
  }

  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  let buffer = "";
  let text = "";
  let status: string | null = null;
  let error: string | undefined;
  const events: Array<Record<string, unknown>> = [];

  function handleEvent(ev: Record<string, unknown>) {
    const kind = String(ev.kind ?? "");
    onEvent?.(ev as OmnigentBridgeEvent);
    if (kind === "text") {
      const t = typeof ev.text === "string" ? ev.text : "";
      text += t;
      return;
    }
    if (kind === "status") {
      if (typeof ev.status === "string") status = ev.status;
      if (ev.status === "error" || ev.error) {
        error = String(ev.error ?? ev.reason ?? "agent error");
      }
      // status events are useful in the digest too
      events.push(ev);
      return;
    }
    // tool_start / tool_done / approval / anything else → digest, capped so a
    // chatty agent can't blow up the next prompt round-trip.
    if (events.length < 200) events.push(ev);
  }

  function processBlock(block: string) {
    let data = "";
    for (const line of block.split("\n")) {
      // The bridge contract puts the whole `{kind,...}` object in `data:`.
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data || data === "[DONE]") return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    handleEvent(parsed);
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        if (block.trim()) processBlock(block);
      }
    }
    if (buffer.trim()) processBlock(buffer);
  } catch (e) {
    error = error ?? (e as Error).message;
    status = status ?? "error";
  }

  return { text, events, status, error };
}

/** GET /sessions/{id} pass-through, used by the omnigent_status tool. */
export async function getOmnigentSessionStatus(
  userId: string,
  sessionId: string,
): Promise<ToolStatusResult> {
  const cfg = await loadOmnigentConfigForUser(userId);
  if (!cfg) {
    return { ok: false, error: "omnigent_not_configured" };
  }
  const url =
    cfg.serverUrl!.replace(/\/+$/, "") +
    `/sessions/${encodeURIComponent(sessionId)}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { ok: false, error: `bridge status HTTP ${res.status}` };
    }
    return { ok: true, status: await res.json() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

type ToolStatusResult =
  | { ok: true; status: unknown }
  | { ok: false; error: string };

// ── Routes ──────────────────────────────────────────────────────────────────

omnigentRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInitOmnigentAddon(userId);
  const cfg = (addon.config ?? {}) as OmnigentAddonConfig;
  return c.json({
    addonId: addon.id,
    enabled: addon.enabled,
    configured: Boolean(cfg.serverUrl),
    serverUrl: cfg.serverUrl ?? "",
    defaultAgent: cfg.defaultAgent ?? "",
    enabledAgents: cfg.enabledAgents ?? [],
    enabledTools: cfg.enabledTools ?? [],
    hasApiKey: Boolean(cfg.apiKey),
  });
});

const configSchema = z.object({
  enabled: z.boolean().optional(),
  serverUrl: z.string().url().max(300).optional(),
  apiKey: z.string().max(500).nullish(),
  defaultAgent: z.string().max(120).nullish(),
  enabledAgents: z.array(z.string().max(120)).max(64).optional(),
  enabledTools: z.array(z.string().max(120)).max(128).optional(),
});

/** Shared config-write logic. Kept as a plain (userId, data) → payload
 *  function so both the PUT and PATCH handlers can reuse it without fighting
 *  Hono's per-route generic inference on a shared Context-typed handler. */
async function applyOmnigentConfig(
  userId: string,
  data: z.infer<typeof configSchema>,
) {
  const addon = await findOrInitOmnigentAddon(userId);
  const cfg = { ...((addon.config ?? {}) as OmnigentAddonConfig) };
  if (data.serverUrl !== undefined) cfg.serverUrl = data.serverUrl;
  if (data.apiKey !== undefined) cfg.apiKey = data.apiKey ?? undefined;
  if (data.defaultAgent !== undefined) {
    cfg.defaultAgent = data.defaultAgent ?? undefined;
  }
  if (data.enabledAgents !== undefined) cfg.enabledAgents = data.enabledAgents;
  if (data.enabledTools !== undefined) cfg.enabledTools = data.enabledTools;

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
  const out = (updated.config ?? {}) as OmnigentAddonConfig;
  return {
    ok: true as const,
    enabled: updated.enabled,
    configured: Boolean(out.serverUrl),
    serverUrl: out.serverUrl ?? "",
    defaultAgent: out.defaultAgent ?? "",
    enabledAgents: out.enabledAgents ?? [],
    enabledTools: out.enabledTools ?? [],
    hasApiKey: Boolean(out.apiKey),
  };
}

// PUT is what the shared BridgeAddonPanel-style client calls; PATCH is the
// alias requested by the add-on contract. Same body for both.
omnigentRoute.put("/config", zValidator("json", configSchema), async (c) => {
  const userId = c.get("userId");
  return c.json(await applyOmnigentConfig(userId, c.req.valid("json")));
});
omnigentRoute.patch("/config", zValidator("json", configSchema), async (c) => {
  const userId = c.get("userId");
  return c.json(await applyOmnigentConfig(userId, c.req.valid("json")));
});

omnigentRoute.post("/probe", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInitOmnigentAddon(userId);
  const cfg = (addon.config ?? {}) as OmnigentAddonConfig;
  if (!cfg.serverUrl) {
    return c.json({ error: "not_configured" }, 400);
  }
  const url = cfg.serverUrl.replace(/\/+$/, "") + "/health";
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return c.json({ ok: false, status: res.status }, 502);
    }
    const body = await res.json().catch(() => ({}));
    return c.json({ ok: true, health: body });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 502);
  }
});

// ── Down path (HTTP surface) ────────────────────────────────────────────────
//
// POST /run streams the bridge SSE back to the caller as Companion SSE,
// re-emitting each bridge `{kind,...}` event verbatim under `event: omnigent`.
// The omnigent_* tools do NOT use this HTTP route — they call
// runOmnigentSession() in-process (keeps userId, returns a consolidated
// result the chat tool loop renders). This route exists for the documented
// bridge contract and manual/debug use.

const runSchema = z.object({
  task: z.string().min(1).max(50_000),
  agent: z.string().max(120).optional(),
});

omnigentRoute.post("/run", zValidator("json", runSchema), async (c) => {
  const userId = c.get("userId");
  const input = c.req.valid("json");
  const cfg = await loadOmnigentConfigForUser(userId);
  if (!cfg) {
    return c.json(
      {
        error: "omnigent_not_configured",
        detail:
          "The Omnigent add-on is not enabled or no bridge URL is set. " +
          "Open Settings → Add-ons → Omnigent to configure it.",
      },
      400,
    );
  }

  const originHint = originFromRequest(c.req.url, c.req.header("host"));
  const encoder = new TextEncoder();
  const sse = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const result = await runOmnigentSession(userId, input, {
          originHint,
          onEvent: (ev) => {
            try {
              controller.enqueue(sse("omnigent", ev));
            } catch {
              /* controller closed */
            }
          },
        });
        controller.enqueue(sse("done", result));
      } catch (e) {
        controller.enqueue(sse("error", { message: (e as Error).message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
});

omnigentRoute.get("/sessions/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const r = await getOmnigentSessionStatus(userId, id);
  if (!r.ok) return c.json({ error: r.error }, 502);
  return c.json(r.status);
});

// ── UP path: reverse tool-callback ──────────────────────────────────────────
//
// The bridge calls this while a session runs so the Omnigent agent can use
// Companion's own tools. Authenticated by the per-session callback_token
// (NOT a user cookie). This lives on a SEPARATE Hono app (omnigentPublicRoute)
// mounted BEFORE requireUser in server/index.ts, so the cookie gate never
// blocks the bridge. We resolve the token → (userId, allowed tools), enforce
// the allow-list, run executeTool, and return { result }. Errors come back as
// a structured result (never a 500) so the agent gets a usable signal.

export const omnigentPublicRoute = new Hono();

const callbackSchema = z.object({
  bridge_session_id: z.string().max(200).optional(),
  tool: z.string().min(1).max(200),
  arguments: z.record(z.unknown()).optional(),
  call_id: z.string().max(200).optional(),
});

omnigentPublicRoute.post(
  "/tool-callback",
  zValidator("json", callbackSchema),
  async (c) => {
    const auth = c.req.header("authorization") ?? c.req.header("Authorization");
    const token = auth?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) {
      return c.json({ error: "missing_bearer" }, 401);
    }
    sweepExpiredCallbackTokens();
    const sess = callbackSessions.get(token);
    if (!sess) {
      // Unknown / expired token: 401 so the bridge knows it's an auth issue,
      // not a tool-level failure.
      return c.json({ error: "invalid_callback_token" }, 401);
    }

    const { tool, arguments: args, bridge_session_id, call_id } =
      c.req.valid("json");

    // Defence in depth: only tools the user explicitly exposed may be called.
    // Same unwrapped error shape the bridge stringifies into the agent output.
    if (sess.enabledTools.size > 0 && !sess.enabledTools.has(tool)) {
      return c.json({
        result: {
          error: `tool '${tool}' is not in this session's allow-list`,
        },
      });
    }

    // Observability: note a mismatch but don't hard-fail on it (the contract
    // is provisional — token alone authorises).
    if (
      bridge_session_id &&
      sess.bridgeSessionId &&
      bridge_session_id !== sess.bridgeSessionId
    ) {
      console.warn(
        `[omnigent] callback session mismatch: token bound to ${sess.bridgeSessionId}, got ${bridge_session_id}`,
      );
    }

    try {
      const outcome = await executeTool(
        tool,
        (args ?? {}) as Record<string, unknown>,
        sess.userId,
      );
      // The bridge stringifies whatever we put in `result` straight into the
      // agent's function_call_output.output (client_tools.py:226-237). So we
      // UNWRAP executeTool's {ok,data}|{ok,error} envelope: on success the
      // agent sees the tool's actual `data`, on failure a clean {error}.
      // Returning the raw envelope would make the agent read a confusing
      // stringified {"ok":true,"data":…} blob.
      const result = outcome.ok ? outcome.data : { error: outcome.error };
      return c.json({ result, call_id });
    } catch (e) {
      // Never 500 — hand the agent a usable error (unwrapped, as above).
      return c.json({
        result: { error: (e as Error).message },
        call_id,
      });
    }
  },
);

/** Best-effort origin (scheme://host) from the incoming request, used as the
 *  callback-URL fallback when no COMPANION_PUBLIC_URL env is set. */
function originFromRequest(
  reqUrl: string,
  hostHeader?: string,
): string | undefined {
  try {
    const u = new URL(reqUrl);
    return `${u.protocol}//${hostHeader ?? u.host}`;
  } catch {
    return hostHeader ? `http://${hostHeader}` : undefined;
  }
}

export default omnigentRoute;

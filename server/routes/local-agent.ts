/**
 * companion-local agent bridge.
 *
 * Allows a user's local machine (Mac, Linux) to extend Companion with
 * local tool execution: bash commands, filesystem access — without touching
 * the server's Docker container.
 *
 * Protocol (HTTP, no WebSocket required):
 *
 *   1. companion-local connects:
 *      GET /api/local-agent/events?token=hms_...
 *      → SSE stream. Server sends tool execution requests as JSON events.
 *      → Keep-alive pings every 15s.
 *
 *   2. companion-local returns a result:
 *      POST /api/local-agent/result
 *      Body: {requestId: string, ok: boolean, data?: unknown, error?: string}
 *      → Used by executeTool to resolve the pending Promise.
 *
 *   3. Companion routes a tool call to local agent:
 *      (internal) localAgentExecute(userId, tool, args) → Promise<ToolResult>
 *      → Sends SSE event to connected agent, waits up to 30s for result.
 *
 * Auth: hms_* agents token (same as MCP/Hermes). The token carries userId.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "../db/index";
import { hermesTokens } from "../db/schema";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";

export const localAgentRoute = new Hono();

// ── In-memory state ────────────────────────────────────────────────────────

type PendingRequest = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  resolve: (result: { ok: boolean; data?: unknown; error?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
};

type AgentSession = {
  userId: string;
  sendEvent: (id: string, tool: string, args: Record<string, unknown>, cwd?: string | null) => void;
  pending: Map<string, PendingRequest>;
  connectedAt: Date;
};

/** Active local agent sessions, keyed by userId. One session per user. */
const sessions = new Map<string, AgentSession>();

/** Resolve a token to its userId. Returns null on invalid/expired token. */
async function resolveToken(raw: string): Promise<string | null> {
  if (!raw.startsWith("hms_")) return null;
  const hash = createHash("sha256").update(raw).digest("hex");
  const [row] = await db
    .select({ userId: hermesTokens.userId, revokedAt: hermesTokens.revokedAt })
    .from(hermesTokens)
    .where(eq(hermesTokens.tokenHash, hash))
    .limit(1);
  if (!row) return null;
  if (row.revokedAt) return null;
  return row.userId;
}

// ── GET /api/local-agent/events ────────────────────────────────────────────

localAgentRoute.get("/events", async (c) => {
  const token =
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
    c.req.query("token") ??
    "";
  const userId = await resolveToken(token);
  if (!userId) {
    return c.json({ error: "invalid or missing token (use hms_* agents token)" }, 401);
  }

  // Close any existing session for this user
  const existing = sessions.get(userId);
  if (existing) {
    sessions.delete(userId);
  }

  return streamSSE(c, async (stream) => {
    const pending = new Map<string, PendingRequest>();

    const sendEvent = (id: string, tool: string, args: Record<string, unknown>, cwd?: string | null) => {
      void stream.writeSSE({
        event: "tool_execute",
        data: JSON.stringify({ requestId: id, tool, args, cwd: cwd ?? null }),
        id,
      });
    };

    sessions.set(userId, { userId, sendEvent, pending, connectedAt: new Date() });

    // Send connected confirmation
    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({ userId, message: "companion-local connected" }),
    });

    // Keep-alive pings
    let alive = true;
    const ping = setInterval(() => {
      if (!alive) return;
      void stream.writeSSE({ event: "ping", data: Date.now().toString() });
    }, 15_000);

    // Wait until client disconnects
    await stream.sleep(4 * 60 * 60 * 1000); // max 4h session

    alive = false;
    clearInterval(ping);
    // Reject all pending requests
    for (const req of pending.values()) {
      clearTimeout(req.timer);
      req.resolve({ ok: false, error: "local agent disconnected" });
    }
    sessions.delete(userId);
  });
});

// ── POST /api/local-agent/result ───────────────────────────────────────────

localAgentRoute.post("/result", async (c) => {
  const token =
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const userId = await resolveToken(token);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const session = sessions.get(userId);
  if (!session) return c.json({ error: "no active session for this user" }, 404);

  const body = await c.req.json() as {
    requestId: string;
    ok: boolean;
    data?: unknown;
    error?: string;
  };
  const req = session.pending.get(body.requestId);
  if (!req) return c.json({ error: "unknown requestId" }, 404);

  clearTimeout(req.timer);
  session.pending.delete(body.requestId);
  req.resolve({ ok: body.ok, data: body.data, error: body.error });

  return c.json({ ok: true });
});

// ── POST /api/local-agent/browse ───────────────────────────────────────────
// Browse a directory on the user's machine (for the project working-dir
// picker). Auth via session cookie (mounted under requireUser at index.ts),
// so we read userId from context, not a token.

localAgentRoute.post("/browse", async (c) => {
  // This route is session-authed (see index.ts mount). userId from context.
  const userId = (c.get as (k: string) => string | undefined)("userId");
  if (!userId) return c.json({ error: "unauthenticated" }, 401);
  if (!isLocalAgentConnected(userId)) {
    return c.json({ error: "no_local_agent", detail: "companion-local not connected" }, 409);
  }
  const body = await c.req.json().catch(() => ({})) as { path?: string };
  const result = await localAgentExecute(userId, "fs_list", { prefix: body.path || "~" });
  if (!result) return c.json({ error: "no_local_agent" }, 409);
  if (!result.ok) return c.json({ error: "browse_failed", detail: result.error }, 502);
  return c.json(result.data);
});

// ── POST /api/local-agent/mkdir ────────────────────────────────────────────
// Create a folder on the user's machine (picker "New folder").

localAgentRoute.post("/mkdir", async (c) => {
  const userId = (c.get as (k: string) => string | undefined)("userId");
  if (!userId) return c.json({ error: "unauthenticated" }, 401);
  if (!isLocalAgentConnected(userId)) {
    return c.json({ error: "no_local_agent" }, 409);
  }
  const body = await c.req.json().catch(() => ({})) as { path?: string };
  if (!body.path) return c.json({ error: "missing path" }, 400);
  // Use bash mkdir -p (quoted) on the local agent.
  const safe = body.path.replace(/'/g, "'\\''");
  const result = await localAgentExecute(userId, "bash", { command: `mkdir -p '${safe}' && echo created` });
  if (!result) return c.json({ error: "no_local_agent" }, 409);
  if (!result.ok) return c.json({ error: "mkdir_failed", detail: result.error }, 502);
  return c.json({ ok: true, path: body.path });
});

// ── GET /api/local-agent/status ────────────────────────────────────────────

localAgentRoute.get("/status", async (c) => {
  const token =
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
    c.req.query("token") ??
    "";
  const userId = await resolveToken(token);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const session = sessions.get(userId);
  return c.json({
    connected: !!session,
    connectedAt: session?.connectedAt ?? null,
  });
});

// ── Public API for executeTool ─────────────────────────────────────────────

const TOOL_TIMEOUT_MS = 30_000;

/**
 * Execute a tool on the user's local machine via companion-local.
 * Returns null if no local agent is connected (fallback to server-side).
 */
export async function localAgentExecute(
  userId: string,
  tool: string,
  args: Record<string, unknown>,
  cwd?: string | null,
): Promise<{ ok: boolean; data?: unknown; error?: string } | null> {
  const session = sessions.get(userId);
  if (!session) return null; // no local agent connected

  const id = Math.random().toString(36).slice(2, 10);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      resolve({ ok: false, error: `local agent timeout (${TOOL_TIMEOUT_MS}ms)` });
    }, TOOL_TIMEOUT_MS);

    session.pending.set(id, { id, tool, args, resolve, timer });
    session.sendEvent(id, tool, args, cwd);
  });
}

/** Browse a directory on the user's machine via the connected local agent.
 *  Used by the project working-dir picker. Returns null if no agent. */
export async function localAgentBrowse(
  userId: string,
  path: string,
): Promise<{ ok: boolean; data?: unknown; error?: string } | null> {
  return localAgentExecute(userId, "fs_list", { prefix: path || "~" });
}

/** Check if a local agent is connected for this user. */
export function isLocalAgentConnected(userId: string): boolean {
  return sessions.has(userId);
}

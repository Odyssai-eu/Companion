/**
 * Agent-token lifecycle endpoints. Used by the Settings → Agents tokens
 * UI (and direct curl) to mint long-lived bearer tokens that external
 * agents (Cowork dispatch, MCP clients, the standalone Hermes CLI on
 * the .50 host, …) present to call back into Companion as the user.
 *
 *   POST   /api/agent-tokens          { label?, ttlMs?, source? }
 *   GET    /api/agent-tokens
 *   DELETE /api/agent-tokens/:id
 *
 * Token validation is handled by middleware/hermes-token (the name is
 * historical — kept to avoid churn on a stable internal API). The
 * Hermes-Companion conversational integration was retired 2026-05-19;
 * this lifecycle layer is unrelated and stays.
 */

import { Hono } from "hono";
import {
  listHermesTokens,
  mintHermesToken,
  revokeHermesToken,
} from "../lib/hermes-token";

type Env = { Variables: { userId: string } };
const agentTokensRoute = new Hono<Env>();

agentTokensRoute.post("/", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as {
    label?: string;
    ttlMs?: number;
    source?: "hermes" | "cowork";
  };
  const { token, row } = await mintHermesToken({
    userId,
    label: body.label ?? null,
    ttlMs: body.ttlMs ?? null,
    source: body.source ?? "cowork",
  });
  return c.json({
    token,
    id: row.id,
    label: row.label,
    source: row.source,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  });
});

agentTokensRoute.get("/", async (c) => {
  const userId = c.get("userId");
  const rows = await listHermesTokens(userId);
  return c.json(rows);
});

agentTokensRoute.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const r = await revokeHermesToken(id, userId);
  if (!r.ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

export default agentTokensRoute;

/**
 * Pass-through routes to the thecompai-hermes-bridge service on the
 * Hermes host. The frontend should NOT call the bridge directly — it
 * lives on a private LAN address; we proxy through TheCompAI server so
 * the browser can authenticate against our session instead of needing
 * the bridge's own auth (which is none — LAN-only).
 *
 *   GET  /api/hermes-bridge/health
 *   GET  /api/hermes-bridge/git/status?repoPath=…
 *   GET  /api/hermes-bridge/git/diff?repoPath=…&staged=…&path=…
 *
 * Also hosts the hermes-token lifecycle endpoints used by the user (UI /
 * curl) to mint long-lived tokens for Cowork dispatch and to list/revoke:
 *
 *   POST   /api/hermes-bridge/tokens          { label?, ttlMs?, source? }
 *   GET    /api/hermes-bridge/tokens
 *   DELETE /api/hermes-bridge/tokens/:id
 */

import { Hono } from "hono";
import {
  bridgeGitDiff,
  bridgeGitStatus,
  bridgeHealth,
} from "../lib/hermes-bridge";
import {
  listHermesTokens,
  mintHermesToken,
  revokeHermesToken,
} from "../lib/hermes-token";

type Env = { Variables: { userId: string } };
const hermesBridgeRoute = new Hono<Env>();

hermesBridgeRoute.get("/health", async (c) => {
  const h = await bridgeHealth();
  return c.json(h);
});

hermesBridgeRoute.get("/git/status", async (c) => {
  const repoPath = c.req.query("repoPath");
  if (!repoPath) {
    return c.json({ error: "missing_repo_path" }, 400);
  }
  try {
    const s = await bridgeGitStatus(repoPath);
    return c.json(s);
  } catch (e) {
    return c.json(
      { error: "bridge_failure", detail: (e as Error).message },
      502,
    );
  }
});

hermesBridgeRoute.get("/git/diff", async (c) => {
  const repoPath = c.req.query("repoPath");
  const staged = c.req.query("staged") === "true";
  const path = c.req.query("path") ?? undefined;
  if (!repoPath) {
    return c.json({ error: "missing_repo_path" }, 400);
  }
  try {
    const d = await bridgeGitDiff(repoPath, { staged, path });
    return c.json(d);
  } catch (e) {
    return c.json(
      { error: "bridge_failure", detail: (e as Error).message },
      502,
    );
  }
});

// ── Hermes-token lifecycle ─────────────────────────────────────────────
// Manual mint path. Auto-mint for live Hermes turns happens server-side in
// addon-hermes / hermes-bridge (Phase 2), not here.

hermesBridgeRoute.post("/tokens", async (c) => {
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

hermesBridgeRoute.get("/tokens", async (c) => {
  const userId = c.get("userId");
  const rows = await listHermesTokens(userId);
  return c.json(rows);
});

hermesBridgeRoute.delete("/tokens/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const r = await revokeHermesToken(id, userId);
  if (!r.ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

export default hermesBridgeRoute;

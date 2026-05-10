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
 */

import { Hono } from "hono";
import {
  bridgeGitDiff,
  bridgeGitStatus,
  bridgeHealth,
} from "../lib/hermes-bridge";

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

export default hermesBridgeRoute;

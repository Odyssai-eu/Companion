/**
 * /api/files — user workspace CRUD for the FilesPanel UI.
 *
 * Auth required. All operations scoped to the current userId.
 *
 * - GET    /api/files                       list (optional ?prefix=)
 * - GET    /api/files/content?path=<path>  read content
 * - PUT    /api/files/content              {path, content} write/overwrite
 * - DELETE /api/files/content?path=<path>  delete
 *
 * Note: `requireUser` middleware is mounted globally at the app level for
 * `/api/files/*` (see server/index.ts), so we don't re-mount it here.
 */

import { Hono } from "hono";
import {
  fsDelete,
  fsList,
  fsRead,
  fsWrite,
  getWorkspaceStats,
  WorkspaceError,
} from "../lib/workspace";

type Env = { Variables: { userId: string } };
const filesRoute = new Hono<Env>();

filesRoute.get("/", async (c) => {
  const userId = c.get("userId");
  const prefix = c.req.query("prefix") ?? undefined;
  const [entries, stats] = await Promise.all([
    fsList(userId, prefix),
    getWorkspaceStats(userId),
  ]);
  return c.json({ entries, stats });
});

filesRoute.get("/content", async (c) => {
  const userId = c.get("userId");
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path required" }, 400);
  try {
    const file = await fsRead(userId, path);
    return c.json(file);
  } catch (err) {
    if (err instanceof WorkspaceError) {
      const status = err.code === "not_found" ? 404 : 400;
      return c.json({ error: err.message, code: err.code }, status);
    }
    throw err;
  }
});

filesRoute.put("/content", async (c) => {
  const userId = c.get("userId");
  const body = await c.req
    .json<{ path?: string; content?: string }>()
    .catch(() => null);
  if (!body || !body.path || typeof body.content !== "string") {
    return c.json({ error: "path and content required" }, 400);
  }
  try {
    const result = await fsWrite(userId, body.path, body.content);
    return c.json(result);
  } catch (err) {
    if (err instanceof WorkspaceError) {
      const status =
        err.code === "quota_exceeded" || err.code === "file_too_large"
          ? 413
          : 400;
      return c.json({ error: err.message, code: err.code }, status);
    }
    throw err;
  }
});

filesRoute.delete("/content", async (c) => {
  const userId = c.get("userId");
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path required" }, 400);
  try {
    await fsDelete(userId, path);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof WorkspaceError) {
      const status = err.code === "not_found" ? 404 : 400;
      return c.json({ error: err.message, code: err.code }, status);
    }
    throw err;
  }
});

export default filesRoute;

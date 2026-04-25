import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index";
import { endpoints, servers } from "../db/schema";
import { listModelsForServer, type ModelEntry } from "./servers";

const modelsRoute = new Hono();

export type GlobalModel = {
  id: string;
  name: string;
  loaded: boolean;
  serverId: string;
  serverName: string;
  engineKind: "openai-compat" | "anthropic";
};

/**
 * Aggregate model list across every server the user owns. Each entry carries
 * the originating server so the UI can route the chat call back through the
 * right proxy without a separate lookup. ExoScopy pattern: parallel fetch +
 * preserve duplicates only across servers (within a server, endpoints are
 * already merged).
 */
modelsRoute.get("/", async (c) => {
  const userId = c.get("userId");

  const rows = await db
    .select()
    .from(servers)
    .where(eq(servers.userId, userId))
    .orderBy(asc(servers.createdAt));

  const perServer = await Promise.all(
    rows.map(async (s) => {
      const eps = await db
        .select()
        .from(endpoints)
        .where(eq(endpoints.serverId, s.id))
        .orderBy(asc(endpoints.createdAt));
      const headers: Record<string, string> = {};
      if (s.authBearer) headers.Authorization = `Bearer ${s.authBearer}`;
      let modelsList: ModelEntry[] = [];
      try {
        modelsList = await listModelsForServer(eps, headers, s.engineKind);
      } catch {
        // Server unreachable — silently skip; UI still sees other servers.
      }
      return modelsList.map<GlobalModel>((m) => ({
        id: m.id,
        name: m.name,
        loaded: m.loaded,
        serverId: s.id,
        serverName: s.name,
        engineKind: s.engineKind as "openai-compat" | "anthropic",
      }));
    }),
  );

  const flat = perServer.flat();
  // Sort: loaded first, then by name for nice display.
  flat.sort((a, b) => {
    if (a.loaded !== b.loaded) return a.loaded ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return c.json({ models: flat });
});

export default modelsRoute;

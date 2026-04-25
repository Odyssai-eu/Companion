import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index";
import { endpoints, servers } from "../db/schema";
import { isCloudHost } from "../lib/url";
import { listModelsForServer, type ModelEntry } from "./servers";

const modelsRoute = new Hono();

export type GlobalModel = {
  id: string;
  name: string;
  loaded: boolean;
  serverId: string;
  serverName: string;
  engineKind: "openai-compat" | "anthropic";
  source: "local" | "cloud";
  provider: string | null;
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
      // Classify the server: cloud (OpenRouter/Anthropic/OpenAI) vs local.
      const primary = eps.find((e) => e.role === "primary") ?? eps[0];
      const cloud =
        s.engineKind === "anthropic" ||
        (primary ? isCloudHost(primary.ip) : false);

      return modelsList.map<GlobalModel>((m) => ({
        id: m.id,
        name: m.name,
        loaded: m.loaded,
        serverId: s.id,
        serverName: s.name,
        engineKind: s.engineKind as "openai-compat" | "anthropic",
        source: cloud ? "cloud" : "local",
        provider: cloud ? extractProvider(m.id) : null,
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

/**
 * For cloud models like `anthropic/claude-3-haiku` or `openai/gpt-4o`, the
 * id's first segment is the provider name. Local models tend to have
 * `mlx-community/...`, `microsoft/...`, etc. — the maker, which we don't want
 * to expose as a "provider" group on the cloud picker. So we only call out
 * the segment when the source is cloud.
 */
function extractProvider(id: string): string | null {
  const slash = id.indexOf("/");
  if (slash === -1) return null;
  const head = id.slice(0, slash).trim().toLowerCase();
  return head || null;
}

export default modelsRoute;

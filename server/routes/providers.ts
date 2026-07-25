/**
 * Providers route — Join the Odyssai flow.
 *
 *   POST /api/providers/search-odyssai  → scan LAN, return found engines
 *   POST /api/providers/join-odyssai    → POST /admin/pair, persist crew token
 *   POST /api/providers/disconnect      → DELETE /admin/crew/self, wipe local
 *   POST /api/providers/reload          → refetch /.well-known + /v1/models
 *
 * The pair flow is "discovery-gated": the operator opens the gate on
 * OdyssAI-X, then Companion's POST /admin/pair returns a crew token
 * (chat-scope, not admin). We persist {engine_url, engine_token,
 * engine_meta, engine_mode} on the user row. engine_mode is auto-set
 * from features.cloud-passthrough.
 *
 * Errors fall back to clear hints (gate_closed, engine_unreachable) so
 * the UI can render an actionable message.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { users } from "../db/schema";
import { scanForEngines } from "../lib/discovery/odyssai-scan";
import { getInstanceSettings } from "../lib/global-settings";
import { assertFetchTargetAllowed } from "../lib/net-guard";
import { invalidateEngineCache } from "../lib/odyssai-capabilities";
import type { OdyssaiEngineMeta } from "../lib/odyssai-contract";

type Env = { Variables: { userId: string } };
const providersRoute = new Hono<Env>();

// ---------- search -----------------------------------------------------------

providersRoute.post("/search-odyssai", async (c) => {
  // Body is optional. Defaults to a scan of all local IPv4 subnets.
  const body = (await c.req.json().catch(() => ({}))) as {
    subnets?: string[];
    timeoutMs?: number;
  };
  const engines = await scanForEngines({
    subnetsOverride: body?.subnets,
    timeoutPerIpMs: body?.timeoutMs,
  });
  return c.json({ engines });
});

// ---------- join -------------------------------------------------------------

const joinSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  user_label: z.string().max(120).optional(),
});

/**
 * client_id is stable per Companion install. We persist a single
 * synthesised uuid in a process-lifetime cache for now; long-term the
 * "install identity" probably belongs in a dedicated server_meta row,
 * but the engine just wants a stable opaque string per Companion.
 */
let CLIENT_ID: string | null = null;
function getOrCreateClientId(): string {
  if (CLIENT_ID) return CLIENT_ID;
  CLIENT_ID = `companion-${randomUUID()}`;
  return CLIENT_ID;
}

providersRoute.post(
  "/join-odyssai",
  zValidator("json", joinSchema),
  async (c) => {
    const userId = c.get("userId");
    const { host, port, user_label } = c.req.valid("json");
    const url = `http://${host}:${port}`;
    // SSRF guard: block metadata/link-local/unspecified targets (#3). LAN
    // engines on RFC1918 stay allowed — that is the intended join target.
    try {
      await assertFetchTargetAllowed(url);
    } catch (e) {
      return c.json(
        { error: "blocked_target", detail: (e as Error).message },
        400,
      );
    }

    const clientId = getOrCreateClientId();
    const clientName = `Companion @ ${hostname()}`;

    let pairResp: {
      ok?: boolean;
      token?: string;
      crew_id?: string;
      engine?: OdyssaiEngineMeta;
    };
    try {
      const r = await fetch(`${url}/admin/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          client_name: clientName,
          user_label,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (r.status === 403) {
        return c.json(
          {
            error: "gate_closed",
            hint:
              "The OdyssAI-X discovery gate is closed. Ask the operator to open it (Settings → Crew → Open gate).",
          },
          403,
        );
      }
      if (!r.ok) {
        const t = await r.text();
        return c.json(
          { error: "pair_failed", detail: t.slice(0, 300), status: r.status },
          // mirror upstream so the UI can branch on it if needed
          (r.status as 400 | 401 | 404 | 500),
        );
      }
      pairResp = await r.json();
    } catch (e) {
      return c.json(
        {
          error: "engine_unreachable",
          detail: (e as Error).message,
        },
        503,
      );
    }

    if (!pairResp?.token || !pairResp?.engine) {
      return c.json({ error: "pair_invalid_response" }, 502);
    }

    const supportsGateway =
      pairResp.engine.features?.includes("cloud-passthrough") ?? false;
    const engineMode = supportsGateway ? "gateway" : "hybrid";

    // Writes the caller's PERSONAL override (0059). Pairing from Settings is
    // an individual act; an admin who wants the whole instance on this
    // engine follows it with Admin → "Publish my settings as instance
    // settings", which lifts these same values onto global_settings.
    await db
      .update(users)
      .set({
        engineUrl: url,
        engineToken: pairResp.token,
        engineMeta:
          pairResp.engine as unknown as Record<string, unknown>,
        engineMode,
      })
      .where(eq(users.id, userId));

    // Clear caps cache so the picker refreshes against the new engine.
    invalidateEngineCache(url);

    // Probe the /v1/models list to get summary counts for the confirm
    // screen. Best-effort — the join succeeded either way.
    let modelsCount = 0;
    let cloudAliasesCount = 0;
    try {
      const r = await fetch(`${url}/v1/models`, {
        headers: { authorization: `Bearer ${pairResp.token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (r.ok) {
        const list = (await r.json()) as {
          data?: { x_odyssai?: { backend?: string } }[];
        };
        modelsCount = list.data?.length ?? 0;
        cloudAliasesCount = (list.data ?? []).filter(
          (m) => m.x_odyssai?.backend === "http-proxy",
        ).length;
      }
    } catch {
      // ignore — summary is informational
    }

    return c.json({
      ok: true,
      summary: {
        version: pairResp.engine.version,
        modelsCount,
        cloudAliasesCount,
        gateway: supportsGateway,
        mode: engineMode,
      },
    });
  },
);

// ---------- disconnect -------------------------------------------------------

providersRoute.post("/disconnect", async (c) => {
  const userId = c.get("userId");
  // Deliberately the RAW override, not the resolved value (0059). Only the
  // user's OWN pairing can be disconnected from here — the instance engine
  // belongs to the deployment and is unpaired by an admin in
  // Admin → Instance settings. Without this distinction, "Disconnect" would
  // read the inherited URL, DELETE the shared crew token on the engine, and
  // then write NULLs that change nothing locally: every other user broken,
  // this one still "connected".
  const [u] = await db
    .select({
      engineUrl: users.engineUrl,
      engineToken: users.engineToken,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u?.engineUrl) {
    const inst = await getInstanceSettings();
    if (inst.engineUrl) {
      return c.json(
        {
          error: "engine_inherited",
          hint:
            "This engine comes from the instance settings. Ask an admin to change it, or pair your own engine first.",
        },
        400,
      );
    }
    return c.json({ error: "no_engine" }, 400);
  }

  // Best-effort: tell the engine to revoke. We tear down locally even
  // if the engine is unreachable — the local state is what blocks Join.
  try {
    await fetch(`${u.engineUrl}/admin/crew/self`, {
      method: "DELETE",
      headers: u.engineToken
        ? { authorization: `Bearer ${u.engineToken}` }
        : undefined,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // ignore — local wipe still proceeds
  }

  // Clear the override. NULL means "inherit" now (0059), so a user who
  // disconnects their personal engine lands back on the instance one rather
  // than on an empty app — which is the whole point of the inheritance.
  // engineMode goes to NULL as well: pinning it to 'legacy' would override
  // the instance mode and leave the user on LiteLLM while inheriting a
  // gateway URL.
  await db
    .update(users)
    .set({
      engineUrl: null,
      engineToken: null,
      engineMeta: null,
      engineMode: null,
    })
    .where(eq(users.id, userId));

  if (u.engineUrl) invalidateEngineCache(u.engineUrl);

  return c.json({ ok: true });
});

// ---------- reload -----------------------------------------------------------

providersRoute.post("/reload", async (c) => {
  const userId = c.get("userId");
  // RAW override again (0059): re-probing writes engine_meta + engine_mode,
  // and writing those for a user who inherits would mint a half-override
  // pinned to today's instance engine. Admins refresh the instance engine
  // from Admin → Instance settings instead.
  const [u] = await db
    .select({
      engineUrl: users.engineUrl,
      engineToken: users.engineToken,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u?.engineUrl) {
    const inst = await getInstanceSettings();
    if (inst.engineUrl) {
      return c.json(
        {
          error: "engine_inherited",
          hint:
            "This engine comes from the instance settings — an admin refreshes it in Admin → Instance settings.",
        },
        400,
      );
    }
    return c.json({ error: "no_engine" }, 400);
  }

  try {
    const r = await fetch(
      `${u.engineUrl}/.well-known/inference-engine.json`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!r.ok) {
      return c.json(
        { error: "reload_failed", status: r.status },
        502,
      );
    }
    const meta = (await r.json()) as OdyssaiEngineMeta;
    const supportsGateway =
      meta?.features?.includes("cloud-passthrough") ?? false;
    await db
      .update(users)
      .set({
        engineMeta: meta as unknown as Record<string, unknown>,
        engineMode: supportsGateway ? "gateway" : "hybrid",
      })
      .where(eq(users.id, userId));
    invalidateEngineCache(u.engineUrl);
    return c.json({ ok: true, meta, supportsGateway });
  } catch (e) {
    return c.json(
      { error: "reload_failed", detail: (e as Error).message },
      502,
    );
  }
});

export default providersRoute;

// CRUD + import/export for the v2.0 agents registry. Used by
// Settings → Agents. Reads resolve through agent-rows (instance-rows
// pattern); writes are explicit about ownership:
//   - normal user rows: user_id = session user
//   - instance rows (user_id NULL): admin/organiser only
// Builtins can be edited (they're instance rows) but not deleted —
// disable them instead; a deploy re-seeding would resurrect them anyway.

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { db } from "../db/index";
import { agents, users } from "../db/schema";
import { resolveAgentsForUser } from "../lib/agent-rows";

type Env = { Variables: { userId: string } };

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const agentInput = z.object({
  name: z.string().min(1).max(64).regex(NAME_RE),
  displayName: z.string().min(1).max(80),
  description: z.string().max(500).default(""),
  mode: z.enum(["primary", "subagent"]).default("subagent"),
  systemPrompt: z.string().min(1).max(50_000),
  model: z.string().max(200).nullable().optional(),
  toolsAllow: z.array(z.string().max(80)).max(50).default([]),
  maxSteps: z.number().int().min(1).max(50).default(15),
  enabled: z.boolean().default(true),
  /** true = instance row (admin only). */
  instance: z.boolean().default(false),
});

async function isAdminish(userId: string): Promise<boolean> {
  const [u] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u?.role === "admin" || u?.role === "organiser";
}

const r = new Hono<Env>();

r.get("/", async (c) => {
  const userId = c.get("userId");
  const rows = await resolveAgentsForUser(userId);
  return c.json({ agents: rows });
});

r.post("/", zValidator("json", agentInput), async (c) => {
  const userId = c.get("userId");
  const data = c.req.valid("json");
  if (data.instance && !(await isAdminish(userId))) {
    return c.json({ error: "instance agents are admin-only" }, 403);
  }
  try {
    const [row] = await db
      .insert(agents)
      .values({
        userId: data.instance ? null : userId,
        name: data.name,
        displayName: data.displayName,
        description: data.description,
        mode: data.mode,
        systemPrompt: data.systemPrompt,
        model: data.model ?? null,
        toolsAllow: data.toolsAllow,
        maxSteps: data.maxSteps,
        source: data.instance ? "instance" : "user",
        enabled: data.enabled,
      })
      .returning();
    return c.json({ agent: row }, 201);
  } catch (e) {
    const msg = (e as Error).message;
    const dup = /unique|duplicate/i.test(msg);
    return c.json(
      { error: dup ? `An agent named "${data.name}" already exists` : msg },
      dup ? 409 : 400,
    );
  }
});

r.patch("/:id", zValidator("json", agentInput.partial()), async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const data = c.req.valid("json");
  const [row] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);
  const ownRow = row.userId === userId;
  const instanceRow = row.userId === null;
  if (!ownRow && !(instanceRow && (await isAdminish(userId)))) {
    return c.json({ error: "not_found" }, 404);
  }
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) patch.name = data.name;
  if (data.displayName !== undefined) patch.displayName = data.displayName;
  if (data.description !== undefined) patch.description = data.description;
  if (data.mode !== undefined) patch.mode = data.mode;
  if (data.systemPrompt !== undefined) patch.systemPrompt = data.systemPrompt;
  if (data.model !== undefined) patch.model = data.model;
  if (data.toolsAllow !== undefined) patch.toolsAllow = data.toolsAllow;
  if (data.maxSteps !== undefined) patch.maxSteps = data.maxSteps;
  if (data.enabled !== undefined) patch.enabled = data.enabled;
  const [updated] = await db
    .update(agents)
    .set(patch)
    .where(eq(agents.id, id))
    .returning();
  return c.json({ agent: updated });
});

r.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [row] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.source === "builtin") {
    return c.json(
      { error: "builtins can be disabled, not deleted (re-seeded at boot)" },
      400,
    );
  }
  const ownRow = row.userId === userId;
  const instanceRow = row.userId === null;
  if (!ownRow && !(instanceRow && (await isAdminish(userId)))) {
    return c.json({ error: "not_found" }, 404);
  }
  await db.delete(agents).where(eq(agents.id, id));
  return c.body(null, 204);
});

// ── Import / export (.md frontmatter, same shape as skills) ────────────

r.get("/:id/export.md", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id)))
    .limit(1);
  if (!row || (row.userId !== null && row.userId !== userId)) {
    return c.json({ error: "not_found" }, 404);
  }
  const fm = stringifyYaml({
    name: row.name,
    display_name: row.displayName,
    description: row.description,
    mode: row.mode,
    model: row.model ?? undefined,
    tools_allow: row.toolsAllow,
    max_steps: row.maxSteps,
  }).trimEnd();
  const md = `---\n${fm}\n---\n\n${row.systemPrompt.trimEnd()}\n`;
  return new Response(md, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${row.name}.md"`,
    },
  });
});

r.post("/import/md", async (c) => {
  const userId = c.get("userId");
  const { content } = await c.req.json<{ content: string }>();
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(content ?? "");
  if (!m) return c.json({ error: "missing YAML frontmatter" }, 400);
  let fm: Record<string, unknown>;
  try {
    fm = parseYaml(m[1]) as Record<string, unknown>;
  } catch (e) {
    return c.json({ error: `invalid YAML: ${(e as Error).message}` }, 400);
  }
  const name = typeof fm.name === "string" ? fm.name : "";
  if (!NAME_RE.test(name)) return c.json({ error: "invalid name" }, 400);
  const body = m[2].trim();
  if (!body) return c.json({ error: "empty prompt body" }, 400);
  try {
    const [row] = await db
      .insert(agents)
      .values({
        userId,
        name,
        displayName:
          typeof fm.display_name === "string" ? fm.display_name : name,
        description: typeof fm.description === "string" ? fm.description : "",
        mode: fm.mode === "primary" ? "primary" : "subagent",
        systemPrompt: body,
        model: typeof fm.model === "string" ? fm.model : null,
        toolsAllow: Array.isArray(fm.tools_allow)
          ? (fm.tools_allow as string[]).filter((t) => typeof t === "string")
          : [],
        maxSteps:
          typeof fm.max_steps === "number" && fm.max_steps >= 1
            ? Math.min(50, Math.floor(fm.max_steps))
            : 15,
        source: "user",
        enabled: true,
      })
      .returning();
    return c.json({ agent: row }, 201);
  } catch (e) {
    const msg = (e as Error).message;
    const dup = /unique|duplicate/i.test(msg);
    return c.json(
      { error: dup ? `An agent named "${name}" already exists` : msg },
      dup ? 409 : 400,
    );
  }
});

// keep isNull import meaningful for future instance filters
void isNull;

export default r;

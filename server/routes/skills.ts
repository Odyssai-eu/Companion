// CRUD + import/export for agent_skills (agentskills.io-aligned).
// Used by Settings → Skills page. The chat model goes through the
// skill_* tools instead.

import { Hono } from "hono";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { agentSkills } from "../db/schema";
import { parseSkillMd } from "../lib/skill-format";
import { packSkillZip, unpackSkillZip } from "../lib/skill-archive";

type Env = { Variables: { userId: string } };

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const r = new Hono<Env>();

r.get("/", async (c) => {
  const userId = c.get("userId");
  const rows = await db
    .select({
      id: agentSkills.id,
      name: agentSkills.name,
      description: agentSkills.description,
      tags: agentSkills.tags,
      source: agentSkills.source,
      license: agentSkills.license,
      compatibility: agentSkills.compatibility,
      bodyLength: sql<number>`length(${agentSkills.body})`,
      files: agentSkills.files,
      updatedAt: agentSkills.updatedAt,
    })
    .from(agentSkills)
    .where(eq(agentSkills.userId, userId))
    .orderBy(asc(agentSkills.name));
  const skills = rows.map((row) => ({
    ...row,
    fileCount: Object.keys(row.files ?? {}).length,
    files: undefined,
  }));
  return c.json({ skills });
});

r.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [row] = await db
    .select()
    .from(agentSkills)
    .where(and(eq(agentSkills.userId, userId), eq(agentSkills.id, id)))
    .limit(1);
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ skill: row });
});

r.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{
    name: string;
    description?: string | null;
    body: string;
    tags?: string[];
    license?: string | null;
    compatibility?: string | null;
    files?: Record<string, string>;
    metadata?: Record<string, unknown>;
    source?: "user" | "agent" | "imported";
  }>();
  if (!body.name || !NAME_RE.test(body.name) || body.name.length > 64) {
    return c.json({ error: "invalid name" }, 400);
  }
  if (!body.body?.trim()) return c.json({ error: "body required" }, 400);
  try {
    const [row] = await db
      .insert(agentSkills)
      .values({
        userId,
        name: body.name,
        body: body.body,
        description: body.description ?? null,
        tags: body.tags ?? [],
        source: body.source ?? "user",
        license: body.license ?? null,
        compatibility: body.compatibility ?? null,
        files: body.files ?? {},
        metadata: body.metadata ?? {},
      })
      .returning();
    return c.json({ skill: row });
  } catch (e) {
    const msg = (e as Error).message;
    const collision = /unique|duplicate/i.test(msg);
    return c.json(
      { error: collision ? `Skill "${body.name}" already exists` : msg },
      collision ? 409 : 400,
    );
  }
});

r.patch("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    description?: string | null;
    body?: string;
    tags?: string[];
    license?: string | null;
    compatibility?: string | null;
    files?: Record<string, string>;
    metadata?: Record<string, unknown>;
  }>();
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) {
    if (!NAME_RE.test(body.name) || body.name.length > 64) {
      return c.json({ error: "invalid name" }, 400);
    }
    patch.name = body.name;
  }
  if (body.description !== undefined) patch.description = body.description;
  if (body.body !== undefined) patch.body = body.body;
  if (body.tags !== undefined) patch.tags = body.tags;
  if (body.license !== undefined) patch.license = body.license;
  if (body.compatibility !== undefined) patch.compatibility = body.compatibility;
  if (body.files !== undefined) patch.files = body.files;
  if (body.metadata !== undefined) patch.metadata = body.metadata;
  const [row] = await db
    .update(agentSkills)
    .set(patch)
    .where(and(eq(agentSkills.userId, userId), eq(agentSkills.id, id)))
    .returning();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ skill: row });
});

r.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const rows = await db
    .delete(agentSkills)
    .where(and(eq(agentSkills.userId, userId), eq(agentSkills.id, id)))
    .returning({ id: agentSkills.id });
  if (rows.length === 0) return c.json({ error: "not found" }, 404);
  return c.body(null, 204);
});

// Import a single SKILL.md (text body in the request payload).
r.post("/import/md", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ content: string }>();
  let parsed;
  try {
    parsed = parseSkillMd(body.content);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  try {
    const [row] = await db
      .insert(agentSkills)
      .values({
        userId,
        name: parsed.name,
        body: parsed.body,
        description: parsed.description,
        license: parsed.license,
        compatibility: parsed.compatibility,
        metadata: parsed.metadata,
        source: "imported",
      })
      .returning();
    return c.json({ skill: row });
  } catch (e) {
    const msg = (e as Error).message;
    const collision = /unique|duplicate/i.test(msg);
    return c.json(
      { error: collision ? `Skill "${parsed.name}" already exists` : msg },
      collision ? 409 : 400,
    );
  }
});

// Import a SKILL.md + supporting files ZIP (multipart/form-data 'file').
r.post("/import/zip", async (c) => {
  const userId = c.get("userId");
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "no file uploaded" }, 400);
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  let pkg;
  try {
    pkg = await unpackSkillZip(buf);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  try {
    const [row] = await db
      .insert(agentSkills)
      .values({
        userId,
        name: pkg.name,
        body: pkg.body,
        description: pkg.description,
        license: pkg.license,
        compatibility: pkg.compatibility,
        files: pkg.files,
        metadata: pkg.metadata,
        source: "imported",
      })
      .returning();
    return c.json({ skill: row });
  } catch (e) {
    const msg = (e as Error).message;
    const collision = /unique|duplicate/i.test(msg);
    return c.json(
      { error: collision ? `Skill "${pkg.name}" already exists` : msg },
      collision ? 409 : 400,
    );
  }
});

// Export a skill as a SKILL.md + files ZIP.
r.get("/:id/export", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [row] = await db
    .select()
    .from(agentSkills)
    .where(and(eq(agentSkills.userId, userId), eq(agentSkills.id, id)))
    .limit(1);
  if (!row) return c.json({ error: "not found" }, 404);
  const zip = await packSkillZip({
    name: row.name,
    description: row.description,
    license: row.license,
    compatibility: row.compatibility,
    body: row.body,
    files: row.files ?? {},
    metadata: row.metadata ?? {},
  });
  return new Response(zip as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${row.name}.zip"`,
    },
  });
});

export default r;

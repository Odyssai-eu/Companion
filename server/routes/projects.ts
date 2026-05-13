import { zValidator } from "@hono/zod-validator";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index";
import { projects } from "../db/schema";

const projectsRoute = new Hono();

// Icon values are SLUGS — the frontend's <ProjectIcon /> resolves them to
// inline SVGs (Lucide-style stroke 1.75, currentColor). Keeps the brand
// language uniform; no emoji, no cartoon.
export const CATEGORIES = [
  {
    id: "general",
    name: "General",
    icon: "briefcase",
    systemPrompt: "",
  },
  {
    id: "writing",
    name: "Writing",
    icon: "pencil",
    systemPrompt:
      "You are a writing coach. Preserve voice, focus on clarity and structure, explain edits.",
  },
  {
    id: "code",
    name: "Code",
    icon: "code",
    systemPrompt:
      "You are a senior engineer. Give concise, correct answers with runnable code. Point out edge cases you notice.",
  },
  {
    id: "research",
    name: "Research",
    icon: "flask",
    systemPrompt:
      "You are a research assistant. Cite sources when possible, distinguish facts from speculation, surface counter-arguments.",
  },
  {
    id: "personal",
    name: "Personal",
    icon: "compass",
    systemPrompt:
      "You are a thinking partner. Ask clarifying questions before giving advice. Respect privacy.",
  },
] as const;

const createSchema = z.object({
  name: z.string().min(1).max(120),
  category: z.string().max(60).optional(),
  systemPrompt: z.string().max(64000).optional(),
  instructions: z.string().max(64000).optional(),
  memoryEnabled: z.boolean().optional(),
  dedicatedMemoryEnabled: z.boolean().optional(),
  globalMemoryReadOnly: z.boolean().optional(),
  externalVaultPath: z.string().max(1000).nullish(),
  externalVaultReadOnly: z.boolean().optional(),
  sharingEnabled: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  category: z.string().max(60).optional(),
  systemPrompt: z.string().max(64000).nullish(),
  instructions: z.string().max(64000).nullish(),
  memoryEnabled: z.boolean().optional(),
  dedicatedMemoryEnabled: z.boolean().optional(),
  globalMemoryReadOnly: z.boolean().optional(),
  /** Absolute path on the gateway host. Pass null / empty string to
   *  clear. The chat route reads this live every turn; no copy. */
  externalVaultPath: z.string().max(1000).nullish(),
  externalVaultReadOnly: z.boolean().optional(),
  sharingEnabled: z.boolean().optional(),
});

function iconForCategory(id: string): string | null {
  return CATEGORIES.find((c) => c.id === id)?.icon ?? null;
}

projectsRoute.get("/categories", (c) => c.json({ categories: CATEGORIES }));

projectsRoute.get("/", async (c) => {
  const userId = c.get("userId");
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.updatedAt));
  return c.json({ projects: rows });
});

projectsRoute.post("/", zValidator("json", createSchema), async (c) => {
  const userId = c.get("userId");
  const data = c.req.valid("json");
  const category = data.category ?? "general";
  const cat = CATEGORIES.find((c) => c.id === category);
  const [row] = await db
    .insert(projects)
    .values({
      userId,
      name: data.name,
      category,
      icon: iconForCategory(category),
      systemPrompt: data.systemPrompt ?? cat?.systemPrompt ?? "",
      instructions: data.instructions,
      memoryEnabled: data.memoryEnabled ?? true,
      dedicatedMemoryEnabled: data.dedicatedMemoryEnabled ?? false,
      globalMemoryReadOnly: data.globalMemoryReadOnly ?? false,
      externalVaultPath:
        data.externalVaultPath && data.externalVaultPath.trim()
          ? data.externalVaultPath.trim()
          : null,
      externalVaultReadOnly: data.externalVaultReadOnly ?? true,
      sharingEnabled: data.sharingEnabled ?? false,
    })
    .returning();
  return c.json({ project: row }, 201);
});

projectsRoute.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [row] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  if (!row || row.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ project: row });
});

projectsRoute.patch(
  "/:id",
  zValidator("json", updateSchema),
  async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const [existing] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    if (!existing || existing.userId !== userId) {
      return c.json({ error: "not_found" }, 404);
    }
    const data = c.req.valid("json");
    const patch: Partial<typeof projects.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (data.name !== undefined) patch.name = data.name;
    if (data.category !== undefined) {
      patch.category = data.category;
      patch.icon = iconForCategory(data.category);
    }
    if (data.systemPrompt !== undefined)
      patch.systemPrompt = data.systemPrompt ?? null;
    if (data.instructions !== undefined)
      patch.instructions = data.instructions ?? null;
    if (data.memoryEnabled !== undefined) patch.memoryEnabled = data.memoryEnabled;
    if (data.dedicatedMemoryEnabled !== undefined)
      patch.dedicatedMemoryEnabled = data.dedicatedMemoryEnabled;
    if (data.globalMemoryReadOnly !== undefined)
      patch.globalMemoryReadOnly = data.globalMemoryReadOnly;
    if (data.externalVaultPath !== undefined) {
      patch.externalVaultPath =
        data.externalVaultPath && data.externalVaultPath.trim()
          ? data.externalVaultPath.trim()
          : null;
    }
    if (data.externalVaultReadOnly !== undefined)
      patch.externalVaultReadOnly = data.externalVaultReadOnly;
    if (data.sharingEnabled !== undefined)
      patch.sharingEnabled = data.sharingEnabled;
    const [updated] = await db
      .update(projects)
      .set(patch)
      .where(eq(projects.id, id))
      .returning();
    return c.json({ project: updated });
  },
);

projectsRoute.get("/:id/export.md", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  if (!project || project.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  const lines: string[] = [];
  lines.push(`# ${project.name}`);
  lines.push("");
  lines.push(`> Exported ${new Date().toISOString()}`);
  lines.push(`> Category: ${project.category}`);
  lines.push(`> Created ${project.createdAt}`);
  lines.push("");
  if (project.systemPrompt) {
    lines.push("## System prompt");
    lines.push("");
    lines.push(project.systemPrompt);
    lines.push("");
  }
  if (project.instructions) {
    lines.push("## Instructions");
    lines.push("");
    lines.push(project.instructions);
    lines.push("");
  }
  const md = lines.join("\n");
  const filename = `${project.name
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 80) || "project"}.md`;
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  return c.body(md);
});

projectsRoute.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const rows = await db
    .delete(projects)
    .where(eq(projects.id, id))
    .returning({ id: projects.id, userId: projects.userId });
  const row = rows[0];
  if (!row || row.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.body(null, 204);
});

export default projectsRoute;

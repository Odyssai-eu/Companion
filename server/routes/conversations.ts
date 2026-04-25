import { zValidator } from "@hono/zod-validator";
import { asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index";
import { conversations, messages } from "../db/schema";

const conversationsRoute = new Hono();

const createSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  serverId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  model: z.string().max(200).optional(),
});

const appendMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().default(""),
  reasoning: z.string().optional(),
  stats: z.record(z.unknown()).optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  model: z.string().max(200).optional(),
});

conversationsRoute.get("/", async (c) => {
  const userId = c.get("userId");
  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt));
  return c.json({ conversations: rows });
});

conversationsRoute.post(
  "/",
  zValidator("json", createSchema),
  async (c) => {
    const userId = c.get("userId");
    const data = c.req.valid("json");
    const [row] = await db
      .insert(conversations)
      .values({
        userId,
        title: data.title ?? "New conversation",
        serverId: data.serverId,
        projectId: data.projectId,
        model: data.model,
      })
      .returning();
    return c.json({ conversation: row }, 201);
  },
);

conversationsRoute.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  if (!conversation || conversation.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt));
  return c.json({ conversation, messages: msgs });
});

conversationsRoute.patch(
  "/:id",
  zValidator("json", updateSchema),
  async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const data = c.req.valid("json");
    const [existing] = await db
      .select({ userId: conversations.userId })
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    if (!existing || existing.userId !== userId) {
      return c.json({ error: "not_found" }, 404);
    }
    const [updated] = await db
      .update(conversations)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(conversations.id, id))
      .returning();
    return c.json({ conversation: updated });
  },
);

conversationsRoute.get("/:id/export.md", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  if (!conv || conv.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt));

  const lines: string[] = [];
  lines.push(`# ${conv.title}`);
  lines.push("");
  lines.push(`> Exported ${new Date().toISOString()}`);
  lines.push(`> Created ${conv.createdAt}`);
  if (conv.model) lines.push(`> Model: \`${conv.model}\``);
  lines.push("");
  for (const m of msgs) {
    lines.push(
      m.role === "user" ? "## You" : m.role === "assistant" ? "## Assistant" : "## System",
    );
    lines.push("");
    if (m.reasoning) {
      lines.push("<details><summary>Thought</summary>");
      lines.push("");
      lines.push(m.reasoning);
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
    lines.push(m.content || "_(empty)_");
    lines.push("");
  }
  const md = lines.join("\n");
  const filename = `${(conv.title || "conversation")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 80) || "conversation"}.md`;
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  return c.body(md);
});

conversationsRoute.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const rows = await db
    .delete(conversations)
    .where(eq(conversations.id, id))
    .returning({ id: conversations.id, userId: conversations.userId });
  const row = rows[0];
  if (!row || row.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.body(null, 204);
});

conversationsRoute.post(
  "/:id/messages",
  zValidator("json", appendMessageSchema),
  async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    if (!conversation || conversation.userId !== userId) {
      return c.json({ error: "not_found" }, 404);
    }
    const data = c.req.valid("json");
    const [message] = await db
      .insert(messages)
      .values({ conversationId: id, ...data })
      .returning();

    // Auto-title the conversation from the first user message if still default
    const shouldAutoTitle =
      data.role === "user" &&
      conversation.title === "New conversation" &&
      data.content.trim().length > 0;
    if (shouldAutoTitle) {
      const title = data.content.trim().slice(0, 80);
      await db
        .update(conversations)
        .set({ title, updatedAt: new Date() })
        .where(eq(conversations.id, id));
    } else {
      await db
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.id, id));
    }

    return c.json({ message }, 201);
  },
);

export default conversationsRoute;

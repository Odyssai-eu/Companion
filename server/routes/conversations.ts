import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index";
import { conversations, messages, projects, users } from "../db/schema";
import {
  clearInference,
  getInferenceStatus,
  listActiveForUser,
} from "../lib/inference-state";
import { authHeaders } from "../lib/litellm";
import { compileNow, getMemoryContext } from "../lib/memory";
import { buildTag } from "../lib/timetag";

const conversationsRoute = new Hono();

const createSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  projectId: z.string().uuid().optional(),
  model: z.string().max(200).optional(),
  /** 'chat' (default), 'talk', or 'hermes' — chooses the layout +
   *  routing path on send. */
  kind: z.enum(["chat", "talk", "hermes"]).optional(),
  /** Optional repo path bound to this conversation. Only meaningful
   *  for kind='hermes' but we don't enforce that here — useful to
   *  let the user pick before flipping kind in the future. */
  repoPath: z.string().min(1).max(500).optional(),
});

const appendMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().default(""),
  reasoning: z.string().optional(),
  stats: z.record(z.unknown()).optional(),
  // Frontend-controlled timestamp. We store this exact value so the backend's
  // notion of when the message happened matches the frontend's — critical
  // for byte-stable time tags (and therefore for upstream KV-cache hits).
  createdAt: z.string().datetime().optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  model: z.string().max(200).optional(),
  pinned: z.boolean().optional(),
  projectId: z.string().uuid().nullish(),
  memoryEnabled: z.boolean().optional(),
  /** Pass empty string or null to clear. */
  repoPath: z.string().max(500).nullish(),
});

conversationsRoute.get("/", async (c) => {
  const userId = c.get("userId");
  // Subquery: pull the latest user message content (truncated) as a preview.
  const lastMsg = sql<string | null>`(
    SELECT m.content FROM ${messages} m
    WHERE m.conversation_id = ${conversations.id}
      AND m.role = 'user'
    ORDER BY m.created_at DESC
    LIMIT 1
  )`.as("last_message");

  const rows = await db
    .select({
      id: conversations.id,
      userId: conversations.userId,
      projectId: conversations.projectId,
      title: conversations.title,
      kind: conversations.kind,
      repoPath: conversations.repoPath,
      model: conversations.model,
      pinned: conversations.pinned,
      memoryEnabled: conversations.memoryEnabled,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
      lastMessage: lastMsg,
    })
    .from(conversations)
    .where(eq(conversations.userId, userId))
    // Pinned first, then most-recently created (NOT updated — renaming
    // shouldn't shuffle a 3-day-old conversation back to the top of "Today").
    .orderBy(desc(conversations.pinned), desc(conversations.createdAt));
  return c.json({ conversations: rows });
});

conversationsRoute.post(
  "/",
  zValidator("json", createSchema),
  async (c) => {
    const userId = c.get("userId");
    const data = c.req.valid("json");

    // Inherit memory toggle from the parent project (if any). When the
    // project disables memory, the new conversation starts with it off too,
    // and we don't bother snapshotting.
    let memoryEnabled = true;
    if (data.projectId) {
      const [proj] = await db
        .select({ memoryEnabled: projects.memoryEnabled })
        .from(projects)
        .where(eq(projects.id, data.projectId))
        .limit(1);
      if (proj) memoryEnabled = proj.memoryEnabled;
    }

    // Snapshot the user's memory wiki at conversation creation (only when
    // enabled). Frozen for the lifetime of the conversation so the system-
    // prompt prefix stays byte-stable across turns.
    const memorySnapshot = memoryEnabled
      ? await getMemoryContext(userId, data.projectId ?? null)
      : "";
    const kind = data.kind ?? "chat";
    const defaultTitle =
      kind === "talk"
        ? "New talk"
        : kind === "hermes"
          ? "New Hermes"
          : "New conversation";
    const [row] = await db
      .insert(conversations)
      .values({
        userId,
        title: data.title ?? defaultTitle,
        projectId: data.projectId,
        model: data.model,
        kind,
        repoPath: data.repoPath ?? null,
        memoryEnabled,
        memorySnapshot: memorySnapshot || null,
        memorySnapshotAt: memorySnapshot ? new Date() : null,
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
  // Inference state is opportunistic — the client uses it to render the
  // in-flight assistant content when reopening a conv whose stream is
  // still running server-side. Missing or finished → { active: false }.
  const inference = getInferenceStatus(id, userId);
  return c.json({ conversation, messages: msgs, inference });
});

/**
 * Active streams across all the user's conversations. Drives the
 * sidebar / NavBar parallel-stream indicator. Mounted before /:id so
 * Hono's path-match doesn't capture "active" as a conv id.
 */
conversationsRoute.get("/active", async (c) => {
  const userId = c.get("userId");
  return c.json({ active: listActiveForUser(userId) });
});

/**
 * Live state of an in-flight inference. Returns the buffered content +
 * reasoning + done/error flags. Auth-gated via the userId stored INSIDE
 * the inference entry — a foreign UUID returns { active: false }, not
 * an error, so the client treats it the same as "no stream".
 */
conversationsRoute.get("/:id/inference", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  // Validate ownership of the conv itself too — defence in depth.
  const [row] = await db
    .select({ userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  if (!row || row.userId !== userId) {
    return c.json({ active: false }, 404);
  }
  return c.json(getInferenceStatus(id, userId));
});

/**
 * Drop the buffer entry. The chat route already drops it 60s after the
 * stream completes, but the client can call this explicitly after it
 * has consumed the final state to avoid showing stale "active" markers.
 */
conversationsRoute.post("/:id/inference/clear", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [row] = await db
    .select({ userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  if (!row || row.userId !== userId) {
    return c.json({ ok: false }, 404);
  }
  clearInference(id, userId);
  return c.json({ ok: true });
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
    // Don't bump updatedAt on metadata-only changes (rename, pin, project
    // move, memory toggle) — only message activity should mark a
    // conversation as "recent".
    const isMetadataOnly =
      data.title !== undefined ||
      data.pinned !== undefined ||
      data.projectId !== undefined ||
      data.memoryEnabled !== undefined ||
      data.repoPath !== undefined;
    const patch: Record<string, unknown> = { ...data };
    if (!isMetadataOnly) patch.updatedAt = new Date();
    if (data.projectId === null) patch.projectId = null;
    // Empty string clears the repo binding.
    if (data.repoPath === null || data.repoPath === "") patch.repoPath = null;

    // Toggling memory ON — backfill the snapshot now so the next chat turn
    // has it ready without paying a memory-service round-trip on the hot
    // path.
    if (data.memoryEnabled === true) {
      const [conv] = await db
        .select({
          projectId: conversations.projectId,
          memorySnapshot: conversations.memorySnapshot,
        })
        .from(conversations)
        .where(eq(conversations.id, id))
        .limit(1);
      if (conv && conv.memorySnapshot == null) {
        const fresh = await getMemoryContext(userId, conv.projectId);
        if (fresh) {
          patch.memorySnapshot = fresh;
          patch.memorySnapshotAt = new Date();
        }
      }
    }

    const [updated] = await db
      .update(conversations)
      .set(patch)
      .where(eq(conversations.id, id))
      .returning();
    return c.json({ conversation: updated });
  },
);

conversationsRoute.get("/:id/export.json", async (c) => {
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
  const filename = `${(conv.title || "conversation")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 80) || "conversation"}.json`;
  c.header("Content-Type", "application/json; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  return c.body(JSON.stringify({ conversation: conv, messages: msgs }, null, 2));
});

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

// Batch delete — POST body { ids: [...] }. We could overload DELETE
// with a body, but POST keeps proxies and middleware predictable. Only
// ids belonging to the caller are deleted; bad ids are reported in
// `notFound` so the UI can surface a partial-success message instead
// of failing the whole batch.
const batchDeleteSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});
conversationsRoute.post(
  "/delete-many",
  zValidator("json", batchDeleteSchema),
  async (c) => {
    const userId = c.get("userId");
    const { ids } = c.req.valid("json");

    // Verify ownership before deleting — never delete someone else's
    // conv even if a uuid happens to collide. We do this in one query
    // and then delete in a second, so half-completed batches don't
    // leave dangling refs (the ORM's ON DELETE CASCADE handles
    // messages / attachments / stats).
    const owned = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(eq(conversations.userId, userId), inArray(conversations.id, ids)),
      );
    const ownedIds = new Set(owned.map((r) => r.id));
    const missing = ids.filter((id) => !ownedIds.has(id));

    if (ownedIds.size > 0) {
      await db
        .delete(conversations)
        .where(inArray(conversations.id, Array.from(ownedIds)));
    }

    return c.json({
      deleted: Array.from(ownedIds),
      notFound: missing,
    });
  },
);

conversationsRoute.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  // Verify ownership *before* deleting, otherwise a wrong user could nuke a
  // conversation by accident. Also keeps the response codes meaningful: 404
  // means "didn't exist or wasn't yours".
  const [existing] = await db
    .select({ userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  if (!existing || existing.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  try {
    await db.delete(conversations).where(eq(conversations.id, id));
  } catch (err) {
    console.error("conversation delete failed", err);
    return c.json(
      {
        error: "delete_failed",
        detail: (err as Error).message,
      },
      500,
    );
  }
  return c.body(null, 204);
});

// Truncate the conversation back to (and not including) the given message.
// Used by Edit and Regenerate so we don't keep stale assistant replies in the
// log when the user backtracks.
conversationsRoute.delete("/:id/messages/from/:messageId", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const messageId = c.req.param("messageId");
  const [conversation] = await db
    .select({ userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  if (!conversation || conversation.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  const [pivot] = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!pivot) return c.json({ error: "not_found" }, 404);
  await db
    .delete(messages)
    .where(
      sql`${messages.conversationId} = ${id} AND ${messages.createdAt} >= ${pivot.createdAt}`,
    );
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
    const insertValues: typeof messages.$inferInsert = {
      conversationId: id,
      role: data.role,
      content: data.content,
      reasoning: data.reasoning,
      stats: data.stats,
    };
    if (data.createdAt) insertValues.createdAt = new Date(data.createdAt);
    const [message] = await db.insert(messages).values(insertValues).returning();

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

    // No auto-recompile here. The wiki is now snapshot-per-conversation:
    // the user explicitly hits "Remember now" (POST /:id/refresh-memory) when
    // they want to consolidate this conversation into the wiki. This keeps
    // the prompt prefix stable across turns for KV-cache hits.

    return c.json({ message }, 201);
  },
);

// Prewarm the upstream KV cache for this conversation. Builds the EXACT same
// prompt prefix that the next chat turn will send, then fires a 1-token
// completion at the upstream. EXO populates its prefix cache slot with the
// system + memory + history; when the user actually sends a message, only
// the new user-msg portion is re-prefilled.
//
// Fire-and-forget — returns immediately. No streaming. The byte sequence
// produced here MUST mirror chat.ts (same field order, same time tags, same
// memory snapshot, same JSON shape) — otherwise EXO sees a different prefix
// and the cache misses.
//
// Triggered by the frontend when a conversation is opened or the model
// selection changes. Skipped if the conversation has no messages yet.
const prewarmSchema = z.object({
  model: z.string().min(1).max(200),
  system_prompt: z.string().optional(),
});

conversationsRoute.post(
  "/:id/prewarm",
  zValidator("json", prewarmSchema),
  async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const opts = c.req.valid("json");

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    if (!conv || conv.userId !== userId) {
      return c.json({ error: "not_found" }, 404);
    }

    const msgRows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.createdAt));
    if (msgRows.length === 0) {
      return c.json({ ok: false, reason: "empty" });
    }
    console.log(
      `[prewarm] conv=${id.slice(0, 8)} model=${opts.model} msgs=${msgRows.length}`,
    );

    const [user] = await db
      .select({
        timezone: users.timezone,
        litellmUrl: users.litellmUrl,
        litellmApiKey: users.litellmApiKey,
        engineUrl: users.engineUrl,
        engineToken: users.engineToken,
        engineMode: users.engineMode,
        litellmDisabled: users.litellmDisabled,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return c.json({ error: "user_not_found" }, 404);

    // Memory snapshot — read frozen value, lazy-backfill if missing. When
    // the conversation has memory disabled, skip injection entirely (must
    // match chat.ts behaviour or the prewarm prefix differs from the real
    // chat's, defeating the whole point).
    let memoryBlock = "";
    if (conv.memoryEnabled !== false) {
      memoryBlock = conv.memorySnapshot ?? "";
      if (conv.memorySnapshot == null) {
        memoryBlock = await getMemoryContext(userId, conv.projectId);
        await db
          .update(conversations)
          .set({
            memorySnapshot: memoryBlock || null,
            memorySnapshotAt: memoryBlock ? new Date() : null,
          })
          .where(eq(conversations.id, id));
      }
    }

    // System prompt composition — must match chat.ts byte-for-byte.
    const systemSegments: string[] = [];
    if (opts.system_prompt && opts.system_prompt.trim().length > 0) {
      systemSegments.push(opts.system_prompt.trim());
    }
    if (memoryBlock.trim().length > 0) systemSegments.push(memoryBlock);
    const composedSystem = systemSegments.join("\n\n---\n\n");

    // Tag user messages — same logic as chat.ts (uniform: stamp=createdAt,
    // previous=previous user msg's createdAt).
    const tz = user.timezone || "Europe/Brussels";
    type WireMsg = { role: string; content: string; createdAt?: string };
    const tagged: WireMsg[] = [];
    let lastUserAt: Date | null = null;
    for (const m of msgRows) {
      const createdIso = m.createdAt.toISOString();
      if (m.role !== "user") {
        tagged.push({
          role: m.role,
          content: m.content,
          createdAt: createdIso,
        });
        continue;
      }
      const stamp = m.createdAt;
      const tag = buildTag({ now: stamp, previous: lastUserAt, timezone: tz });
      tagged.push({
        role: m.role,
        content: `${tag} ${m.content}`,
        createdAt: createdIso,
      });
      lastUserAt = stamp;
    }

    // Append a tiny dummy user msg to satisfy "user-last" requirement and
    // make the upstream prefill the entire conversation prefix. Its tag
    // will differ from the next real user msg's tag (different now/previous),
    // but that only affects the LAST few tokens — the cacheable prefix
    // (sys + memory + tagged history) is byte-identical to what chat.ts
    // will send next.
    const dummyAt = new Date();
    const dummyTag = buildTag({
      now: dummyAt,
      previous: lastUserAt,
      timezone: tz,
    });
    tagged.push({
      role: "user",
      content: `${dummyTag} .`,
      createdAt: dummyAt.toISOString(),
    });

    const finalMessages =
      composedSystem.length > 0
        ? [{ role: "system" as const, content: composedSystem }, ...tagged]
        : tagged;

    // Target the same rail chat.ts uses: gateway → engine, otherwise
    // LiteLLM. Mirror the routing logic so the prewarm hits the cache
    // slot the real chat will fill.
    const prewarmMode: "gateway" | "hybrid" | "legacy" =
      user.litellmDisabled && user.engineUrl
        ? "gateway"
        : ((user.engineMode ?? "legacy") as
            | "gateway"
            | "hybrid"
            | "legacy");
    if (prewarmMode === "legacy" && user.litellmDisabled) {
      // No rail available — skip prewarm rather than 503'ing the UI.
      return c.json({ ok: false, reason: "no_provider" });
    }
    const target =
      prewarmMode === "gateway" && user.engineUrl
        ? {
            baseUrl: user.engineUrl.replace(/\/+$/, ""),
            apiKey: user.engineToken,
          }
        : {
            baseUrl: (
              user.litellmUrl ??
              process.env.LITELLM_URL ??
              "http://192.168.86.44:4000"
            ).replace(/\/+$/, ""),
            apiKey:
              user.litellmApiKey ?? process.env.LITELLM_API_KEY ?? null,
          };

    const upstreamBody: Record<string, unknown> = {
      model: opts.model,
      stream: false,
      max_tokens: 1,
      messages: finalMessages,
    };

    // Fire-and-forget. Don't block the response; the frontend doesn't care
    // about the result. Errors are logged but not surfaced.
    fetch(`${target.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(target) },
      body: JSON.stringify(upstreamBody),
      // 60s ceiling — cold prefill of a long prompt on a 397B can take 30-50s.
      // We don't wait, but the underlying socket will eventually hang up.
      signal: AbortSignal.timeout(120_000),
    }).catch((err: Error) => {
      // Aborted/timed-out prewarms are normal under load — don't spam logs.
      if (err.name !== "AbortError" && err.name !== "TimeoutError") {
        console.warn("[prewarm] failed:", err.message);
      }
    });

    return c.json({ ok: true, scheduled: true, msgs: msgRows.length });
  },
);

// Force a memory recompile + re-snapshot for this conversation. Triggered by
// the "Remember now" button in the UI. Synchronous — we wait for the compile
// to finish, then re-fetch the wiki context and store it as the conversation's
// snapshot. Future turns will use the refreshed memory.
conversationsRoute.post("/:id/refresh-memory", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [conv] = await db
    .select({
      userId: conversations.userId,
      projectId: conversations.projectId,
      memoryEnabled: conversations.memoryEnabled,
    })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  if (!conv || conv.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  if (conv.memoryEnabled === false) {
    return c.json(
      { ok: false, reason: "memory_disabled" },
      400,
    );
  }
  // 1. Run the compile pass (consolidate this conversation into the wiki)
  const ok = await compileNow(userId, id);
  // 2. Re-fetch the wiki context — even if the compile partially failed, the
  //    DB may still contain newer articles than our snapshot.
  const fresh = await getMemoryContext(userId, conv.projectId);
  await db
    .update(conversations)
    .set({
      memorySnapshot: fresh || null,
      memorySnapshotAt: new Date(),
    })
    .where(eq(conversations.id, id));
  return c.json({
    ok,
    memorySnapshot: fresh,
    memorySnapshotAt: new Date().toISOString(),
  });
});

export default conversationsRoute;

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
import {
  buildSystemPrompt,
  tagUserMessages,
} from "../lib/prompt-builder";

const conversationsRoute = new Hono();

const createSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  projectId: z.string().uuid().optional(),
  model: z.string().max(200).optional(),
  /** 'chat' (default) or 'talk' — chooses the layout + routing path
   *  on send. The legacy 'hermes' kind was retired 2026-05-19; the
   *  schema enum keeps it only to tolerate stale clients (we coerce
   *  to 'chat' below). */
  kind: z.enum(["chat", "talk", "hermes"]).optional(),
  /** Legacy field from the Hermes era. Accepted but ignored. */
  repoPath: z.string().min(1).max(500).optional(),
  /** Explicit memory-toggle override. Without this, the conversation
   *  inherits `projects.memoryEnabled` when projectId is set, else
   *  defaults to true. UI uses this so the user can pre-toggle memory
   *  OFF before sending the first message on a new top-level chat. */
  memoryEnabled: z.boolean().optional(),
  /** Explicit agent-mode (tools) override, mirroring memoryEnabled — lets the
   *  UI persist a tools ON/OFF flip made on a blank chat before the first
   *  message. Without it the new conversation defaults to agentMode=false. */
  agentMode: z.boolean().optional(),
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
  agentMode: z.boolean().optional(),
  /** 'hermes' | 'pi' | 'openclaude' | null. Null clears the persistent
   *  agent-mode flag — composer goes back to normal LLM chat. */
  activeAgent: z.string().max(40).nullish(),
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
      agentMode: conversations.agentMode,
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

    // Resolve memory toggle.
    //   1. If the caller passed `memoryEnabled` explicitly, that wins —
    //      lets the chat UI pre-toggle OFF before the conv exists, and
    //      lets MCP clients (Cowork etc.) override the inherited value.
    //   2. Otherwise inherit from the parent project (if any).
    //   3. Otherwise default to true.
    // When memory ends up off we skip the wiki snapshot (no point paying
    // for a memory-service round-trip the route won't use).
    let memoryEnabled = true;
    if (typeof data.memoryEnabled === "boolean") {
      memoryEnabled = data.memoryEnabled;
    } else if (data.projectId) {
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
    // Coerce legacy kind='hermes' (and anything outside 'chat'/'talk')
    // to plain 'chat' — Hermes integration retired 2026-05-19.
    const kind = data.kind === "talk" ? "talk" : "chat";
    const defaultTitle = kind === "talk" ? "New talk" : "New conversation";
    const [row] = await db
      .insert(conversations)
      .values({
        userId,
        title: data.title ?? defaultTitle,
        projectId: data.projectId,
        model: data.model,
        kind,
        repoPath: null,
        memoryEnabled,
        // #28 — honour a pre-first-message agent-mode (tools) flip.
        agentMode: data.agentMode ?? false,
        memorySnapshot: memorySnapshot || null,
        memorySnapshotAt: memorySnapshot ? new Date() : null,
      })
      .returning();
    return c.json({ conversation: row }, 201);
  },
);

/**
 * Active streams across all the user's conversations. Drives the
 * sidebar / NavBar parallel-stream indicator. **Must be declared
 * before `/:id`** — Hono's router matches in declaration order, and
 * `/:id` is greedy enough to capture the literal "active" otherwise,
 * which then hits the DB as `id='active'` → "invalid uuid syntax" 500s.
 * Each failing /active fetch from the sidebar made the frontend think
 * the active stream list was gone and rolled back the optimistic
 * assistant message — symptom: "the response appears then disappears".
 */
conversationsRoute.get("/active", async (c) => {
  const userId = c.get("userId");
  return c.json({ active: listActiveForUser(userId) });
});

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
      data.agentMode !== undefined ||
      data.activeAgent !== undefined ||
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
    // Cache-warmth heuristic: if the last assistant message landed in the
    // recent past, the upstream's internal prefix cache (Inferencer,
    // mlx-vlm, Odysseus session) is still warm — re-prewarming would just
    // queue another 50KB-prefill call behind the active chat / compile /
    // next-turn, slowing everything. Skip in that case.
    //
    // The frontend re-fires prewarm on every (sending → false) and on
    // every messages.length change, so without this guard we hit the
    // upstream once per chat turn for nothing. With a 10-minute window
    // we still warm cold conv reopens and post-restart situations.
    const PREWARM_SKIP_IF_RECENT_S = Number(
      process.env.PREWARM_SKIP_IF_RECENT_S ?? 600,
    );
    let lastAssistantAt: Date | null = null;
    for (let i = msgRows.length - 1; i >= 0; i--) {
      if (msgRows[i].role === "assistant") {
        lastAssistantAt = msgRows[i].createdAt;
        break;
      }
    }
    if (
      PREWARM_SKIP_IF_RECENT_S > 0 &&
      lastAssistantAt &&
      Date.now() - lastAssistantAt.getTime() < PREWARM_SKIP_IF_RECENT_S * 1000
    ) {
      const ageS = Math.round(
        (Date.now() - lastAssistantAt.getTime()) / 1000,
      );
      console.log(
        `[prewarm] conv=${id.slice(0, 8)} skipped — last assistant ${ageS}s ago (cache warm)`,
      );
      return c.json({ ok: false, reason: "cache_recent", age_s: ageS });
    }
    // Skip when an inference is ALREADY in flight on this conv. The
    // frontend refires prewarm on every `sending → false` transition,
    // and on heavy models (Argo 397B, 4-node pipeline, etc.) successive
    // turns can overlap: turn N's prewarm fires while turn N-1 is still
    // prefilling. The result was the screenshot users reported —
    // 3 concurrent runs on argo-2, two with max_tokens=1, all stuck in
    // prefill behind each other because the pool serializes. Dropping
    // the redundant prewarm clears the queue and the real chat lands
    // immediately.
    const inflight = getInferenceStatus(id, userId);
    if (inflight.active) {
      console.log(
        `[prewarm] conv=${id.slice(0, 8)} skipped — inference in flight`,
      );
      return c.json({ ok: false, reason: "inference_active" });
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

    // Memory: read the Karpathy-style compiled wiki for SYSTEM-prompt
    // injection. Same source as chat.ts uses; bound to the conversation's
    // memoryEnabled flag so prewarm prefix matches what chat will send.
    let memoryBlock = "";
    if (conv.memoryEnabled !== false) {
      memoryBlock = await getMemoryContext(userId, conv.projectId);
    }

    // System prompt + user-message tags via the shared builder. This is
    // the single source of truth for both prewarm and chat — byte-stable
    // by construction, no more "must match chat.ts" comment to enforce
    // by hand. Builder details in server/lib/prompt-builder.ts.
    const composedSystem = buildSystemPrompt({
      userSystemPrompt: opts.system_prompt,
      projectMemory: memoryBlock,
      globalMemory: null,
    });

    const tz = user.timezone || "Europe/Brussels";
    type WireMsg = { role: string; content: string; createdAt?: string };
    // Build a tag-ready intermediate (Date instances) so the builder gets
    // the same types chat.ts feeds it.
    const ready = msgRows.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    }));
    const taggedRich = tagUserMessages(ready, {
      enabled: conv.memoryEnabled !== false,
      timezone: tz,
    });
    // The wire schema needs string ISO createdAts and string content.
    const tagged: WireMsg[] = taggedRich.map((m) => ({
      role: m.role,
      content: typeof m.content === "string"
        ? m.content
        // Persisted msg rows are always string today — but be defensive
        // if a future schema lets multimodal through.
        : JSON.stringify(m.content),
      createdAt: m.createdAt instanceof Date
        ? m.createdAt.toISOString()
        : (m.createdAt || ""),
    }));

    // Whether to append a synthetic dummy user message. LiteLLM (and most
    // upstream engines) require messages to end with `user`. Odysseus'
    // runner does NOT — it just renders via apply_chat_template with
    // add_generation_prompt=True, which works whether the last message is
    // user or assistant. We decide AFTER computing prewarmMode below.
    const needsDummyUser = (mode: "gateway" | "hybrid" | "legacy") =>
      mode !== "gateway";

    // Recover the last user message's createdAt so the dummy can chain
    // a sensible Δ in its tag — the shared builder doesn't expose it,
    // but it's trivial to find from msgRows.
    const timeTagsEnabled = conv.memoryEnabled !== false;
    const lastUserAt: Date | null = (() => {
      for (let i = msgRows.length - 1; i >= 0; i--) {
        if (msgRows[i].role === "user") return msgRows[i].createdAt;
      }
      return null;
    })();

    function withDummy(): WireMsg[] {
      const out = [...tagged];
      const dummyAt = new Date();
      const content = timeTagsEnabled
        ? `${buildTag({ now: dummyAt, previous: lastUserAt, timezone: tz })} .`
        : ".";
      out.push({
        role: "user",
        content,
        createdAt: dummyAt.toISOString(),
      });
      return out;
    }

    // Target the same rail chat.ts uses: gateway → engine, otherwise
    // LiteLLM. (Hybrid uses LiteLLM for inference, engine only for caps.)
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
    // History note: prewarm was previously disabled in gateway mode because
    // appending a synthetic dummy_user message with a fresh timestamp tag
    // caused `fp16·divergent` on Odysseus (the dummy's tag never matched
    // the real next user's tag, polluting the session slot). Re-enabled
    // 2026-05-16 along with two safeguards:
    //   1. The MEMORY_MAX_BYTES cap on the memory block — keeps prewarm +
    //      chat in sync as the wiki grows
    //   2. Don't append a dummy_user at all when targeting gateway —
    //      Odysseus' runner accepts assistant-last messages (templates
    //      with add_generation_prompt=True), so the prewarm tokens are
    //      a strict prefix of the real next chat's tokens.
    //
    // If divergence shows up again, the runner's new fine-grained labels
    // (fp16·cold|model-changed|divergent|hit-truncated) will pinpoint it.
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
              ""
            ).replace(/\/+$/, ""),
            apiKey: user.litellmApiKey ?? process.env.LITELLM_API_KEY ?? null,
          };

    // In gateway mode we can send assistant-last (Odysseus templates with
    // add_generation_prompt=True). In hybrid/legacy we must end with user
    // (LiteLLM passthrough enforces it for most upstream engines).
    const finalMessages = (() => {
      const msgs = needsDummyUser(prewarmMode) ? withDummy() : tagged;
      return composedSystem.length > 0
        ? [{ role: "system" as const, content: composedSystem }, ...msgs]
        : msgs;
    })();

    const upstreamBody: Record<string, unknown> = {
      model: opts.model,
      stream: false,
      max_tokens: 1,
      messages: finalMessages,
      // Pin the prefix-cache slot to this conversation id so the real
      // chat turn that follows reuses the KV cache populated here.
      // Odysseus reads `session_id` from the body; LiteLLM ignores
      // unknown fields, so it's safe to send unconditionally.
      session_id: id,
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

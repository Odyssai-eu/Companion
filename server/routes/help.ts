/**
 * /help slash command backend.
 *
 *   POST /api/help/ask
 *     body: { question: string, conversationId?: string }
 *     SSE response: the LLM answer, streamed token-by-token.
 *     Each event:
 *       event: chunk      data: { text: "..." }
 *       event: sources    data: { articles: [{slug, title, score}, ...] }
 *       event: done       data: { stats: {...} }
 *
 * Critical design choice: the conversation context is **stripped**.
 * /help is a one-shot RAG query over the wiki, not a follow-up to the
 * chat. If Némo is mid-discussion about the user's code, /help should
 * NOT see that context — otherwise the answer drifts away from the
 * docs.
 *
 * Flow:
 *  1. BM25 search over user-guide/*.md → top-K articles
 *  2. Build a strict system prompt + the K articles as context
 *  3. Stream completion from the user's chat-bucket model (from Auto Router)
 *     or fall back to the conversation's own model
 *  4. Persist the answer on the conversation with `stats.helpFrom = [slugs]`
 *     so the UI can render a "Help · from: …" chip.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Agent, fetch as undiciFetch } from "undici";
import { db } from "../db/index";
import { conversations, messages } from "../db/schema";
import {
  providerTarget,
  resolveUserSettingsById,
} from "../lib/global-settings";
import { authHeaders } from "../lib/litellm";
import { searchCorpus, corpusInfo, type HelpHit } from "../lib/help-search";

type Env = { Variables: { userId: string } };
const helpRoute = new Hono<Env>();

// ── Config ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Companion's in-app help assistant. Your job is to answer the user's question using ONLY the wiki excerpts provided below.

Rules:
- Answer ONLY from the wiki context. Do NOT use general knowledge.
- If the wiki doesn't cover the question, say so explicitly: "I couldn't find this in the wiki." Then point to the docs site: https://odyssai.eu/docs/.
- Cite which articles you used (by slug) at the end: "From: <slug-1>, <slug-2>".
- Be concise. The user is in a chat composer, not reading a manual.
- Stay in the user's language (French / English / mixed — match what they asked).
- Don't reproduce the wiki verbatim. Synthesize.

You are NOT chatting. You are NOT continuing a conversation. This is a single-shot lookup.`;

// Dedicated undici agent for help LLM calls — same shape as the chat route.
// Help queries should be fast (small context, small answer); keep a tight
// connect timeout but allow plenty of body time for slow first-token paths.
const helpDispatcher = new Agent({
  connect: { timeout: 10_000 },
  headersTimeout: 120_000,
  bodyTimeout: 0,
});

const askSchema = z.object({
  question: z.string().min(1).max(2000),
  /** Optional — persist the Q&A to a conv if provided. /help works
   *  without a conv too (a fresh conv is NOT created automatically; we
   *  return the SSE stream and skip persistence). */
  conversationId: z.string().uuid().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────

function buildContext(hits: HelpHit[]): string {
  if (hits.length === 0) return "(no relevant wiki articles found)";
  const parts: string[] = [];
  for (const h of hits) {
    // Truncate article bodies to a sane size for the context window. Most
    // articles are 100-200 lines; cap at ~6000 chars each to keep the
    // total context under ~30 KB.
    const body = h.body.length > 6000 ? h.body.slice(0, 6000) + "\n… (truncated)" : h.body;
    parts.push(`# ${h.title} (slug: ${h.slug})\n\n${body}`);
  }
  return parts.join("\n\n---\n\n");
}

async function resolveHelpModel(userId: string): Promise<{
  model: string;
  baseUrl: string;
  apiKey: string | null;
}> {
  // v2.1 — CoeOS is the router: help answers go to the CoeOS virtual
  // model when an engine is paired (it classifies "quick doc question"
  // onto a fast axis itself), else the resolved default model.
  const u = await resolveUserSettingsById(userId);
  if (!u) throw new Error("user_not_found");

  const model = u.engineUrl
    ? "CoeOS"
    : u.defaultModel || process.env.HELP_DEFAULT_MODEL || "";
  if (!model) throw new Error("no_model_for_help");

  // Route through the same target the chat route uses: engine when
  // gateway mode, else LiteLLM.
  const target = providerTarget(u);
  return { model, baseUrl: target.baseUrl, apiKey: target.apiKey };
}

// ── Route ─────────────────────────────────────────────────────────────────

helpRoute.get("/status", async (c) => {
  const info = corpusInfo();
  return c.json({
    indexed: info.count,
    loadedFrom: info.loadedFrom,
  });
});

helpRoute.post("/ask", zValidator("json", askSchema), async (c) => {
  const userId = c.get("userId");
  const { question, conversationId } = c.req.valid("json");

  // Authz on conv if provided
  if (conversationId) {
    const [conv] = await db
      .select({ userId: conversations.userId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!conv || conv.userId !== userId) {
      return c.json({ error: "not_found" }, 404);
    }
  }

  // BM25 search — top 3 articles is usually enough at this corpus size.
  const hits = searchCorpus(question, 3);

  // Resolve the help LLM target
  let target: { model: string; baseUrl: string; apiKey: string | null };
  try {
    target = await resolveHelpModel(userId);
  } catch (e) {
    return c.json(
      { error: "model_unresolvable", detail: (e as Error).message },
      500,
    );
  }
  if (!target.baseUrl) {
    return c.json(
      {
        error: "no_inference_target",
        detail:
          "Configure an engine (Settings → Inference) or a LiteLLM URL " +
          "before using /help — the help LLM needs somewhere to run.",
      },
      400,
    );
  }

  // Build the strict help prompt. Conversation context is NOT included.
  const contextBlock = buildContext(hits);
  const systemPrompt = `${SYSTEM_PROMPT}\n\n--- Wiki excerpts ---\n\n${contextBlock}`;

  const body = {
    model: target.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ],
    stream: true,
    temperature: 0.2,
    max_tokens: 2048,
  };

  // Open SSE stream to the upstream model
  const upstream = await undiciFetch(`${target.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders({ baseUrl: target.baseUrl, apiKey: target.apiKey }),
    },
    body: JSON.stringify(body),
    dispatcher: helpDispatcher,
  });

  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => "");
    return c.json(
      {
        error: "upstream_error",
        status: upstream.status,
        detail: txt.slice(0, 500),
      },
      502,
    );
  }

  // Stream the SSE through to the client, with two extra events injected:
  // - `sources` (first) — tells the UI which articles we used
  // - `done` (last) — closes the stream with stats
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let accumulated = "";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Emit sources up front so the UI can render the chip
      // immediately, before any text arrives.
      const sourceList = hits.map((h) => ({
        slug: h.slug,
        title: h.title,
        score: Number(h.score.toFixed(3)),
      }));
      controller.enqueue(
        encoder.encode(
          `event: sources\ndata: ${JSON.stringify({ articles: sourceList })}\n\n`,
        ),
      );

      const reader = upstream.body!.getReader();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Process SSE blocks (separated by blank lines)
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            if (!block.trim()) continue;
            // Forward verbatim
            controller.enqueue(encoder.encode(block + "\n\n"));
            // Parse for persistence
            for (const line of block.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (data === "[DONE]") continue;
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content ?? "";
                if (delta) accumulated += delta;
              } catch {
                /* ignore non-JSON */
              }
            }
          }
        }
      } catch (e) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`,
          ),
        );
      } finally {
        // Persist if a conv was provided
        if (conversationId && accumulated) {
          try {
            await db.insert(messages).values({
              conversationId,
              role: "assistant",
              content: accumulated,
              stats: {
                helpFrom: hits.map((h) => h.slug),
                helpTitles: hits.map((h) => h.title),
                model: target.model,
                isHelp: true,
              },
            });
            await db
              .update(conversations)
              .set({ updatedAt: new Date() })
              .where(eq(conversations.id, conversationId));
          } catch (e) {
            console.error("[help] persist failed:", e);
          }
        }
        controller.enqueue(
          encoder.encode(
            `event: done\ndata: ${JSON.stringify({ chars: accumulated.length, model: target.model })}\n\n`,
          ),
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
});

export default helpRoute;

// Conversation context resolution (project + memory snapshot + RAG) —
// extracted from chat.ts (#31, WU2). Pure "resolve and return": reads userId +
// body, queries the conv/project rows + memory tiers, returns the 9 derived
// values. Nothing downstream feeds back in.

import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { conversations, projects } from "../db/schema";
import { getMemoryContext, nemoQuery } from "./memory";
import { getProjectMemoryContext } from "./project-memory";

/** Shape resolveConvContext reads off the request body. Formerly exported
 *  by the v1 chat route (removed 2026-08-04); inlined here since this is
 *  now the only consumer and the v3 processor calls in with the same
 *  fields. */
export type ChatBody = {
  conversationId?: string;
  messages?: Array<{ role: string; content: string | unknown }>;
  model?: string;
  system_prompt?: string;
};

// Smart-skip (#36, item 3): for clearly-trivial turns (greetings, short acks)
// we skip the WHOLE memory fetch+injection — no nemoQuery, no wiki/vault dump,
// no round-trip. Saves latency and keeps the prompt lean. CONSERVATIVE by
// design: over-skipping silently loses memory the user wanted, so when in
// doubt we inject (return false).
//
// A turn is trivial when it is EITHER very short (≤ TRIVIAL_MAX_WORDS words AND
// ≤ TRIVIAL_MAX_CHARS chars after trim) OR an exact match (case/punctuation
// insensitive) against the small greeting/ack set below. Anything that carries
// a real question — a "?", a longer sentence — falls through to injection.
const TRIVIAL_MAX_WORDS = 4;
const TRIVIAL_MAX_CHARS = 24;
// Exact-match greeting/ack set (normalised: lowercased, trailing punctuation
// stripped). Kept deliberately small — only phrases that NEVER need memory.
const TRIVIAL_PHRASES = new Set<string>([
  "bonjour", "salut", "coucou", "hi", "hello", "hey", "yo",
  "merci", "merci beaucoup", "thanks", "thank you", "thx", "ty",
  "ok", "okay", "ok merci", "d'accord", "daccord",
  "yes", "no", "oui", "non", "yep", "nope", "yeah",
  "bye", "au revoir", "ciao", "a plus", "cool", "nice", "super",
  "👍", "🙏", "👌", "🙂",
]);

/** Conservative triviality check for the smart-skip path. Returns true only for
 *  clearly-trivial turns where injecting memory is pointless. When unsure,
 *  returns false so memory is still injected. */
export function isTrivialTurn(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return true; // empty turn — nothing to retrieve against
  // A question mark almost always signals a real ask → never trivial.
  if (trimmed.includes("?")) return false;
  // Normalise for the phrase set: lowercase + strip surrounding punctuation.
  const normalised = trimmed
    .toLowerCase()
    .replace(/^[\s.,!;:¡¿]+|[\s.,!;:]+$/g, "");
  if (TRIVIAL_PHRASES.has(normalised)) return true;
  // Very short turns with no question: greetings/acks not in the set
  // ("ok then", "merci !"). Require BOTH the word and char ceilings.
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length <= TRIVIAL_MAX_WORDS && trimmed.length <= TRIVIAL_MAX_CHARS) {
    return true;
  }
  return false;
}

export type ConvContext = {
  projectId: string | null;
  projectCwd: string | null;
  memoryBlock: string;
  ragBlock: string;
  convKind: "chat" | "talk";
  projectGlobalReadOnly: boolean;
  projectDedicatedMemoryEnabled: boolean;
  convMemoryEnabled: boolean;
  convAgentMode: boolean;
  /** v2.0 agent socle frozen at conv creation. Null on pre-v2 convs. */
  agentPromptSnapshot: string | null;
};

export async function resolveConvContext(
  userId: string,
  body: ChatBody,
  // Per-user memory mode (#29). 'advanced' (default) = RAG path (nemoQuery,
  // embeddings, Qdrant). 'basic' = wiki/vault path only (getMemoryContext) —
  // never calls nemoQuery, even when the nemo service is up.
  memoryMode: "basic" | "advanced" = "advanced",
): Promise<ConvContext> {
  let projectId: string | null = null;
  // Working directory for local-agent tool execution. null → companion-local
  // uses its default (~/companion). A project can override it via its picker.
  let projectCwd: string | null = null;
  let memoryBlock = "";
  // Per-turn RAG retrieval (#30). Rides WITH the question at the END of the
  // sequence — never in the system prompt (a per-turn block there invalidates
  // the KV prefix of the whole conversation history: measured 8% cache hit,
  // TTFT 113s on 6.9k tok). Injected into the outgoing copy of the last user
  // message only; never persisted.
  let ragBlock = "";
  let convKind: "chat" | "talk" = "chat";
  // Project-level memory toggles. When the conv belongs to a project,
  // we pull these from `projects` and use them to gate global-wiki
  // injection AND the inactivity-compile registration.
  let projectGlobalReadOnly = false;
  let projectDedicatedMemoryEnabled = false;
  let convMemoryEnabled = true;
  // Per-conversation agent mode. False by default → no tool defs injected,
  // streaming works on jaccl, ~250-token prompts. User flips on per-conv
  // when they want agentic behaviour (fs / rag / web / mcp).
  let convAgentMode = false;
  // v2.0 agent socle — the primary agent's system prompt frozen at conv
  // creation. Null on pre-v2 conversations (they keep the old prompt
  // composition, byte-stable) — no lazy backfill: injecting a socle into
  // an existing conv mid-life would shift its prompt prefix and dump its
  // KV cache for no user-visible gain.
  let agentPromptSnapshot: string | null = null;
  if (body.conversationId) {
    try {
      const [conv] = await db
        .select({
          projectId: conversations.projectId,
          userId: conversations.userId,
          memorySnapshot: conversations.memorySnapshot,
          memoryEnabled: conversations.memoryEnabled,
          agentMode: conversations.agentMode,
          kind: conversations.kind,
          agentPromptSnapshot: conversations.agentPromptSnapshot,
        })
        .from(conversations)
        .where(eq(conversations.id, body.conversationId))
        .limit(1);
      if (conv && conv.userId === userId) {
        projectId = conv.projectId;
        agentPromptSnapshot = conv.agentPromptSnapshot;
        // Defensive: legacy rows with kind='hermes' are treated as
        // regular 'chat' now that the Hermes integration is retired.
        // Migration 0037 normalises the column, but we coerce here in
        // case a stale row slips through.
        convKind = conv.kind === "talk" ? "talk" : "chat";
        convMemoryEnabled = conv.memoryEnabled !== false;
        convAgentMode = conv.agentMode === true;

        // Two-toggle composition (simplified layout):
        //   memoryEnabled            = "Global wiki" toggle. Conv-level
        //                              switch on whether the global user
        //                              wiki is injected at all.
        //   projects.dedicatedMemoryEnabled
        //                            = "Project wiki" toggle (project-level).
        //   projects.globalMemoryReadOnly
        //                            = Read-only sub-toggle under Global.
        //                              Only meaningful when global is on.
        //
        // The two main flags compose independently — you can have one,
        // both, or neither. The previous version coupled them ("project
        // ON disables global unless read-only ON"); the new model treats
        // them as orthogonal so the UI radio collapses cleanly into two
        // checkboxes.
        let dedicated = false;
        let globalReadOnly = false;
        let projectTeamId: string | null = null;
        if (projectId) {
          const [proj] = await db
            .select({
              dedicatedMemoryEnabled: projects.dedicatedMemoryEnabled,
              globalMemoryReadOnly: projects.globalMemoryReadOnly,
              teamId: projects.teamId,
              workingDir: projects.workingDir,
            })
            .from(projects)
            .where(eq(projects.id, projectId))
            .limit(1);
          if (proj) {
            dedicated = proj.dedicatedMemoryEnabled;
            globalReadOnly = proj.globalMemoryReadOnly;
            projectGlobalReadOnly = globalReadOnly;
            projectDedicatedMemoryEnabled = dedicated;
            projectTeamId = proj.teamId ?? null;
            projectCwd = proj.workingDir ?? null;
          }
        }

        // Project memory is a RAG tier now (collection = projectId in nemo,
        // fed by the project compiler). The raw vault dump below survives
        // only as the cold-start fallback while the collection is empty —
        // see the "## Project memory" marker check after the RAG query.
        let projectMemory = "";

        // Memory split for KV-cache stability (#30):
        //   ragBlock    = per-turn semantic retrieval (user/team/project/
        //                 company tiers) — VARIABLE, goes with the question
        //                 at the end of the sequence, never in system.
        //   memoryBlock = stable-per-conversation fallbacks only (raw
        //                 wiki/vault while the RAG is cold) — cacheable,
        //                 stays in the system prompt.
        let stableFallback = "";
        // Last user message + triviality — computed once so BOTH the user/global
        // fetch (below) and the project-tier fallback (further down) honour
        // smart-skip: a trivial turn ("ok merci") injects nothing at all (#36).
        const lastUserMsg = body.messages
          ?.filter((m: { role: string }) => m.role === "user")
          .at(-1);
        const query =
          typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
        const trivialTurn = isTrivialTurn(query);
        if (convMemoryEnabled) {
          if (trivialTurn) {
            // Smart-skip (#36, item 3): trivial turn → no memory fetch at all.
            // Leave ragBlock/stableFallback/memoryBlock empty. This does NOT
            // touch the byte-stability/KV invariant for non-trivial turns — it
            // is purely an early skip of the variable per-turn injection.
            console.log("[memory] smart-skip: trivial turn, no injection");
          } else if (memoryMode === "basic") {
            // Basic mode (#29): force the wiki/vault path ONLY. Never call
            // nemoQuery — no embeddings, no Qdrant, no /embed — even when the
            // nemo service is available. The full wiki+vault dump is stable
            // per conversation → safe in the system prompt (capped downstream).
            stableFallback = await getMemoryContext(userId, projectId);
          } else {
            // Advanced mode: tiers fan out in parallel: user + team (team
            // project) + project (dedicated memory) + company.
            ragBlock = await nemoQuery(
              userId, query, projectId, projectTeamId,
              dedicated && projectId ? projectId : null,
            );
            if (!ragBlock) {
              // Cold start (empty index / service down): the raw wiki+vault
              // dump is stable per conversation → safe in the system prompt.
              stableFallback = await getMemoryContext(userId, projectId);
            }
          }
        }
        // Cold-start fallback for the project tier (independent of the
        // conv-level memory toggle, like the old vault injection): until
        // the project's RAG collection has content, inject the raw vault.
        // #36 smart-skip: skip the project vault fallback too on a trivial turn
        // (it lives outside the convMemoryEnabled block, so it needs its own guard).
        if (!trivialTurn && projectId && dedicated && !ragBlock.includes("## Project memory")) {
          projectMemory = await getProjectMemoryContext(projectId);
        }
        memoryBlock = [projectMemory, stableFallback]
          .filter((s) => s.trim().length > 0)
          .join("\n\n---\n\n");
      }
    } catch (err) {
      console.warn("[chat] memory lookup failed:", (err as Error).message);
    }
  }

  return {
    projectId, projectCwd, memoryBlock, ragBlock, convKind,
    projectGlobalReadOnly, projectDedicatedMemoryEnabled, convMemoryEnabled,
    convAgentMode, agentPromptSnapshot,
  };
}

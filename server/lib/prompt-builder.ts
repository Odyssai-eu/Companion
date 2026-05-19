/**
 * Single source of truth for system-prompt composition and user-message
 * time tagging. Used by:
 *   - server/routes/chat.ts        — real chat completion path
 *   - server/routes/conversations.ts — prewarm prefix builder
 *
 * Both paths used to inline the same logic side-by-side, with a comment
 * begging future maintainers to "match byte-for-byte". The 2026-05-18
 * audit (Companion side) flagged this as the biggest cache-stability
 * risk: every divergence (field order, separator, time tag rule, …)
 * busts the upstream KV prefix cache and turns prewarm into wasted work.
 *
 * This module pins the byte layout. All callers compose via the helpers
 * here; nobody re-implements the algorithm. The order matters:
 *
 *   1. tagUserMessages(messages, …)  → produces the final wire shape of
 *      user content (with time tags when enabled).
 *   2. buildSystemPrompt({...})      → produces the system message text.
 *
 * Each helper is pure (no DB / network) — callers fetch the inputs and
 * pass them in. That keeps tests trivial and the byte stability auditable.
 */

import { buildTag } from "./timetag";

// Local copy of the multimodal content shape — kept here so this module
// has no upstream coupling to a specific route. Identical to the one in
// chat.ts; if a third format appears (audio, tool_use blocks, …), update
// both in lockstep.
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

// ─── User-message tagging ───────────────────────────────────────────────

/**
 * Prepend a time tag to a user message's content, respecting both string
 * and multimodal (ContentPart[]) shapes. Pure function.
 */
export function prependTagToContent(
  content: string | ContentPart[],
  tag: string,
): string | ContentPart[] {
  if (typeof content === "string") {
    return `${tag} ${content}`;
  }
  // Multimodal: find the first text part and prepend; if none, add one.
  const out: ContentPart[] = [];
  let injected = false;
  for (const part of content) {
    if (!injected && part.type === "text") {
      out.push({ type: "text", text: `${tag} ${part.text}` });
      injected = true;
    } else {
      out.push(part);
    }
  }
  if (!injected) out.unshift({ type: "text", text: tag });
  return out;
}

export type TaggableMessage = {
  role: string;
  content: string | ContentPart[];
  createdAt?: string | Date | null;
};

/**
 * Apply time tags to every user message in `messages`, in the same way
 * chat.ts and conversations.ts always did:
 *
 *   stamp    = m.createdAt (or `now` fallback when absent)
 *   previous = previous user message's createdAt within this batch
 *
 * The tag depends only on the message's OWN stamp + the previous user's
 * stamp — never on the volatile `lastInteractionAt` from the user row.
 * That's the invariant that keeps a tag identical between the turn it's
 * sent live and the turn it's replayed as history.
 *
 * Gating: when `enabled=false` (memory disabled for this conv), no tag
 * is added — pure user content. Important because reasoning models
 * (Hy3, Qwen3 thinking, …) try to "explain" timestamps they don't need.
 *
 * Returns a NEW array; never mutates the input.
 */
export function tagUserMessages<M extends TaggableMessage>(
  messages: M[],
  opts: {
    enabled: boolean;
    timezone: string;
    /** Fallback when a user message has no createdAt. */
    nowFallback?: Date;
  },
): M[] {
  if (!opts.enabled) {
    return messages.slice();
  }
  const fallback = opts.nowFallback || new Date();
  const out: M[] = [];
  let lastUserAt: Date | null = null;
  for (const m of messages) {
    if (m.role !== "user") {
      out.push(m);
      continue;
    }
    const stamp = m.createdAt
      ? (m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt))
      : fallback;
    const tag = buildTag({
      now: stamp,
      previous: lastUserAt,
      timezone: opts.timezone,
    });
    out.push({
      ...m,
      content: prependTagToContent(m.content, tag),
    });
    lastUserAt = stamp;
  }
  return out;
}

// ─── System-prompt composition ──────────────────────────────────────────

/**
 * Compose the assistant's system prompt from its constituent segments,
 * in the canonical order. Empty segments are dropped. Separator is the
 * literal `\n\n---\n\n` (matches chat.ts and conversations.ts as of
 * 2026-05-18; do NOT change without updating both call paths AND
 * documenting the cache-bust window).
 *
 * Segment order (high → low priority for the model):
 *   1. userSystemPrompt   — the request body's system_prompt (highest precedence)
 *   2. projectMemory      — per-project corpus (dedicated project wiki)
 *   3. globalMemory       — user-level Karpathy wiki
 *   4. hermesRepoBinding  — Hermes-only working directory note
 *
 * Empty strings are skipped silently. All inputs are trimmed; an input
 * that becomes empty after trim is treated as absent.
 */
export function buildSystemPrompt(opts: {
  userSystemPrompt?: string | null;
  projectMemory?: string | null;
  globalMemory?: string | null;
  hermesRepoBinding?: string | null;
}): string {
  const segments: string[] = [];
  const push = (s: string | null | undefined) => {
    if (!s) return;
    const trimmed = s.trim();
    if (trimmed.length === 0) return;
    segments.push(trimmed);
  };
  push(opts.userSystemPrompt);
  // Project + global memory used to be concatenated together and pushed
  // as a single segment. That subtle difference vs. pushing them as two
  // separate segments would shift bytes; we preserve the original layout
  // (single combined block, joined with the same separator) when both
  // are present.
  const memCombined = [opts.projectMemory, opts.globalMemory]
    .map((s) => (s || "").trim())
    .filter((s) => s.length > 0)
    .join("\n\n---\n\n");
  if (memCombined.length > 0) segments.push(memCombined);
  push(opts.hermesRepoBinding);
  return segments.join("\n\n---\n\n");
}

/**
 * Convenience: build the Hermes working-directory binding string from a
 * repo path. Returns empty string when the path is absent. Pure.
 */
export function buildHermesRepoBinding(repoPath: string | null): string {
  if (!repoPath || !repoPath.trim()) return "";
  return (
    `# Working directory\n\nThis conversation is bound to the repo at: ` +
    `\`${repoPath}\`\n\n` +
    `Operate inside that directory unless explicitly told otherwise. ` +
    `Use \`cd ${repoPath}\` at the start of any bash command, or pass it ` +
    `as cwd to your tools.`
  );
}

/**
 * Message assembly for the chat completion path — extracted from
 * server/routes/chat.ts (issue #31) to keep that handler under 400 loc.
 *
 * This is the "phase 4/5" of the handler: inject time tags into user
 * messages, compose the system prompt, attach the per-turn RAG block to
 * the last user message of the outgoing copy, and prepend the system
 * message to produce `withSystem` — the array that goes upstream.
 *
 * The body is moved verbatim from the handler; the only additions are the
 * args destructure at the top and the `{ withSystem }` return at the
 * bottom. No behaviour change. The byte-stability invariant (system +
 * history identical across turns so the upstream KV prefix cache hits)
 * is preserved exactly — all composition still routes through the shared
 * prompt-builder helpers.
 */

import {
  buildSystemPrompt,
  prependTagToContent,
  tagUserMessages,
} from "./prompt-builder";
import { buildSkillsIndex } from "./tools";
import type { ChatBody, ChatTurn } from "../routes/chat";

export async function assembleMessages(args: {
  body: ChatBody;
  userRow: { timezone: string | null };
  userId: string;
  now: Date;
  convMemoryEnabled: boolean;
  memoryBlock: string | null;
  ragBlock: string | null;
}): Promise<{ withSystem: ChatTurn[] }> {
  const { body, userRow, userId, now, convMemoryEnabled, memoryBlock, ragBlock } =
    args;

  const tz = userRow.timezone || "Europe/Brussels";
  const taggedMessages = tagUserMessages(body.messages!, {
    enabled: convMemoryEnabled,
    timezone: tz,
    nowFallback: now,
  });
  const skillsIndex = await buildSkillsIndex(userId);
  const composedSystem = buildSystemPrompt({
    userSystemPrompt: body.system_prompt,
    // Today chat.ts already collapsed project + global into a single
    // memoryBlock above (joined with the same separator). Pass it as
    // projectMemory so the builder doesn't double-join — globalMemory
    // stays empty in this code path.
    projectMemory: memoryBlock,
    globalMemory: null,
    skillsIndex,
  });

  // #30 — attach the per-turn RAG block to the LAST user message of the
  // OUTGOING copy (taggedMessages entries are fresh objects). The client
  // and the DB never see it, so the persisted history stays byte-stable
  // and the upstream KV prefix (system + full history) survives every
  // turn; only the previous exchange + this block re-prefill.
  let upstreamMessages = taggedMessages;
  if (ragBlock) {
    let lastUserIdx = -1;
    for (let i = taggedMessages.length - 1; i >= 0; i--) {
      if (taggedMessages[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx >= 0) {
      upstreamMessages = taggedMessages.slice();
      const m = upstreamMessages[lastUserIdx];
      upstreamMessages[lastUserIdx] = {
        ...m,
        content: prependTagToContent(
          m.content,
          `${ragBlock}\n\n---\n`,
        ),
      };
    }
  }

  const withSystem =
    composedSystem.length > 0
      ? [
          { role: "system" as const, content: composedSystem },
          ...upstreamMessages,
        ]
      : upstreamMessages;

  return { withSystem };
}

# Chat basics

The core mechanics of every conversation. Read once, refer back when something doesn't behave like you expect.

## Sending messages

- **Enter** — send.
- **Shift+Enter** — newline inside the input.
- **Esc** — stop the current stream (the partial reply stays in the conversation).
- **⌘+Enter / Ctrl+Enter** — send AND open a new chat afterwards (chain a fresh turn).

The input bar shows the active model on the left and the **Send** button (cyan, Companion's only solid-cyan CTA) on the right. The paperclip opens the attachment picker; you can also drop files or paste images directly.

## Conversations

Each chat is a **conversation** — a list of messages bound to:

- A **model** (changeable mid-conversation; see Model picker).
- An optional **project** (inherits its system prompt + memory toggles).
- A frozen **memory snapshot** (taken at creation; refreshable via "Remember now").
- A **session_id** (= the conversation UUID), passed to OdyssAI-X for KV-cache reuse.

### New chat

- Top-left **Chat** button.
- ⌘N / Ctrl+N from anywhere.
- From an existing conversation, the same buttons.

If you're inside a project, the new conversation inherits the project. Outside a project, it's loose.

### Switching conversations

Click any row in the sidebar. The model + agent-mode + memory state of the chat header switches to that conversation's state.

### Rename

Hover row → pencil icon, or double-click the title in the chat header. Free-text, ≤200 chars. Auto-saved on blur.

### Pin

Hover row → 📌 icon. Pinned conversations float to the top of their date bucket. Pin order is FIFO within the pinned bunch.

### Move to project

Hover row → menu → **Move to project** → pick. The move only re-tags; messages and memory snapshot stay intact. Moving INTO a project applies that project's system prompt to the **next turn** (the existing replies keep their original prompt).

### Search

⌘K focuses the search box. Matches conversation title + last user message. To search inside the message body of older conversations, use *Settings → Extensions → Skills → Search memory* if you've enabled memory ingestion, or export the `.md` and grep it locally.

## Editing a message

Two paths:

- Hover a **user** bubble → pencil icon.
- **Double-click** the text of the user message.

In edit mode:

- The input bar swaps to edit mode (visible "Editing message" header).
- **⌘+Enter** to resend the edit.
- **Esc** to cancel and leave the original.

Editing a user message **truncates** the conversation server-side: every message *after* the edited one is permanently deleted, then the model runs the new turn from the edit. There's no branch tree. If you want to keep the alternative, copy the assistant reply somewhere before editing.

You can also **edit an assistant message** (hover → pencil). Useful for:

- Fixing a typo without re-rolling the whole turn.
- Removing a hallucinated paragraph before the next turn.
- Pre-injecting a tool-call result you want the model to see.

Edited assistant content is treated as part of the conversation history on the next turn — it counts toward the KV cache prefix.

## Regenerating

Click **Regenerate** under any assistant message → same truncation rule (everything after is dropped) → the model is re-invoked with the original prompt.

Two variants:

- Plain regenerate — same model, same params.
- Regenerate with… — opens a mini-picker to switch model OR sampling preset before re-rolling.

## Stop / resume

- **Esc** stops a stream. The partial reply is saved in the DB.
- The reply does NOT auto-resume. Hit **Regenerate** if you want more, or **Continue** in the action row (when the partial ends mid-sentence; sends a "continue from where you stopped" prompt without truncating).

## Stats row

When *Settings → Inference → Show metrics* is on, an info row appears under each assistant message:

```
TTFT 1.2s · Duration 14s · Prompt 8.4k tok · Completion 1.1k tok · Speed 78 tok/s · Cached 6.2k tok (74%) · Model <alias> — <concrete-model>
```

- **TTFT** = time-to-first-token (latency to first SSE event).
- **Cached** = tokens reused from the KV prefix cache (OdyssAI-X only; cloud providers ignore the field).
- **Speed** = tokens / second sustained over the streaming portion.
- **Model** = alias served — concrete (resolved via `x_odyssai.alias_for` when present).

Off by default — the bar feels like clutter once you've stopped tuning latency.

## Memory snapshot

Each conversation freezes the global + project memory at creation. That's why a chat started yesterday still sees yesterday's wiki even if you've edited it since.

To refresh the snapshot from inside the chat: **Remember now** in the per-conversation memory menu. Re-snapshots the wiki at the current state, applied to the *next* turn.

To opt out entirely for one conversation: flip the **Memory** toggle in the chat header off. The wiki isn't injected, the chat won't pollute the wiki on the next compile.

See *Memory* (10) for the full lifecycle.

## Agent mode

The chat header has a tools toggle. Default **off**.

- **Off**: no tool definitions sent to the model. Prompt overhead ~250 tokens. Streaming works freely on jaccl backends.
- **On**: the full agentic toolset (fs_*, rag_search, web_*, every enabled MCP server) is injected. Skills are always on regardless.

When on, the model may emit `tool_call` blocks during a reply. Companion executes them server-side and feeds the result back, then continues the reply. This is multi-step — a single user turn can produce several tool-calls + their results + the final reply, all under one assistant message.

## Conversation kinds

Two today, more later:

- **`chat`** (default) — text + multimodal, the everything chat.
- **`talk`** — Voice Live mode, no model picker, large-mic UI. See *Voice & talk* (08).

The legacy `hermes` kind has been retired (2026-05-19). Old rows are normalised to `chat` on read.

## Deleting

- **One conversation** — hover row → menu → Delete.
- **Several at once** — sidebar selection mode → check rows → Delete.
- Confirmation is required. No trash; deletes are immediate and cascade through `messages`.

## Related

- *The chat window* (04) — anatomy of the UI
- *Memory* (10) — the snapshot lifecycle
- *Model picker* (06) — switching models mid-chat
- *Inference settings* (14) — sampling, max tokens, thinking

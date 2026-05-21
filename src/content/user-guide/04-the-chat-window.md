# The chat window

Tour of the chat UI, region by region. Once you know what each element does, the rest of the guide makes sense.

## Layout overview

[The chat window with the model picker open](./screenshots/chat.png)

## Sidebar

**Top — Chat + Project buttons.** Two side-by-side; **Chat** creates a new conversation (in the active project if you're inside one, else loose), **Project** opens the project grid landing.

**Search.** ⌘K focuses. Matches conversation title + last user message text. Search is client-side over the cached list (instant), so very old conversations might not match until the sidebar pages them in (rare in practice).

**Conversation rows.** Grouped by date bucket (Today / Yesterday / Last week / Earlier). Each row shows:

- Title (auto-derived from first user message, editable on hover).
- Last user-message preview (truncated).
- A small dot 🟢 when a stream is in progress in that conversation (from any device).
- A pin icon when pinned (move to top).
- Project badge if inside one.

Hover a row → mini-menu: rename, move to project, pin, export `.md`, export `.json`, delete.

**Selection mode.** Click the multi-select icon to switch the sidebar into checkbox mode — bulk-delete is the main use case. Esc to exit.

**Bottom — Talk button.** Full-screen voice mode. Always pinned regardless of scroll position.

**Mobile.** The sidebar slides over the chat. Tap the backdrop or press Esc to close.

## Chat header

Left to right:

- **Model picker** — opens the model panel (see *Model picker*, 06). The label shows the active alias + the concrete model behind it (e.g. `argo — Hy3-preview-MLX-9bit`).
- **Agent mode** toggle — On = inject the full agentic toolset (fs_*, rag_search, web_*, MCP servers) into the chat. Off = lean prompt (~250 tokens of overhead), no tools sent to the model. Default off.
- **Memory** toggle — On = the conversation has injected its frozen memory snapshot. Off = no global wiki / project memory at all for this chat. See *Memory* (10).
- **Voice** icon — toggles auto-speak of assistant replies via Voxtral or Gemini Live.
- **⚙ cogwheel** — opens the per-conversation Inference settings panel (sampling, max tokens, thinking, system prompt). See *Inference settings* (14).

The header also shows a stats line for the active reply when **Show metrics** is on (Settings → Inference). Format: `TTFT 1.2s · Duration 14s · Prompt 8.4k tok · Completion 1.1k tok · Speed 78 tok/s · Cached 6.2k tok (74%) · Model argo — Hy3-preview-MLX-9bit`.

## Message rows

**User bubble (right).** Plain text or multimodal (image / pdf / code attachments shown as chips). Hover → pencil icon (edit) or double-click. Editing truncates the conversation downstream.

**Assistant bubble (left).** Markdown rendered. Code blocks have their own helper row (Copy, Save, Save all). Tool calls in agent mode show inline with their result. Thinking content (when `enable_thinking=true`) is collapsed by default behind a chevron.

**Action row under each assistant message.**

- **Regenerate** — re-run the same prompt. Truncates the conversation past this message first.
- **Copy** — full reply to clipboard.
- **Save** — export the reply as a `.md`.
- **Listen** / **Save WAV** — when voice mode is on.
- **Edit** — patch the assistant content in place (counts toward KV cache prefix next turn).

**Stats row** (when Show metrics on). Per-message TTFT, total duration, tok/s, cache hit.

## Input bar

- **📎 Paperclip** — attachment picker. Files, images, PDF. Multiple at once. See *Attachments* (07).
- **Text input** — multi-line, auto-grow. Markdown supported in your own messages (it's pass-through to the model).
- **Send** — the only solid-cyan CTA in the whole UI. By design — it's the action.
- **Stop** (during stream) — Send becomes Stop. Esc also works.

Drag a file onto the input from anywhere to attach. Paste an image from clipboard to attach.

## What the bar at the top of the page is NOT

- Not the inference settings (those live behind the ⚙ cogwheel in the chat header).
- Not the engine config (that's *Settings → Infrastructure*).
- Not the user menu (top-right avatar).

The chat header is **per-conversation runtime state**: which model is firing, agent mode for this chat, memory for this chat, voice for this chat. Account-wide settings are in Settings.

## Related

- *Chat basics* (05) — sending / editing / regenerating
- *Model picker* (06) — picking what's behind the chat
- *Inference settings* (14) — the cogwheel content
- *Shortcuts* (19) — full keyboard map

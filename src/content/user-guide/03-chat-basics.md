# Chat basics

## Sending messages

- **Enter** — send.
- **Shift+Enter** — newline inside the input.
- **Esc** — stop the current stream (the partial reply stays in the conversation).

The input bar shows the active model on the left and the **Send** button (cyan, Companion's only solid-cyan CTA) on the right. The paperclip opens the attachment picker; you can also drop files onto the input.

## Conversations

Each chat is a **conversation**: a list of messages bound to a model, optional project, and a frozen memory snapshot.

- **New chat** — top-left **Chat** button, or `Cmd/Ctrl+N`.
- **Switch conversation** — pick one in the sidebar. Hover for the menu: rename, move to project, export `.md`/`.json`, delete.
- **Search** — `Cmd/Ctrl+K` focuses the search box. Matches title + recent messages.

## Editing a message

- Hover a **user** bubble → pencil icon, or **double-click** the text.
- **Cmd/Ctrl+Enter** to resend, **Esc** to cancel.

Editing **truncates** the conversation server-side: every assistant reply (and any user message) downstream of the edit is permanently removed before the new turn runs. We don't keep a branch tree — if you want to compare alternatives, copy the previous reply first.

## Regenerating a reply

Click **Regenerate** under any assistant message. Same truncation rule: everything after that reply is dropped, then the model is re-invoked with the same prompt.

## Edit assistant replies

Hover an assistant bubble → pencil. Useful for fixing a typo or removing a hallucinated paragraph without re-rolling the whole turn. Edited assistant content is treated like model output on the next turn (counts toward the KV cache prefix).

## Stop / resume

- **Esc** stops a stream; the partial reply is saved.
- The reply doesn't auto-resume. Hit **Regenerate** to continue from the same prompt.

## Memory snapshot

Each conversation freezes the project + global memory at creation time. That's why a chat started yesterday still sees yesterday's wiki even if you've edited it since. Use the **memory** toggle in the conversation header to opt out of the snapshot for a specific chat.

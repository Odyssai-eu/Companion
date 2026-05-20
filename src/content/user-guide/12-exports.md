# Code blocks & exports

## Inline code blocks

Whenever the model returns a fenced code block, Companion adds a row of helpers under it:

- **One pill per block** with the inferred filename. We try the line immediately above the fence (`**bench.py**` style) before falling back to `file-N.{ext}`.
- **Copy** — straight to clipboard.
- **Save** — single-file download.

When the reply has **2 or more** code blocks, a **Save all (.zip)** action appears too. The ZIP keeps the inferred filenames; collisions get suffixed.

## Saving a whole reply

The **Save** button on an assistant message (action row under the reply) exports the reply as Markdown with code fences intact.

## Exporting a conversation

Hover the conversation in the sidebar → menu → **Export**. Two formats:

- **`.md`** — the full conversation as Markdown. Code fences preserved, attachments referenced (images get a data-URI fallback so the file is self-contained for small ones, an external link otherwise).
- **`.json`** — structured: messages, role, attachments, model, timestamps. Round-trippable if you want to import elsewhere.

You can also export over MCP with `companion_export_md(conversationId)`.

## Exporting a project

There's no one-shot "export project" today — the unit is the conversation. Export each conversation individually, or use the MCP `companion_list_conversations(projectId)` + `companion_export_md` loop.

## Exporting your data

- **Skills** — *Settings → Extensions → Skills* → per-row **Export** (ZIP per skill). Bulk export is on the roadmap.
- **Memory (global wiki)** — *Settings → Extensions → Add-ons → Obsidian* gives you a vault ZIP including the index files.
- **Conversations** — per-conversation Markdown / JSON as above.
- **Account** — admin-only today. Ask Sophie.

## Importing

- **Skills** — drop a `SKILL.md` or `.zip` on *Settings → Extensions → Skills*.
- **Memory** — push files into your Obsidian vault, re-index runs automatically.
- **Conversations** — no UI yet. Possible via the API but undocumented; tell us if you need it.

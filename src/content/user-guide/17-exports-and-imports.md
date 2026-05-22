# Exports & imports

How to get data in and out of Companion.

## Code blocks (per-reply)

Whenever the model returns a fenced code block, Companion adds a row of helpers under it:

- **One pill per block** with the inferred filename. Companion tries the line immediately above the fence (`**bench.py**` style) before falling back to `file-N.{ext}`.
- **Copy** — straight to clipboard.
- **Save** — single-file download.

When the reply has **2 or more** code blocks, a **Save all (.zip)** action appears too. The ZIP keeps the inferred filenames; collisions get suffixed (`bench.py`, `bench-2.py`).

## Saving a whole reply

The **Save** button in the action row of any assistant message → downloads the reply as Markdown with code fences intact. Filename: `<conv-title>-<message-id-short>.md`.

To save the entire conversation as one file, use the conversation export below.

## Exporting a conversation

Hover the conversation in the sidebar → menu → **Export**. Two formats:

- **`.md` — Markdown.** Full conversation with one section per turn. Code fences are preserved with their language hints. Attachments are embedded as data-URIs when small (< 100 KB) so the file is self-contained, or referenced as external paths for larger ones.
- **`.json` — structured.** Round-trippable if you want to import elsewhere or post-process. Schema-stable; field additions are non-breaking. Carries the conversation id, title, kind, timestamps, messages (role / content / per-message model + stats), the active model, project id, memory flag, etc.

You can also export over MCP with `companion_export_md(conversationId)` from external agents.

## Exporting a project

There's no one-shot "export project" today — the unit is the conversation. Two paths:

- **Manual**: export each conversation individually from the sidebar.
- **Scripted**: use the MCP `companion_list_conversations(projectId)` + `companion_export_md` loop.

On the roadmap: project ZIP with all conversations + project memory + system prompt.

## Exporting your data

| Data | Path | Format |
|---|---|---|
| Conversations | Sidebar menu → Export, or MCP | `.md` / `.json` per conv |
| Skills | Settings → Skills → per-row Export | `.zip` per skill |
| Memory (global wiki) | Settings → Add-ons → Obsidian → Export vault | `.zip` with Obsidian-formatted files |
| Project wiki | Project settings → Project vault → Export | `.zip` per project |
| Inference presets | (no UI export) — readable via `/api/inference/presets` | JSON |
| Account dump | Admin-only today | varies |

For a full account export: ask the admin. The cascade we'd run is `pg_dump` of your `user_id`-scoped rows across all tables.

## Importing

### Skills

Drop a `SKILL.md` or `.zip` on *Settings → Extensions → Skills → Import*. See *Skills* (11) for the format. Or paste to Némo and say "import this".

### Memory wiki

Push files into your Obsidian vault (the local copy syncs to the wiki via the Obsidian plugin's bearer-token bridge). Re-index runs automatically. Locked articles (`edited_by_user=true`) are not overwritten by your pushed file unless you flip the lock first.

To import from an external Karpathy wiki / Obsidian vault that you've never synced: copy the markdown files into your Obsidian vault under the right paths, push, re-index. There's no merge UI today — your import overrides whatever was there (still respecting locks).

### Conversations

No UI yet. Possible via the API (`POST /api/conversations` + `POST /api/conversations/:id/messages` in sequence) but undocumented. Tell us if you need it.

### MCP servers

Manual — *Settings → Extensions → MCP servers → Add*. Or seed via direct PG if you really need to bulk-import.

## Sharing a conversation

There's no built-in public-link for a conversation. Two paths:

- **Export as `.md`** → share the file via your usual channels.
- **Guest tokens** (admin-mint) → scope a guest to one conversation. They open the link and see a read-only or read-write view depending on the token. See *Account & devices* (03).

## Print

Browser print (⌘P) on a conversation page renders the conversation in a print-friendly stylesheet. Code fences are kept. Attachments are inlined where possible.

Not battle-tested for archival use — for that, export the `.md`.

## Related

- *Chat basics* (05) — per-message Save action
- *Agents tokens* (13) — MCP export
- *Privacy & data* (18) — what's in an export

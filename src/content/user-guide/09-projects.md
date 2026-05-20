# Projects

A **project** groups conversations under a shared system prompt, memory toggles, and (optionally) a project wiki. Think of it as a folder that also remembers context.

## When to use a project

- Recurring work on the same domain (a codebase, a research area, a writing piece).
- You want a custom system prompt that shouldn't leak into other chats.
- You want project-scoped memory the agent can write to without polluting your global wiki.

If you just need a one-off chat: don't bother with a project. Loose conversations live at the root of the sidebar.

## Creating a project

Top of the sidebar → **Project** button → opens the project grid landing.

Click the **+** tile at the end of the grid → new project form:

- **Name** — free text, ≤200 chars.
- **Category** (optional) — General, Writing, Code, Research, Personal. Picks a preset system prompt you can edit afterwards.
- **System prompt** (optional) — the prompt that every conversation in this project inherits.

The project lands as a new tile in the grid. Click it to open the project page.

## The project page

Top to bottom:

- **Back to projects** — return to the grid.
- **Title** (full-width, editable inline).
- **Status icons** — only the ones that are *on* show: system prompt set, global wiki enabled, read-only, project wiki, external vault. Quick visual of the project's memory shape.
- **Conversations list** — chats in this project, freshest first.
- **Project settings** panel — collapsible (button on the right). System prompt, memory toggles, project vault, sharing.

Conversations created from inside a project are tagged with it automatically. From outside, hover a conversation in the sidebar → menu → **Move to project** → pick.

## System prompt

The project's system prompt **overrides** any session-level system prompt for conversations in the project. Same model, different persona per project.

- It's stored server-side, travels with the account.
- Edits affect the *next* turn — already-running conversations keep their snapshot until the next message.
- For one-off persona overrides per conversation, use the system-prompt textarea in the chat's Inference settings (⚙ cogwheel). For named, reusable persona-prompts: create a **Skill** instead (see *Skills*, 11). Skills are the canonical home for named prompts.

## Memory toggles (per project)

Three independent flags:

- **`memoryEnabled`** — master switch for memory injection in this project's conversations. When off, no global wiki AND no project wiki is injected. Default ON.
- **`dedicatedMemoryEnabled`** — when on, the project's own `project_memory_files` corpus is injected. Default OFF.
- **`globalMemoryReadOnly`** — when on, the global wiki is injected but the conversations in this project are excluded from `triggerCompile` (no writes to the wiki). Default OFF.

The three compose independently — you can have any combination. Examples:

| memoryEnabled | dedicatedMemoryEnabled | globalMemoryReadOnly | Behaviour |
|---|---|---|---|
| ON | OFF | OFF | Default. Global wiki injected. Conversations compile back into it. |
| ON | ON | OFF | Both wikis injected. Both can be written to. |
| ON | OFF | ON | Global wiki injected, but no compile back. "Use the brain, don't pollute it." |
| ON | ON | ON | Both injected, only project wiki is writable. Clean isolation. |
| OFF | — | — | No memory at all. The project is just a system-prompt + chat container. |

When you flip these in project settings, the change applies to **new turns and new conversations**. Existing snapshots stay frozen until refreshed.

## Project wiki

If `dedicatedMemoryEnabled` is on, the project has its own wiki:

- **Where it lives** — rows in `project_memory_files`, scoped by `project_id`.
- **What goes in** — project-specific learnings: gotchas, decisions, vocabulary, infra notes, recurring snippets. Anything the agent should know *when working in this project* but shouldn't bleed elsewhere.
- **How the agent reads it** — substring grep alongside the global RAG when a conversation is bound to the project.
- **Who writes it** — you (via *Project settings → Project vault*) **or** the agent via `companion_remember(projectId, title, body)`.

Agent writes land under `agent-notes/<YYYY-MM-DD>-<slug>.md` so you can see what the agent added and prune at will.

## External vault path

`projects.externalVaultPath` — points the project at a filesystem directory on the gateway host (or another project via `tcai://project/<uuid>`). Read live every turn (no snapshot). Useful when you keep an Obsidian vault locally and want Companion to see edits immediately.

- Default read-only (toggle off → write-enabled, opt-in).
- The `tcai://` link shape is the **shared memory** mechanism: another project consents to be readable (via `sharingEnabled` on that project), you paste its `tcai://project/<uuid>` into your project's external vault path, you read its corpus too. One-way, you can't write through the link.

## Conversations

Conversations within a project show up:

- In the project page's conversation list.
- In the sidebar with a project badge.
- In *Settings → Extensions → Agents tokens* MCP catalogue (filterable by project).

Moving a conversation out of a project (drop the tag): hover in sidebar → menu → Move to project → **(none)**.

## Sharing

`projects.sharingEnabled` — gate for `tcai://project/<uuid>` linking from another project.

- Default OFF.
- The Share path field in *Project settings* is hidden until you flip this on.

There's no cross-user sharing today; sharing is between **your own** projects, for reuse.

## Deleting a project

Project settings panel → **Delete**. Conversations are **detached** (NOT cascaded) — they end up loose in your global chat list without a project tag. Project wiki + external vault link are destroyed.

If you want the cascade (delete conversations too): bulk-delete from sidebar selection mode first, then delete the project.

## Related

- *Memory* (10) — the global wiki + project wiki lifecycle
- *Chat basics* (05) — moving conversations between projects
- *Presets vs skills vs prompts* (15) — when to use a project system prompt vs a skill vs a preset

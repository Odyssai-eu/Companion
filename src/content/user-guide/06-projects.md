# Projects

A **project** groups conversations under a shared system prompt and memory. Open the **Project** button (top of the sidebar, next to Chat) to see the project grid.

## Creating a project

The **+** tile at the end of the grid creates a new project. You give it:

- a **name** (free text),
- an optional **category** (General, Writing, Code, Research, Personal) — picks a preset system prompt you can edit,
- an optional **system prompt** that all conversations in this project will inherit.

## The project page

Each project tile opens onto its page. Layout:

- **Back to projects** in the top-left.
- **Title** taking the full width.
- **Conversations** under the header.
- **Project settings** — collapsible panel (button on the right) for system prompt, memory toggles, project vault.
- **Status icons** under the actions — only the ones that are *on* show: system prompt set, global wiki enabled, read-only, project wiki.

Conversations created from inside a project are tagged with it automatically. From a non-project chat, hover the conversation in the sidebar and pick a project from the dropdown to move it.

## System prompt

The project's system prompt **overrides** the session-level system prompt for any conversation in the project. Same model, different persona per project.

The system prompt is **server-side** — it travels with your account and survives logout. The chat panel's textarea is for one-off, conversation-level overrides only.

## Memory

A project can have two layers of memory:

1. **Global wiki** — your Karpathy-style per-user memory (Obsidian-backed). Shared across all projects. Toggle per project.
2. **Project wiki** — files stored under `agent-notes/` for this project specifically. The agent can append to it via `companion_remember`. Useful for project-specific learnings that shouldn't leak into other contexts.

Each conversation freezes the active memory at start — see *Chat basics → Memory snapshot*.

## Read-only mode

Toggle **Read-only** in project settings to disable the agent's `companion_remember` writes for this project. Useful when you want to use the memory but not pollute it.

## Deleting a project

From the project page → settings panel → **Delete**. Conversations are detached, not destroyed — they end up in your global chat list without a project tag.

# Memory

Companion has two memory layers — both are optional, both are searchable, both are editable. They serve different purposes.

## Global wiki (per-user)

A markdown-only personal wiki. Think Karpathy's [karpathy.bearblog.dev](https://karpathy.bearblog.dev/) memory pattern, but ingested by Companion and made queryable.

- **Where it lives** — an Obsidian vault under `~/Obsidian/companion` on the memory service, indexed in Qdrant with bge-m3 embeddings.
- **What goes in** — anything you'd want any conversation in any project to remember. Identity, preferences, expertise, working style, ongoing context.
- **How the agent reads it** — semantic RAG via `companion_search_memory`. Each conversation freezes a snapshot of the top-K relevant chunks at start.
- **Who writes it** — you. The global wiki is read-only over MCP by design (no auto-pollution from external agents).

To browse: *Settings → Add-ons → Obsidian* gives you a vault export. Edit in Obsidian, push back, re-index runs automatically.

## Project wiki (per-project)

Markdown files scoped to one project, stored as rows in `project_memory_files`.

- **What goes in** — project-specific learnings: gotchas, decisions, vocabulary, infra notes. Anything the agent should know *when working in this project* but shouldn't bleed elsewhere.
- **How the agent reads it** — substring grep alongside the global RAG when a conversation is bound to the project.
- **Who writes it** — you (in *Project settings → Project vault*) **or** the agent via `companion_remember(projectId, title, body)`.

Agent writes land under `agent-notes/<YYYY-MM-DD>-<slug>.md` so you can see what the agent added and prune at will.

## Memory snapshot

Each new conversation freezes the active memory at creation. That's intentional:

- The model sees a stable context across turns — no shifting under its feet.
- Editing the wiki *after* a chat started won't change what that chat sees.

Toggle **memory** off in the conversation header to skip the snapshot entirely for that chat.

## Searching memory

The agent searches automatically via `companion_search_memory`. You can also search manually:

- *Settings → Add-ons → Obsidian* — the export ZIP includes the full vault.
- The Qdrant collection is reachable from the cluster if you want to script against it (see *Settings → Help → Troubleshooting* for endpoints).

## What memory is *not*

- Not chat history. Conversations stay in the DB independently of memory.
- Not training data. Nothing in memory is ever sent back as a fine-tune.
- Not a write-anywhere bucket. The global wiki is curator-only; project wiki is project-scoped.

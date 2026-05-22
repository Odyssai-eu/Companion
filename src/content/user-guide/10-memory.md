# Memory

Companion has two memory layers — both optional, both searchable, both editable. They serve different purposes. Once you understand the snapshot lifecycle, the rest is straightforward.

## The two layers

### Global wiki — Némo

A markdown wiki that captures **who you are** across all conversations. The agent that lives in Companion calls itself Némo and treats this wiki as its memory.

- **Where it lives** — Postgres in the `thecompai-memory` service. Table `memory_articles`. Per-user, scoped by `user_id`.
- **What goes in** — anything you'd want any conversation in any project to remember. Identity, preferences, expertise, working style, ongoing context. Typical articles: profile, expertise, key relationships, infrastructure, ongoing projects, decisions.
- **Structure** — articles have a `path` (`profile/identity.md`, `relationship/partnership.md`, `projects/your-project.md`), `title`, `summary`, `body`. Wiki-link `[[path]]` syntax for cross-references.
- **How the agent reads it** — full wiki concatenated and capped at ~50 KB before injection into the system prompt. Snapshotted per conversation (see lifecycle below).
- **Who writes it** — you (manually) **and** an LLM compiler (a small auxiliary model) that periodically reads recent conversations and emits diffs.

### Project wiki

Markdown files scoped to one project. Independent of the global wiki.

- **Where it lives** — table `project_memory_files`, scoped by `project_id`.
- **What goes in** — project-specific learnings: gotchas, decisions, vocabulary, infra notes, recurring snippets.
- **How the agent reads it** — substring grep when the conversation is bound to the project. Injected via the project corpus part of the system prompt.
- **Who writes it** — you (via *Project settings → Project vault*) **or** the agent via `companion_remember(projectId, title, body)`. Agent writes land under `agent-notes/<YYYY-MM-DD>-<slug>.md`.

The Qdrant collections (`obsidian-context`, `alpha_centauri`) are separate from both wikis — they're for RAG semantic search, not wiki injection.

## The memory snapshot

Every conversation **freezes** memory at creation time. Look at the chat header → memory toggle: when ON, the conversation has a snapshot.

- **Why frozen** — the system prompt prefix must be byte-stable across turns for the upstream KV prefix cache (Odysseus) to actually hit. If the wiki recompiles in the background between two turns, the prompt changes mid-stream, cache busts.
- **How frozen** — `conversations.memory_snapshot` (text, up to ~50 KB) + `memory_snapshot_at` (timestamp).
- **What's frozen** — the global wiki AND the project corpus (when applicable), concatenated under the canonical `buildSystemPrompt` order: user system prompt + project memory + global memory.

### Refreshing the snapshot

Click **Remember now** in the chat header memory menu. Three-second action:

1. Companion calls `/context/{userId}?project_id=<convProject>` against the memory service.
2. The fresh wiki text comes back.
3. `conversations.memory_snapshot` is overwritten.
4. The next turn uses the new snapshot.

Use this when:

- You just edited the wiki manually and want Némo to see the change in the current chat.
- You ran a forced compile and want to surface the new diffs.
- The conversation is old and the wiki has drifted significantly since the snapshot was taken.

### Skipping the snapshot

Flip **Memory** toggle off in the chat header → `conversations.memoryEnabled = false`. From the next turn:

- No global wiki injected.
- No project corpus injected (even if project has it enabled).
- No compile back to the wiki from this conversation.

Useful when you want to:

- Test the raw model without your personal context.
- Discuss something you don't want compiled into the wiki (e.g. one-off troubleshooting that's not worth remembering).
- Save tokens on a conversation where the wiki context is irrelevant.

The toggle survives across turns until you flip it back. Each conversation has its own setting.

## The compile pipeline

How the wiki updates itself:

### Trigger conditions

A conversation qualifies for compile when:

- `kind = 'chat'` (not 'talk' for now)
- `memoryEnabled = true`
- Not a guest session
- Not a project with `globalMemoryReadOnly = true`
- Not a project with `dedicatedMemoryEnabled = true` (those write to project corpus, not global)

If all conditions hold, the conversation is registered via `registerInactivityCompile(userId, convId)`.

### Inactivity-based fire

A scheduler tick (every 60s) scans registrations and fires `triggerCompile` when:

```
now - lastActivityAt >= MEMORY_INACTIVITY_COMPILE_MS  (default 10 min)
```

Each new turn resets the timer. So a chatty conversation compiles **once** after you stop, not per turn. This was a critical performance fix in v1.0.69 — the previous per-turn compile saturated the LLM and caused chat slowdowns.

### Cron backstops

In addition to inactivity, three slots fire compiles globally (server time zone):

- **06:00** — global compile for every user active in the last 24h, on their most recent conv.
- **12:30** — same.
- **19:00** — `compileProject()` per eligible project (writes to `project_memory_files`).

These are backstops in case inactivity-based fires were missed (server restart, etc.).

### The compile itself

`triggerCompile` POSTs to the memory service `/compile/async`. The service:

1. Loads up to 200 recent messages from the conversation (cap 4000 chars each).
2. Builds a prompt asking the LLM to emit DIFFS across 7 wiki categories.
3. Calls whichever model you set as the compile model (Settings → Memory → Compile model — typically a fast local 30-40B chat model). Expects JSON output with `{ action, path, body }` items.
4. Applies the diffs in PG: update / insert / delete per article path.
5. Returns when done — fire-and-forget on the chat side.

### Locking an article

`memory_articles.edited_by_user = true` → the compiler will not touch this article on subsequent runs. Set this:

- When you manually edit an article in Obsidian and push it back.
- Via `POST /articles/lock` to the memory service.
- After a problematic compile rewrote something important — lock it before the next compile.

## Editing the wiki by hand

Two paths today:

1. **Direct PG** — admin SSH into `thecompai-db`, `UPDATE memory_articles ...`. Quick, requires box access.
2. **Obsidian vault sync** — *Settings → Extensions → Add-ons → Obsidian* gives you a vault ZIP. Edit in Obsidian, push back via the plugin (Bearer-token authenticated). Re-index runs automatically.

No in-app wiki editor today. On the roadmap.

## Searching memory

The agent searches automatically via:

- `companion_search_memory(query)` — semantic search over the wiki (RAG-backed via Qdrant `obsidian-context` collection).
- Implicit injection — the conversation's frozen snapshot is in the system prompt every turn.

You can also search manually:

- *Settings → Extensions → Add-ons → Obsidian* — export the vault ZIP and grep locally.
- Direct Qdrant query if you have access to the vector store endpoint.

## What memory is *not*

- Not chat history. Conversations stay in the DB independently of memory.
- Not training data. Nothing in memory is ever sent back to a model provider for fine-tuning.
- Not a write-anywhere bucket. The global wiki has guardrails (`edited_by_user` lock, agent-write restrictions).
- Not the Qdrant collections. Those are RAG indexes over your Obsidian vault (which is separate from the LLM-compiled wiki).

## Common questions

**Q: I edited the wiki but Némo doesn't see it.**
A: Your current conversation has a frozen snapshot from before your edit. Click *Remember now* in the chat header to refresh.

**Q: The agent wrote something weird into the wiki — how do I prevent that?**
A: Mark the article `edited_by_user = true` after fixing it. The compiler will leave it alone going forward.

**Q: Can I delete an article?**
A: SQL today (`DELETE FROM memory_articles WHERE …`). UI on the roadmap. Tip: you can also empty its body to `# Title\n\n` and lock — the article still exists structurally but injects nothing meaningful.

**Q: I don't want any compile in this conversation.**
A: Flip the Memory toggle off in the chat header. The conv is excluded from compile.

**Q: Why does the wiki say things about me I didn't write?**
A: The compiler does (it reads your conversations). If a fact is wrong, edit the article + lock it. If it's right but you didn't realise it was being captured: same fix, plus consider the privacy implications and adjust which conversations qualify for compile.

## Related

- *Projects* (09) — project-scoped memory toggles
- *Agents tokens* (13) — how external agents query / write memory via MCP
- *Privacy & data* (18) — what's compiled, what stays raw
- *Glossary* (21) — terms used (Karpathy, RAG, snapshot, …)

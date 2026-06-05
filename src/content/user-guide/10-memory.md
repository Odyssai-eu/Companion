# Memory

Companion's memory system gives you a persistent, queryable knowledge base that grows with every conversation. It runs on **nemo-memory** — a native macOS service using `Qwen3-Embedding-0.6B-4bit-DWQ` via MLX on Apple Silicon — and organises context across three levels.

## Memory levels

### Personal memory (your knowledge graph)

A LightRAG knowledge graph scoped to your user account. Auto-populated from your wiki vault via nemo-memory.

- **Where it lives** — nemo-memory service (port 8765, native macOS). LightRAG + nano-vectordb.
- **What goes in** — your identity, preferences, expertise, ongoing projects, key relationships, decisions. Everything you'd want any conversation to know about you.
- **Who writes it** — the LLM compiler (reads recent conversations, emits diffs) and you (manually via Obsidian vault sync).

### Team memory (shared knowledge graph)

A shared LightRAG knowledge graph per team. Members of the same team query the same graph.

- **How to populate** — *Settings → Admin → Teams* → select a team → "Sync memory". Pulls from the team's shared vault into the team graph.
- **How it activates** — assign a project to a team in Settings → Admin → Teams. Conversations in that project automatically query both personal AND team memory at each turn.

### Company memory (V2)

Org-wide knowledge graph. Structure is ready; the UI is coming in a future release.

## How memory gets injected

At each chat turn, nemo-memory is queried in parallel across all available collections using the user's last message as the search query:

- Top-5 relevant chunks from each available collection are retrieved.
- Total injection is approximately 4.5K tokens (vs 12K+ for a raw vault dump).
- All three collections are queried concurrently — no sequential overhead.

**Fallback**: if nemo returns empty (cold start, service not yet built), Companion falls back to the full wiki vault with a 50KB cap.

### KV cache benefit

After turn 1 (expensive prefill of the full memory context), subsequent turns only pay for the delta — approximately 48 tokens per turn. This gives roughly 8× faster TTFT on follow-up turns compared to naive full-context injection every turn.

## The memory snapshot

Every conversation **freezes** memory at creation time. Look at the chat header → memory toggle: when ON, the conversation has a snapshot.

- **Why frozen** — the system prompt prefix must be byte-stable across turns for the upstream KV prefix cache (OdyssAI-X) to actually hit. If the wiki recompiles in the background between two turns, the prompt changes mid-stream, cache busts.
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

## Decision Log

Companion supports **Decision Log** entries as a first-class memory object — append-only structured decisions per project.

Each entry captures:
- **Title** — short name for the decision.
- **Context** — what situation prompted the decision.
- **Alternatives** — what other options were considered.
- **Choice** — what was decided.
- **Rationale** — why this choice over the alternatives.
- **Revisit date** — when to reconsider.

Decision Log entries are injected in the project context automatically. They're append-only by design — decisions aren't edited, they're superseded by new ones.

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

1. **Direct PG** — admin SSH into `companion-db`, `UPDATE memory_articles ...`. Quick, requires box access.
2. **Obsidian vault sync** — *Settings → Extensions → Add-ons → Obsidian* gives you a vault ZIP. Edit in Obsidian, push back via the plugin (Bearer-token authenticated). Re-index runs automatically.

No in-app wiki editor today. On the roadmap.

## Searching memory

The agent searches automatically via:

- `companion_search_memory(query)` — semantic search over the wiki (RAG-backed via nemo-memory / LightRAG).
- Implicit injection — the conversation's frozen snapshot is in the system prompt every turn.

You can also search manually:

- *Settings → Extensions → Add-ons → Obsidian* — export the vault ZIP and grep locally.
- Direct nemo-memory query if you have access to the service endpoint (port 8765).

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

**Q: How do I enable team memory?**
A: Create a team in *Settings → Admin → Teams*, assign a project to that team. Conversations in that project will automatically query both personal and team memory. Populate team memory via the "Sync memory" button on the team.

## Related

- *Projects* (09) — project-scoped memory toggles
- *Agents tokens* (13) — how external agents query / write memory via MCP
- *Privacy & data* (18) — what's compiled, what stays raw
- *Glossary* (21) — terms used (Karpathy, RAG, snapshot, …)

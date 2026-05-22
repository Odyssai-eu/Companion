# Presets vs skills vs system prompts

Companion has several "instruction" mechanisms — and they are **not interchangeable**. In particular: **system prompts are not skills**, and Companion has both a Saved Prompts library AND a Skills library for exactly this reason. Choosing the right one saves friction. This is the decision tree.

## Quick decision matrix

| Mechanism | What it is | Scope | When to use |
|---|---|---|---|
| **Saved prompt** | A named system prompt you can save once and reuse | Per-user | Reusable system prompt — the persona / instructions you set at the top of a chat. Load it into a conversation with one click. **The canonical home for named *system prompts*.** |
| **Skill** | Named markdown instructions the agent loads **on demand** via a tool call | Per-user | A persona / checklist / rubric the agent picks up when the request matches its description — not always-on. **The canonical home for named *agent skills*.** |
| **Project system prompt** | Static prompt for every conversation in a project | Per-project | Persona / context that applies to everything in a domain (a codebase, a research area). |
| **Conversation system prompt** | One-off override for the current chat | Per-conversation | Throwaway. Test a prompt, fork a personality for one chat. The cogwheel offers a **Save** button to promote it into the Saved Prompts library. |
| **Inference preset** | Sampling parameters (temp, top_p, max_tokens, thinking) | Per-user, applicable any chat | When you have a vibes-tuning bundle. NOT for prompts. |
| **Memory wiki article** | Always-injected per-user context | Per-user | "Who the user is" — preferences, expertise, identity, working style. Always visible to the model. |
| **Project memory** | Always-injected per-project context | Per-project | Project-specific vocabulary, decisions, gotchas. |

## Saved prompts vs skills — the critical distinction

This is the one most people get wrong, so it's worth spelling out:

- A **saved prompt** is a *system prompt template*. You load it via the cogwheel ("Apply prompt" dropdown) and it goes into the conversation's system prompt slot — **always-on for every turn** of that chat. Use it for things like "You are a senior TypeScript reviewer. Always show diffs. Be terse." It sets the *mode of the whole conversation*.
- A **skill** is a *named instruction package* that the agent loads **on demand** via the `skill_get` tool when the user's request matches the skill's description. It's not in the system prompt unless the agent decides to pull it in. Use it for narrowly-scoped methodologies the agent should opt into ("when the user pastes a diff, follow this 7-point review checklist").

Saved prompts are *always-on for the chat*. Skills are *just-in-time for one turn*. They have separate UIs (Settings → Prompts vs Settings → Skills) and separate persistence paths because they do different jobs.

## Long-form decision tree

### Q1: Is this instruction about *who you are* (preferences, identity, ongoing context)?

→ **Memory wiki article**. Always-injected. Lock with `edited_by_user=true` if you don't want the compiler to drift it.

### Q2: Is this a *named system prompt* you want to reuse across chats?

→ **Saved prompt** (Settings → Prompts, or `Save` from the conversation cogwheel).

Examples:
- "Terse TypeScript reviewer" — sets the chat into review mode.
- "French ghostwriter, no anglicisms" — sets the chat into a writing register.
- "JSON-only responder" — locks output shape for a session.

Apply with one click from the conversation cogwheel.

### Q3: Is it a *named methodology* the agent should adopt only when the user's request matches it?

→ **Skill**.

Examples:
- `code-review-strict` — hard, opinionated review with banner-style checklist.
- `meeting-notes-extract` — extract decisions + action items from raw notes.
- `release-changelog` — emit a changelog from a git log dump.

The agent sees the **catalog** (name + description). When the user's request matches, the agent calls `skill_get(name)` to load the full body for *this turn only*. Other turns get the catalog again.

### Q4: Is this a *system prompt for an entire project* — same persona across every conv in that domain?

→ **Project system prompt**. Set in *Project settings*. Every conversation in the project inherits it.

Examples:
- A coding project: "You are an expert TypeScript engineer. Be terse. Always show diffs."
- A writing project: "You are a French ghostwriter for a French audience. No anglicisms."

### Q5: Is this a *one-off* you want for the current chat only, won't reuse?

→ **Conversation system prompt** (cogwheel → System prompt textarea). Not saved by default. Click **Save** in the cogwheel to promote it into the Saved Prompts library when you realise you'll want it again.

### Q6: Is this about *sampling* — temperature, top_p, max tokens, thinking budget?

→ **Inference preset**. Save the bundle, load it from the dropdown.

Common ones:
- "Creative" — temp 1.0, top_p 0.95.
- "Deterministic" — temp 0, seed=42.
- "Reasoner" — thinking on, effort medium.
- "Cheap probe" — max_tokens 5, temp 0.

## What gets injected when

For any chat turn, the system prompt is built by `buildSystemPrompt`:

```
[user system prompt — conversation-level override OR project prompt]
[--- separator ---]
[project memory — when dedicatedMemoryEnabled]
[--- separator ---]
[global memory snapshot — when memoryEnabled]
```

Concatenated with `\n\n---\n\n` separators. Empty sections are dropped.

**Skills are NOT in this prompt.** They're loaded on demand by the model via `skill_get`. So skill content only enters the context when the agent decides it's relevant — not every turn.

This is the heart of the design:

- Wiki + memory = always-on background. Cheap per turn (~5-15k tokens of stable prefix that hits the KV cache).
- Skills = on-demand foreground. Costs only when activated.

## Anti-patterns

### Don't store named system prompts as skills

This is the headline mistake the matrix above is fighting. A "be a terse TypeScript reviewer" instruction is a **saved prompt** (always-on for the chat), not a skill (loaded only when the agent decides to). Putting it in the Skills library means the agent might *forget* to load it — and your "reviewer" chat ends up answering as plain Némo.

### Don't put project context in a skill

If the agent should always have the project's domain knowledge: put it in the **project system prompt** OR the **project memory** (depending on shape). Skill = on-demand. Project context = always-on.

### Don't put your identity in a skill

"I am <name>, I prefer direct French" goes in **memory wiki** (`profile/identity.md`, `profile/preferences.md`). Not in a skill that the agent might forget to load.

### Don't conflate prompts and presets

"Be terse" is a **prompt instruction**. "temperature=0.3" is a **sampling param**. Don't try to stuff sampling into a system prompt ("you must be temperature 0.3") — the model can't honor it, and presets are designed for this.

### Don't duplicate

If you have a `code-review-strict` skill, don't also paste its body into a project system prompt and a conversation system prompt. Pick one mechanism. Duplication makes future edits drift.

### Don't memorise sensitive info via the compiler

The wiki compiler reads your conversations and emits diffs. If you chat about something you don't want compiled in, flip **Memory** off for that conversation (chat header). Cleaner than letting it land then trying to delete.

## Worked example

> A user wants the agent to always speak French, with a technical-but-warm register, to put the **current chat** explicitly in "PR review mode", and additionally to load a strict review checklist whenever they paste a diff.

- "Always French, technical-but-warm register" → **wiki article** `profile/preferences.md` + `profile/writing-guide.md`. Always visible to every chat. Locked with `edited_by_user=true` after editing manually.
- "This chat is in PR review mode" → **saved prompt** "PR review mode" applied from the cogwheel. Always-on for the conversation.
- "When the user pastes a diff, follow the strict checklist" → **skill** `code-review-strict`. Loaded by the agent on demand when the user actually pastes a diff.
- "Sampling: deterministic, short replies" → **preset** "Code review tuning" (temp 0, max_tokens 4000).

When the user opens a chat:
- The chat header has the wiki snapshot already (preferences, writing-guide visible to the model).
- They click the cogwheel → "Apply prompt" → "PR review mode". The system prompt is now set for the whole chat.
- They paste a diff and say "review this".
- The model recognises the request, calls `skill_get("code-review-strict")`, loads the checklist body for this turn.
- The user applies the "Code review tuning" preset from the cogwheel → temp 0 + cap.

Four orthogonal mechanisms, each at the right scope.

## Related

- *Skills* (11) — skill format and lifecycle
- *Memory* (10) — wiki and project corpus
- *Projects* (09) — project-level system prompt
- *Inference settings* (14) — sampling and presets

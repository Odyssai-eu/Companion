# Presets vs skills vs system prompts

Companion has several "instruction" mechanisms. Choosing the right one saves friction. This is the decision tree.

## Quick decision matrix

| Mechanism | What it is | Scope | When to use |
|---|---|---|---|
| **Skill** | Named markdown instructions, loadable on demand | Per-user | Reusable persona / checklist / rubric the agent can pull when relevant. **The canonical home for named prompts.** |
| **Project system prompt** | Static prompt for every conversation in a project | Per-project | Persona / context that applies to everything in a domain (a codebase, a research area). |
| **Conversation system prompt** | One-off override for the current chat | Per-conversation | Throwaway. Test a prompt, fork a personality for one chat. |
| **Inference preset** | Sampling parameters (temp, top_p, max_tokens, thinking) | Per-user, applicable any chat | When you have a vibes-tuning bundle. NOT for prompts. |
| **Memory wiki article** | Always-injected per-user context | Per-user | "Who Sophie is" — preferences, expertise, identity, working style. Always visible to the model. |
| **Project memory** | Always-injected per-project context | Per-project | Project-specific vocabulary, decisions, gotchas. |

## Long-form decision tree

### Q1: Is this instruction about *who you are* (preferences, identity, ongoing context)?

→ **Memory wiki article**. Always-injected. Lock with `edited_by_user=true` if you don't want the compiler to drift it.

### Q2: Is it a *named persona / role / methodology* that the agent should adopt when relevant?

→ **Skill**.

Examples:
- `code-review-strict` — hard, opinionated review with banner-style checklist.
- `tmb-benchmark-writeup` — Monocle-Bear-voice benchmark writeup format.
- `meeting-notes-extract` — extract decisions + action items from raw notes.
- `last-fire-writer` — fiction-writing skill with a storyboard method.

The agent sees the **catalog** (name + description). When the user's request matches, the agent calls `skill_get(name)` to load the full body for *this turn only*. Other turns get the catalog again.

### Q3: Is this a *system prompt for an entire project* — same persona across every conv in that domain?

→ **Project system prompt**. Set in *Project settings*. Every conversation in the project inherits it.

Examples:
- A coding project: "You are an expert TypeScript engineer. Be terse. Always show diffs."
- A writing project: "You are a French ghostwriter for a French audience. No anglicismes."

### Q4: Is this a *one-off* you want for the current chat only, won't reuse?

→ **Conversation system prompt** (cogwheel → System prompt textarea). Not saved. Disappears when you start a new chat.

### Q5: Is this about *sampling* — temperature, top_p, max tokens, thinking budget?

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

### Don't put project context in a skill

If the agent should always have the project's domain knowledge: put it in the **project system prompt** OR the **project memory** (depending on shape). Skill = on-demand. Project context = always-on.

### Don't put your identity in a skill

"I am Sophie, I prefer direct French" goes in **memory wiki** (`profile/identity.md`, `profile/preferences.md`). Not in a skill that the agent might forget to load.

### Don't conflate prompts and presets

"Be terse" is a **prompt instruction**. "temperature=0.3" is a **sampling param**. Don't try to stuff sampling into a system prompt ("you must be temperature 0.3") — the model can't honor it, and presets are designed for this.

### Don't duplicate

If you have a `code-review-strict` skill, don't also paste its body into a project system prompt and a conversation system prompt. Pick one mechanism. Duplication makes future edits drift.

### Don't memorise sensitive info via the compiler

The wiki compiler reads your conversations and emits diffs. If you chat about something you don't want compiled in, flip **Memory** off for that conversation (chat header). Cleaner than letting it land then trying to delete.

## Worked example

> Sophie wants the agent to always speak French, with technical-but-warm-no-Baudelaire register, and additionally to be in "code review mode" for a current PR she's looking at.

- "Always French, technical-but-warm-no-Baudelaire" → **wiki article** `profile/preferences.md` + `profile/writing-guide.md`. Always visible to every chat. Locked with `edited_by_user=true` after editing manually.
- "In code review mode for this PR" → **skill** `code-review-strict`. Loaded by the agent on demand when Sophie pastes a diff.
- "Sampling: deterministic, short replies" → **preset** "Code review tuning" (temp 0, max_tokens 4000).

When Sophie opens a chat:
- The chat header has her wiki snapshot already (preferences, writing-guide visible to the model).
- She pastes a diff and says "review this".
- The model recognises the request, calls `skill_get("code-review-strict")`, loads the body for this turn.
- Sophie applies her "Code review tuning" preset from the cogwheel → temp 0 + cap.

Three orthogonal mechanisms, each at the right scope.

## Related

- *Skills* (11) — skill format and lifecycle
- *Memory* (10) — wiki and project corpus
- *Projects* (09) — project-level system prompt
- *Inference settings* (14) — sampling and presets

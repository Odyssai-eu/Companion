# Skills

A **skill** is a markdown instruction package the agent can load on demand. Companion follows the [agentskills.io](https://agentskills.io/specification) specification, so any SKILL.md (or ZIP) from the open library imports cleanly.

## Why skills

You can't (and shouldn't) shove every persona, checklist, and rubric into the system prompt. Skills solve that:

- The agent always sees a **compact catalog** of skills (name + description, ~one line each) — progressive disclosure tier 1.
- When a skill's description matches the user's request, the agent calls `skill_get(name)` to pull the full body and apply it as task-specific instructions for *this* turn.
- Skills can carry **supporting files** (`scripts/`, `references/`, `assets/`) for richer workflows.

Skills are user-scoped — each account has its own library. No tenant escape.

## SKILL.md format

```
---
name: code-review-strict
description: Hard, opinionated code review. Asks "but why?" before approving.
license: MIT
compatibility: any
---

# Code review (strict)

Read the diff carefully. For each non-trivial change, …
```

**Frontmatter rules** (enforced server-side):

- `name` — 1–64 chars, lowercase a–z / 0–9 / hyphen, no leading/trailing/consecutive hyphens.
- `description` — ≤1024 chars. **This is what the agent reads in the catalog**, so write it as *"when to invoke me"*, not "what I am". The triggering accuracy is largely driven by this string.
- `license`, `compatibility` — optional strings.
- Other frontmatter keys land in `metadata` (free-form, preserved on round-trip).

**Body** — full markdown, no length cap server-side (be reasonable; ~10k tokens of instructions is already a lot).

## Creating a skill

Two paths:

### 1. Manually

*Settings → Extensions → Skills → New skill* → fill the form:

- **Name** (validated against the regex above)
- **Description** (write the triggering condition)
- **Body** (markdown)
- **Tags** (free-form, comma-separated; used for filtering the list)
- **License** / **Compatibility** (optional)

Save. The skill is live immediately — the agent sees it on the next turn.

### 2. Through Némo (in chat)

Say *"create a skill named `…` that …"* in any chat. The agent calls `skill_create` and the skill shows up in the Settings page.

Useful when you're mid-conversation and realise "we should remember how to do this" — let the agent draft it from your conversation context, then refine in Settings.

## Importing a skill

*Settings → Extensions → Skills → Import…* accepts either:

- A single `SKILL.md` file, or
- A `.zip` packaged as:

```
my-skill/
  SKILL.md
  scripts/…
  references/…
  assets/…
```

Most GitHub-style downloads work — the importer handles a single root-directory wrapping. Limits per archive:

- 64 files max
- 200 KB per file
- 2 MB total uncompressed

You can also paste a SKILL.md to Némo and say *"import this"* — `skill_import_md` does the parse + persist.

## Exporting a skill

Each row in the Settings page has an **Export** link → downloads a `<name>.zip` with the SKILL.md and supporting files. Round-trips cleanly through any agentskills.io-compatible client.

To export the SKILL.md without supporting files: open the skill, copy the body, paste with the frontmatter prepended manually.

## Editing supporting files

The Settings page edits `body`, `description`, `license`, `compatibility`. Editing `scripts/` / `references/` / `assets/` in the browser isn't supported yet — re-import an updated ZIP to refresh them.

## How the agent uses skills

The agent has these tools **always available**, regardless of conversation agent-mode:

- `skill_list` — discover what's there.
- `skill_get(name)` — load the full body when relevant.
- `skill_create / skill_update / skill_delete` — curate on user request.
- `skill_import_md(content)` — ingest a pasted SKILL.md.

This is intentional: skills curation is a meta-task that should work in any chat without flipping agent mode. The tools have minimal token cost (~80 tokens for the schemas) so the cost-benefit is heavy on the benefit side.

## External agent access

External coding agents (Claude Desktop, Cline, Continue.dev, Cowork) hitting Companion as an MCP brain get the same tools, prefixed `companion_*`:

- `companion_list_skills`
- `companion_get_skill`
- `companion_create_skill`
- `companion_update_skill`
- `companion_delete_skill`
- `companion_import_skill_md`

See *Agents tokens* (13).

## When to use a skill vs other prompt mechanisms

| Mechanism | When |
|---|---|
| **Account default system prompt** | (deprecated — use skills instead) |
| **Project system prompt** | Persona / context that applies to every conversation in this project. Static. |
| **Conversation system prompt** (Inference cogwheel) | One-off override for the current chat. Not saved. |
| **Inference preset** | Sampling parameters (temperature, top_p, max_tokens, thinking). NOT prompt. |
| **Skill** | Named, reusable instructions the agent can load on demand. The new canonical home for named prompts. |

See *Presets vs skills vs prompts* (15) for the deeper guide.

## Anatomy in the DB

```
prompt_skills  (legacy table, sometimes called "named prompts")
agent_skills   (the agentskills.io-compatible table; this is the one in use)
```

`agent_skills` columns: `id, user_id, name, description, body, tags[], source ('user'|'agent'|'imported'), license, compatibility, files (jsonb of path → content), metadata (jsonb), created_at, updated_at`.

The `source` field is automatic:

- `user` — created via Settings UI.
- `agent` — created via `skill_create` in chat (or MCP `companion_create_skill`).
- `imported` — created via the import flow (file or paste).

## Limits

- Per-skill body: no hard cap server-side, but the model's context window applies when loading.
- Supporting files: 64 files × 200 KB × 2 MB total per skill.
- Per-user skill count: no hard cap.

## Skills vs the wiki

Both are markdown the agent can read. The difference:

- **Wiki** (Némo) — your personal context, always-injected via snapshot.
- **Skill** — task-specific instructions, loaded on demand by the agent when relevant.

Rule of thumb: if the model should always see it → wiki. If the model should see it only sometimes when relevant → skill.

## Related

- *Agents tokens* (13) — how Cline / Continue.dev / Claude Desktop see your skill library
- *Presets vs skills vs prompts* (15) — the canonical decision tree
- *Memory* (10) — the wiki (always-injected) counterpart

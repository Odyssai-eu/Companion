# Skills

A **skill** is a markdown instruction package the agent can load on demand. Companion follows the [agentskills.io](https://agentskills.io/specification) specification, so any SKILL.md (or ZIP) from the open library imports cleanly.

## Why skills

You can't (and shouldn't) shove every persona, checklist, and rubric into the system prompt. Skills solve that:

- The agent always sees a **compact catalog** of skills (name + description, ~one line each) — progressive disclosure tier 1.
- When a skill's description matches the user's request, the agent calls `skill_get(name)` to pull the full body and apply it as task-specific instructions.
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
- `description` — ≤1024 chars. This is what the agent reads in the catalog, so write it as **when to invoke**.
- `license`, `compatibility` — optional strings.
- Other frontmatter keys land in `metadata` (free-form).

## Creating a skill

Two paths:

1. **Manually** — *Settings → Extensions → Skills → New skill*. Fill the form, save.
2. **Through Nemo** — say "create a skill named `…` that …" in chat. The agent calls `skill_create` and the skill shows up in the Settings page.

## Importing a skill

*Settings → Extensions → Skills → Import…* accepts either a single `SKILL.md` or a `.zip` packaged as:

```
my-skill/
  SKILL.md
  scripts/…
  references/…
  assets/…
```

Most GitHub-style downloads work — the importer handles a single root-directory wrapping. Limits per archive: 64 files, 200 KB per file, 2 MB total.

You can also paste a SKILL.md to Nemo and say "import this" — `skill_import_md` does the parse + persist.

## Exporting a skill

Each row in the Settings page has an **Export** link → downloads a `<name>.zip` with the SKILL.md and supporting files. Round-trips cleanly through any agentskills.io-compatible client.

## Editing supporting files

The Settings page edits `body`, `description`, `license`, `compatibility`. Editing `scripts/` / `references/` / `assets/` in the browser isn't supported yet — re-import an updated ZIP to refresh them.

## How the agent uses skills

The agent has these tools always available, regardless of conversation agent-mode:

- `skill_list` — discover what's there.
- `skill_get(name)` — load the full body when relevant.
- `skill_create / skill_update / skill_delete` — curate on user request.
- `skill_import_md(content)` — ingest a pasted SKILL.md.

External coding agents (Claude Desktop, Cline, Continue.dev) hitting Companion as an MCP brain get the same tools, prefixed `companion_*` — see *Agents tokens*.

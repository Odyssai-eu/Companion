# Account & devices

How sign-in, sessions, and multi-device access work in Companion.

## The account model

One account = one private workspace. Inside the workspace:

- All conversations + projects
- The personal memory wiki (Némo)
- Your library of skills
- Your registered MCP servers (Notion, Linear, …)
- Your minted agents tokens (`hms_…`)
- Your inference engine config + presets + named models + hidden models

Two users in the same workspace never see each other's data. Tokens are scoped per user.

## Signing in

- **First time**: the workspace admin creates the account; you receive credentials (or use the magic-link flow when enabled).
- **Returning**: email + password. Companion stores a session cookie in your browser.

Currently no self-serve sign-up — that's a sovereignty trade-off. The admin curates the user list.

## Signing out

Top-right avatar → **Sign out**. Drops the local cookie. Server-side session is invalidated lazily.

## Forgot password

Admin-resettable today (no self-serve reset flow). Ping your workspace admin.

## Multiple devices

Same account, multiple devices = same workspace, simultaneously. Open Companion on your laptop and your phone — conversation list, memory, settings all live.

Two caveats:

- **Streaming reply is per-tab.** If you start a reply on desktop and open the same conversation on phone mid-stream, the phone sees the partial reply via the server-side inference buffer (lasts ~60s post-completion), then the persisted message.
- **Edits propagate via reload.** No real-time push — pull to refresh, or wait for the polling tick (~5s).

## Account roles

- **`user`** — default. Full workspace access for own data.
- **`organiser`** — can invite + manage users in the workspace.
- **`admin`** — full administrative access including license + global guest tokens.
- **`guest`** — read-only ish, scoped via a guest token to one or more conversations / projects.

Roles are admin-assigned, not self-changeable.

## Guest tokens (when you receive one)

If someone shares a `g_…` guest token URL with you, opening the link auto-loads the conversation read-only (or read-write if granted). The guest token can scope you to:

- a single conversation
- a project
- the whole workspace with a token budget cap

You don't sign in. The token is the credential. Close the tab, the access goes away with the session.

For minting guest tokens yourself, that's an admin-only feature today.

## Time zone

Settings → Profile → Time zone. Used for:

- Time-stamps in the chat ("3 minutes ago", "Tuesday 14:32")
- Karpathy memory compile cron slots (06:00 / 12:30 / 19:00 local)
- Per-message time tags injected into the chat history (helps the model anchor temporal context)

Default `Europe/Paris`. Change it once when you set up; it doesn't auto-detect.

## Deleting your account

Admin-only today. Contact your workspace admin. The cascade is:

- Hard-delete: users row, sessions, agents tokens, inference settings, presets, MCP servers.
- Cascade-delete via FK: conversations, messages, projects, project_memory_files, memory_articles, addons.
- Detached: nothing — the cascade is thorough by design.

If you just want to clear conversations without deleting the account, use the bulk-delete in the sidebar (Selection mode → check rows → Delete).

## Related

- *Engine pairing* (16) — pairing your engine after sign-in
- *Privacy & data* (18) — what travels with the account
- *Agents tokens* (13) — minting `hms_…` for IDE agents (distinct from guest tokens)

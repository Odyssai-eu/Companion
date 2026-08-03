-- v2.0 γb1 — remove the Hermes/Pi bridge era (docs/v2/audit-hermes-pi.md).
--
-- agent_sessions / agent_messages were the bridge sub-thread transcript
-- (Hermes ACP, Pi). Verified 2026-08-03: ComfyUI does NOT use them (it
-- calls its add-on over HTTP directly) — the tables are pure vestige and
-- the native runtime uses real conversations (parent_id). Dropped, not
-- purged.
--
-- The addon rows disappear with their catalog entries; user overrides
-- are deleted too (the add-ons no longer exist to be configured).

DROP TABLE IF EXISTS agent_messages;
DROP TABLE IF EXISTS agent_sessions;

DELETE FROM addons WHERE name IN ('Hermes Agent', 'Pi Agent');

-- 2026-05-19: Hermes integration retired from Companion.
-- The Hermes Agent CLI on the .50 host stays as a standalone tool
-- (the operator still uses it directly), but we no longer pipe user
-- conversations through Companion's chat route to the Hermes gateway.
-- Rationale: empirically net-negative — adds latency, ghost-answers,
-- and a confusing UX layer ("ketchup on chocolate cake").
--
-- This migration:
--   1. Drops the Hermes Agent addon row for every user.
--   2. Re-points any conversation with kind='hermes' to kind='chat' so
--      the normal gateway path takes over. The legacy `repo_path`
--      column is left in place (nullable already) — dropping it would
--      cascade into client typecheck noise. A later migration can
--      remove it once we're sure no scripts read it.
--
-- The `hermes_tokens` table (introduced by migration 0028) is KEPT —
-- it's the storage backend for external-agent tokens (Cowork
-- dispatch, MCP clients). The table name is historical and we're
-- not renaming it now to avoid breaking the middleware that resolves
-- bearer tokens at request time.

DELETE FROM addons WHERE name = 'Hermes Agent';

UPDATE conversations SET kind = 'chat' WHERE kind = 'hermes';

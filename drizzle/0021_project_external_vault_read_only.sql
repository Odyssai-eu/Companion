-- Read-only flag for the linked external vault path. Mirrors the
-- "Read only" sub-toggle that already exists under Global wiki.
--
-- Today's effect: purely declarative — TheCompAI doesn't yet write to
-- the external vault. Once the project auto-compile feature lands
-- (equivalent of triggerCompile but writing into the project corpus),
-- this flag will gate the writes.
--
-- Default true: writing should be the EXPLICIT opt-in, not the
-- accidental default — a project pointing at another project's vault
-- via tcai:// can't write anyway (enforced in code), but writing to a
-- filesystem vault is a non-trivial side effect.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS external_vault_read_only boolean
  NOT NULL DEFAULT true;

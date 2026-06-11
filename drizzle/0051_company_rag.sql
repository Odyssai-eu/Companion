-- 2026-06-11: Company memory tier. A dedicated LightRAG (standard API) holds
-- ONE shared "company" graph that every user reads — org-wide memory, distinct
-- from the per-user nemo service (:8765). The URL is editable in Admin → Memory
-- backend; empty disables the tier. Seed with the service already running on
-- :8766 so it works out of the box (still editable — nothing hardcoded in code).
ALTER TABLE global_settings
  ADD COLUMN IF NOT EXISTS company_rag_url TEXT NOT NULL DEFAULT '';

UPDATE global_settings
  SET company_rag_url = 'http://host.docker.internal:8766'
  WHERE id = 1 AND company_rag_url = '';

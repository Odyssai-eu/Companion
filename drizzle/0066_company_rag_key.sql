-- 2026-08-17: optional API key for the company-tier LightRAG. Some LightRAG
-- servers enforce an API key (X-API-Key header) on /query; the company RAG
-- client previously sent none. Lets the company tier point at a key-protected
-- corpus (Sentinel :9621). Empty = no key (backward-compatible).
ALTER TABLE global_settings ADD COLUMN IF NOT EXISTS company_rag_key text NOT NULL DEFAULT '';

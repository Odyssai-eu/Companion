-- 2026-06-17: Per-user memory mode (#29) — basic vs advanced.
-- 'advanced' (default) = current behaviour: nemoQuery RAG across the
-- user/team/project/company tiers (embeddings + Qdrant).
-- 'basic' = wiki/vault path only (getMemoryContext), NO embeddings, NO Qdrant,
-- NO nemoQuery — even when the nemo service is available. Orthogonal to the
-- per-conversation memoryEnabled toggle; only decides WHICH path when memory
-- is ON. Default 'advanced' preserves zero-regression for existing users.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS memory_mode text NOT NULL DEFAULT 'advanced';

-- 2026-06-11: Memory backend toggle. A deployment-wide singleton row that
-- selects which memory system feeds chat — LightRAG (per-turn semantic
-- retrieval) or the Karpathy LLM-compiled wiki. The two are mutually
-- exclusive: chat.ts reads one or the other, and the wiki-compile scheduler
-- idles when LightRAG is active. Driven from Admin → Memory backend.
-- See server/lib/global-settings.ts.
CREATE TABLE IF NOT EXISTS global_settings (
  id             INTEGER PRIMARY KEY DEFAULT 1,
  memory_backend TEXT NOT NULL DEFAULT 'lightrag',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the singleton with the current production state: LightRAG is the
-- active backend (nemo:8765 is live; MEMORY_SERVICE_URL is unset so the wiki
-- is already dormant). Keeps behaviour identical until an admin flips it.
INSERT INTO global_settings (id, memory_backend) VALUES (1, 'lightrag')
  ON CONFLICT (id) DO NOTHING;

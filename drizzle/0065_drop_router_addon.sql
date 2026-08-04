-- 2026-08-04: Retire the "Auto Router" (semantic-router) add-on. CoeOS is
-- the router now — `auto` mode routes to the CoeOS engine, which composes a
-- benchmark-proven model per skill axis. The embeddings-based add-on it
-- replaced is obsolete. Drop the orphaned add-on rows the lazy-init created
-- when the Add-ons page was visited. The default model (Settings → Inference)
-- is the fallback now (CoeOS/model down), not the add-on's fallbackModel.
DELETE FROM addons WHERE name = 'Auto Router';

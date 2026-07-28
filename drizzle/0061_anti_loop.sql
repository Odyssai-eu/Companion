-- 0061 — anti-loop switch (per-user preference, default ON)
--
-- The engine (OdyssAI-X >= 1.21.0) stops a generation when the token
-- stream degenerates into a repetition loop. This column is the user's
-- switch for that behaviour: true (default) = protected; false = the
-- chat path sends `anti_loop: false` upstream and the engine lets the
-- output run. Plain per-user preference like show_metrics — deliberately
-- NOT part of the 0059/0060 inherited blocks.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "anti_loop" boolean NOT NULL DEFAULT true;

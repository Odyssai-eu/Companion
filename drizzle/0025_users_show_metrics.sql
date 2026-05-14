-- Per-user toggle for the metrics box rendered under each assistant
-- message (TTFT, duration, prompt/completion tokens, speed). Default
-- false — most users don't care about latency telemetry on every turn.
-- Power users flip it on in Settings → Inference.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS show_metrics boolean NOT NULL DEFAULT false;

-- Inference presets — extend with reasoning controls.
--
-- `thinking` is the master switch for the model's hidden chain-of-thought
-- stream (Anthropic Extended Thinking, OpenAI reasoning, Qwen3-thinking
-- variants, …). `reasoning_effort` is the budget knob that ships with it
-- ("none" | "minimal" | "low" | "medium" | "high" | "xhigh"). We store
-- both so a preset captures the full reasoning configuration, not just
-- sampling params.

ALTER TABLE inference_presets
  ADD COLUMN IF NOT EXISTS thinking boolean,
  ADD COLUMN IF NOT EXISTS reasoning_effort text;

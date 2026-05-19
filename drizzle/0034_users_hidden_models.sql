-- Per-user hide list for the chat model picker. JSONB array of model ids
-- (e.g. ["argo", "claude-haiku-4-5"]). Null = "show everything", which
-- is the right default for fresh users who haven't curated yet.
--
-- Easy inference mode filters these out entirely; advanced/expert modes
-- gray them out so the user can un-hide in context.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS hidden_models jsonb;

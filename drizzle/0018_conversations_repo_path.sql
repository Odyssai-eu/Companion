-- Repo binding for Hermes (kind='hermes') conversations.
-- When set, the chat route enriches the system prompt with the working
-- directory so Hermes operates inside the bound repo. NULL = no binding;
-- Hermes works in its default cwd. Free-text path on the gateway host
-- (.50) — no validation server-side, the agent surfaces the failure if
-- the path doesn't exist.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS repo_path text;

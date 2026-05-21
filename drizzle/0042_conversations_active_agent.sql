-- Conversation-level agent mode. When set, the chat composer routes
-- ALL messages to that agent's bridge instead of the LLM chat path.
-- /exit (or /hermes_off etc.) clears this flag back to null. The user
-- only types /hermes once to enter; the chip near the composer is the
-- visual reminder that they're in agent mode.
--
-- Values today: 'hermes'. Future: 'pi', 'openclaude', etc. Free-form
-- so we don't need a migration for each new agent.
--
-- Null = normal chat (the default).

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS active_agent text;

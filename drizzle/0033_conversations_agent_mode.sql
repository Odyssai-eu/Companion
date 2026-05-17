-- Per-conversation "agent mode" toggle. When false (default), no tool
-- definitions are injected in the upstream chat body. This drops the
-- typical prompt from 1000+ tokens (always-on FS/RAG/Web schemas) down
-- to ~250 tokens — just system + memory + tagged user message. It also
-- removes the only reason `shouldUseNonStream` was forcing non-stream
-- on jaccl backends, so streaming works naturally for plain chats.
--
-- Existing conversations get false (clean chat behavior). User can flip
-- it on per-conv via the chat header toggle when they actually want
-- agentic capability (fs ops, rag search, web fetch, MCP servers).

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS agent_mode boolean NOT NULL DEFAULT false;

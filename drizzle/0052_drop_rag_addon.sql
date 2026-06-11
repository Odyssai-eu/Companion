-- 2026-06-11: Retire the per-user "RAG" add-on. The memory architecture split
-- it obsolete: user/team memory is the bundled custom nemo (internal, not a
-- user-editable link), and the only editable RAG link is the company LightRAG
-- (global_settings.company_rag_url). Drop the orphaned add-on rows that the
-- lazy-init created when the Add-ons page was visited.
DELETE FROM addons WHERE name = 'RAG';

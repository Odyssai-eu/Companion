-- 2026-06-09: Voice unification (#26) is done. "Voice (Gemini Live)" became the
-- unified "Voice" addon (provider local/gemini/mistral + configurable endpoint).
-- The legacy "Voice Mode" addon row — the pre-refactor auto-speak/VibeVoice
-- toggle that 0036 deliberately KEPT as "refactor pending" — is now fully
-- covered by Voice's `local` provider and is referenced by no code (the chat
-- auto-speak toggle is client-side localStorage `companion:voiceMode`, not this
-- row). Drop it so the Add-ons page shows a single voice entry.
DELETE FROM addons WHERE name = 'Voice Mode';

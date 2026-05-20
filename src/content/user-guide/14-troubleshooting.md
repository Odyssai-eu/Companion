# Troubleshooting

## Inference

**"No instance found for model X" / 404 on send**
The selected model isn't loaded on its server. For Odysseus / exo / MLX, load it from the engine's interface; for cloud APIs, double-check the model id and that your bearer token has access to it.

**OpenRouter shows 0 cloud models**
Make sure the server URL is just `openrouter.ai` (no path) and the bearer is your OpenRouter API key. Companion hits `/api/v1/models` for OpenRouter specifically.

**Anthropic 400 on send**
Anthropic rejects requests with both `temperature` and `top_p`. Companion drops `top_p` automatically for Claude routes — if you still see this, the request is hitting a non-standard alias. Report the model id.

**Streaming hangs after a few hundred tokens**
A flaky tunnel between your browser and Cloudflare can stall SSE. Reload the conversation — partial replies are saved.

## Tools / agent mode

**Agent mode is on but no tools fire**
Check the model picker for the **⚒** chip. Without it, the model can't call tools regardless of agent mode. Pick a tool-capable model (Qwen3-Coder, Claude 4.x, GPT-4o, Argo, …).

**Skill tools are missing from `tools/list`**
They're always-on for any tool-capable model. If they're missing, your model isn't tool-capable — see above.

**MCP server returns 0 tools after add**
First chat after adding a server pays a synchronous `tools/list` fetch. If that fetch fails (auth, DNS, 5xx), the cache stays empty. Open the row → **Refresh** to retry.

## Voice

**TTS doesn't speak**
Voxtral-Realtime needs to be reachable. Check *Settings → Inference* — the TTS health probe is queried on Voice mode toggle.

**Audio cuts mid-sentence**
Usually a network hiccup against the TTS server. Voice mode falls back to text-only after one failed segment; toggle it off and back on to retry.

**Push-to-talk transcribes empty / wrong language**
The browser's Web Speech API follows the OS locale. Set the browser language to the one you're speaking.

## Editing / regenerating

**Edit/Regenerate doesn't truncate the chat history on reload**
The truncation runs as a fire-and-forget DELETE. If your network drops at the wrong moment, the old turns can stick around. Re-edit and they'll be wiped on the next attempt.

## Attachments

**PDF chip shows `Np (of N)` after upload**
Your PDF is longer than 20 pages and was truncated. Split it.

**Image attached but the model says "I can't see images"**
Either the model isn't vision-capable (no **👁** chip) or it's running through a provider that strips images. Pick a vision model from the picker.

## Memory & projects

**Project wiki entries don't show up in chat**
The conversation freezes a memory snapshot at creation. New entries written *after* that won't appear in already-open chats. Open a new chat to pick them up.

**Global wiki search returns nothing**
RAG ingestion may have lagged behind a vault edit. Wait ~30s, retry. If still empty, check the RAG status:

```bash
curl -s http://192.168.86.44:8080/status
curl -s http://192.168.86.44:6333/collections
```

## UI

**Mobile sidebar gets stuck open**
Tap the dimmed backdrop, or press Esc.

**Cmd+K doesn't focus search**
A browser extension may be intercepting it (1Password, Raindrop, …). Disable on `dev.thecomp.ai` or use the mouse.

## Still stuck

- Check *Settings → User Guide* for the topic that matches your situation.
- Look at the network panel — the API returns explicit error messages, not generic 500s.
- Tell Sophie. The bear listens.

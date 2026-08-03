# Troubleshooting

Grouped by surface. If you're not sure where to look, hit ⌘F and search this page.

## Inference

**"No instance found for model X" / 404 on send**
The selected model isn't loaded on its server. For OdyssAI-X / exo / MLX, load it from the engine's interface; for cloud APIs, double-check the model id and that your bearer token has access to it.

**OpenRouter shows 0 cloud models**
Make sure the server URL is just `openrouter.ai` (no path) and the bearer is your OpenRouter API key. Companion hits `/api/v1/models` for OpenRouter specifically.

**Anthropic 400 on send**
Anthropic rejects requests with both `temperature` and `top_p`. Companion drops `top_p` automatically for Claude routes — if you still see this, the request is hitting a non-standard alias. Report the model id.

**Streaming hangs after a few hundred tokens**
A flaky tunnel between your browser and Cloudflare can stall SSE. Reload the conversation — partial replies are saved. Recurrent issue → check the tunnel logs.

**TTFT is suddenly 10x slower**
You're hitting a cold prefill on a long conversation. The cache busts when:
- You switch models mid-conversation.
- The wiki snapshot refreshes ("Remember now").
- The engine restarts and loses its prefix cache.
Next turn after warm-up will be back to normal.

**Reply is mostly `<think>…</think>` and very short visible content**
A thinking model with too low a `max_tokens`. Bump it. Qwen3-thinking needs ~16k to leave room for the visible reply after reasoning.

**Reply gibberish, weird unicode, broken French**
Either:
- KV cache desync (rare — reload conversation usually fixes).
- Wrong model template (the engine is routing to a model with a different chat template than the alias suggests). Report the alias.
- Quantization too aggressive (e.g. 4-bit MLX on a model that needs 8-bit for stable French). Try a higher quant.

## Tools / agent mode

**Agent mode is on but no tools fire**
Check the model picker for the **⚒** chip. Without it, the model can't call tools regardless of agent mode. Pick a tool-capable model — any reasonably recent code or instruct model with native tool-calling will do.

**Skill tools are missing from `tools/list`**
They're always-on for any tool-capable model. If they're missing, your model isn't tool-capable — see above.

**MCP server returns 0 tools after add**
First chat after adding a server pays a synchronous `tools/list` fetch. If that fetch fails (auth, DNS, 5xx), the cache stays empty. Open the row → **Refresh** to retry.

**MCP tool returns auth error mid-conversation**
Token expired or revoked on the provider side. Open the MCP servers page → click the failing row → **Reconnect** (for OAuth) or update the bearer.

**Notion / Linear OAuth dance loops back to the consent screen**
You denied a scope. Reconnect and grant all requested scopes — Companion needs the full set to expose all the tools.

## Slash commands & add-ons

**`/comfyui` opens the modal but generation fails immediately**
Check the bridge URL in *Settings → Add-ons → ComfyUI Imager*. The bridge must be reachable from Companion's server (not the browser) — on the same LAN or via tunnel. Click **Test connection** to verify.

**`/hermes` enters mode but the terminal panel stays blank**
Either the bridge is down or unreachable. Open *Settings → Add-ons → Hermes Agent* → **Test connection**. If it returns 503, the Hermes bridge process isn't running on your workstation. Restart it.

**`/help` returns "no articles matched"**
The BM25 index wasn't loaded at server startup (missing `src/content/user-guide/` in the container). Check `GET /api/help/status` — if `indexed` is 0, the corpus path is wrong. Set `HELP_CORPUS_DIR` env var to the correct path.

**`/exit` doesn't work, the chip stays above the composer**
The `setConversationActiveAgent` call failed (network error). Reload the page — on reload, the conversation state is re-fetched and mode is cleared server-side.

## Voice

**Push-to-talk transcribes empty / wrong language**
The browser's Web Speech API follows the OS locale. Set the browser language to the one you're speaking. On macOS: System Preferences → Language. On Linux: depends on browser.

**Browser asks for mic on every reload**
Some browsers don't persist the mic permission. Pin Companion as a PWA, or set a permanent permission in browser settings (Site Settings → Microphone → Allow).

## Editing / regenerating

**Edit/Regenerate doesn't truncate the chat history on reload**
The truncation runs as a fire-and-forget DELETE. If your network drops at the wrong moment, the old turns can stick around. Re-edit and they'll be wiped on the next attempt.

**Ghost answer — reply visible during stream, gone on reload**
You hit one of the inference-state races. If it recurs, tell us with the conversation id so we can dig the logs.

**Continue button doesn't continue, makes a new turn instead**
Continue is meant for partial replies that hit `max_tokens`. If the previous reply ended cleanly with `finish_reason=stop`, Continue starts a new turn. Use Regenerate instead.

## Attachments

**PDF chip shows `Np (of N)` after upload**
Your PDF is longer than 20 pages and was truncated. Split it manually or use *Settings → Add-ons → Document* (when on the roadmap) for bigger docs.

**Image attached but the model says "I can't see images"**
Either the model isn't vision-capable (no **👁** chip) or it's running through a provider that strips images. Pick a vision model from the picker.

**Pasted image shows as red chip "too large"**
> 1 MB. Crop / resize before pasting. Cloud models especially can't handle full-res 4K screenshots.

**Drag-drop doesn't work**
Your browser may have file-drop disabled (corporate policy, hardened profile). Use the paperclip picker.

## Memory & projects

**Project wiki entries don't show up in chat**
The conversation freezes a memory snapshot at creation. New entries written *after* that won't appear in already-open chats. Open a new chat to pick them up, or click **Remember now** on the existing chat.

**Global wiki search returns nothing**
RAG ingestion may have lagged behind a vault edit. Wait ~30s, retry. If still empty, check the RAG service status on whichever host you deployed it to (`<rag-host>:8080/status` for the Docling ingestion service, `<rag-host>:6333/collections` for the Qdrant vector store).

**Némo writes in a register I didn't expect** (Baudelaire-mystic, robot-functional, anything weird)
Likely the wiki has too few constraints. Fill in `profile/preferences.md` + `profile/writing-guide.md` in your wiki with concrete style rules. Mark them `edited_by_user=true` so the compiler doesn't drift them.

**A conversation polluted the wiki**
Set `memoryEnabled = false` on conversations that shouldn't compile. Already-compiled diffs are harder to undo — fix the affected articles manually and lock with `edited_by_user=true`.

## MCP / API access

**`hms_…` token shows "401" from my IDE agent**
Token revoked / expired, or wrong URL. Verify the token is in the active list at *Settings → Extensions → API access*. Verify the URL is exactly `<your-companion>/api/mcp` with no trailing slash or path.

**MCP request times out at 45s**
Long reasoner runs need the non-blocking pattern. Use `companion_send_message` (returns immediately) + `companion_get_inference_status` polling instead of expecting the message tool to block.

**tools/list works but tools/call returns "method not found"**
Server-side tool name mismatch. Verify the exact tool name returned by `tools/list` and pass it verbatim to `tools/call`.

## UI

**Mobile sidebar gets stuck open**
Tap the dimmed backdrop, or press Esc.

**⌘K doesn't focus search**
A browser extension may be intercepting it (1Password, Raindrop, …). Disable on your Companion host or use the mouse.

**Sidebar shows duplicates of a conversation**
Polling race — refresh. If persistent, report with the conversation id.

**Model picker is empty after engine pairing**
The pairing succeeded but `/v1/models` returned []. Either the engine has no models loaded (typical with an idle OdyssAI-X) or the response shape is wrong. Hit the engine directly: `curl http://<engine>:8000/v1/models`.

## Performance

**Conversation feels sluggish, every turn is slow**
Long prompts → long prefill. Reasons:

- Huge wiki snapshot (~50 KB injected every turn).
- Many MCP servers enabled (each tool definition adds tokens).
- Long conversation history.

Fixes: turn off Agent mode if you don't need tools, disable unused MCP servers, prune the wiki, fork into a fresh conversation when one drags on.

**TTFT degrades over a long session on the cluster**
JACCL queue pair degradation — known upstream MLX/JACCL bug on RDMA-backed pools. Reboot the affected nodes. Smaller cluster sizes (2-node pipeline-AP) tend to be more stable than larger ones for long-running sessions.

## Still stuck

- Check *Settings → User Guide* for the topic that matches your situation.
- Look at the network panel — the API returns explicit error messages, not generic 500s.
- Look at `docker logs companion-app` (admin access).
- Open an issue on the repo with the failing request id (`req_…` in network panel) — admins can grep logs by that id.

## Related

- *Engine pairing* (16) — pairing failures
- *Privacy & data* (18) — when something looks like a privacy issue
- *FAQ* (22) — common confusions before they become bugs

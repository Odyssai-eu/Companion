# Voice & Talk

Companion has two voice surfaces: **push-to-talk** (overlay on the normal chat) and **Talk mode** (a dedicated full-screen voice surface). And separately, **auto-speak** for assistant replies.

## Push-to-talk

Hold **Space** anywhere outside a text input to dictate. Release to send.

- Uses your browser's Web Speech API — **no audio leaves your device** for transcription. The transcript drops into the input; you can edit it before sending if needed.
- Visual cue: while Space is held, the input bar shows a red recording dot + "Listening…" label.
- Auto-language: follows your browser's speech-recognition locale (which usually follows OS locale).

The transcript fills the input bar, not the conversation. You can review/edit before pressing Enter. This is intentional — voice transcription mishears, and a one-shot "you said this, I'm sending it" flow generates more frustration than the half-second saved.

## Voice mode (auto-speak)

Toggle the **speaker** icon in the chat header.

When on, every assistant reply is **streamed through TTS** as it generates. First audio plays in under 100 ms; the stream is gapless across sentence boundaries.

Two TTS backends, configurable per-user:

- **Voxtral-Realtime** (default) — local LAN, French + English. Lives on a server you point Companion at via *Settings → Inference → TTS endpoint*.
- **Voice (Gemini Live)** (cloud) — addon. Full-duplex, multi-language. Configure in Settings → Extensions → Add-ons → Voice (Gemini Live).

Voice mode pairs naturally with push-to-talk: hold Space, speak, release; the reply auto-speaks back. Hands stay on the keyboard.

### Per-message controls

In the action row under each assistant reply (with voice mode on):

- **Listen** — replay the spoken version.
- **Stop** — interrupt playback (also Esc).
- **Save WAV** — download the spoken reply as 24 kHz mono WAV.

The saved WAV is the same audio that played — useful for archiving or sharing.

## Talk mode (full-screen)

The **🎙 Talk** button at the bottom of the sidebar opens a dedicated full-screen voice surface:

- Large mic in the middle.
- Big assistant reply card.
- No sidebar, no chat chrome.
- Hands-free use on a phone, or as the primary interface for a focused conversation.

Behind the scenes, a Talk conversation is just a regular conversation with `kind='talk'` set. It shows up in your sidebar with a small 🎙 badge — you can re-open it later in normal chat view if you want to scroll back as text.

The model picker is **hidden** in Talk mode — Talk uses the model defined in *Settings → Inference → Talk model* (default `om:qwen-35b`). The reasoning: voice rewards short responsive turns; a single curated model fits better than mid-talk picker-fumbling.

## Languages

- **Push-to-talk** follows the browser's Web Speech locale. Set it to the language you'll speak (browser settings).
- **TTS** follows the engine. Voxtral-Realtime handles English and French natively; for other languages, set the engine accordingly or use Gemini Live (broader coverage).

## What stays local vs goes through the engine

- **Push-to-talk transcription** — 100% client-side. No audio ever leaves your browser.
- **TTS output** — Voxtral: streamed from your LAN TTS server. Gemini Live: streamed from Google.
- **Assistant text** — same as a regular chat. Goes through the inference engine.

For full privacy when discussing sensitive matters: use Voxtral over LAN with Voice mode toggled on. No cloud touches the conversation.

## Troubleshooting voice

- **Browser asks for mic on every reload** — that's the Web Speech API; some browsers don't persist the permission. Pin Companion as a PWA, or grant the site permanent mic permission in browser settings.
- **TTS doesn't speak** — Voxtral-Realtime needs to be reachable. Settings → Inference → TTS health probe should be green. If red: check the TTS server is running and the URL/port match.
- **Audio cuts mid-sentence** — usually a network hiccup against the TTS server. Voice mode falls back to text-only after one failed segment; toggle it off and back on to retry.
- **Push-to-talk transcribes empty / wrong language** — the browser's Web Speech API follows the OS locale. Set the browser language to the one you're speaking.
- **Space inserts a literal space instead of recording** — your focus is inside a text input. Click outside the input first (anywhere on the message area). The dot won't appear while you're focused in a typeable element.

## Related

- *Chat basics* (05) — the regular chat flow
- *Inference settings* (14) — TTS endpoint config
- *Engine pairing* (16) — where the TTS server is configured
- *Troubleshooting* (20) — voice-specific issues

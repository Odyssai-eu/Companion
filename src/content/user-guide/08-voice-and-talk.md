# Voice & Talk

Companion has two voice surfaces: **push-to-talk** (overlay on the normal chat) and **Talk mode** (a dedicated full-screen voice surface). And separately, **auto-speak** for assistant replies.

## Push-to-talk

Hold **Space** anywhere outside a text input to dictate. Release to send.

- Uses your browser's Web Speech API — **no audio leaves your device** for transcription. The transcript drops into the input; you can edit it before sending if needed.
- Visual cue: while Space is held, the input bar shows a red recording dot + "Listening…" label.
- Auto-language: follows your browser's speech-recognition locale (which usually follows OS locale).

The transcript fills the input bar, not the conversation. You can review/edit before pressing Enter. This is intentional — voice transcription mishears, and a one-shot "you said this, I'm sending it" flow generates more frustration than the half-second saved.

## Voice mode (auto-speak)

> **Status — coming.** Voice mode (assistant replies streamed through TTS) is on the roadmap. The planned backend is **Gemini Flash Live** as the TTS engine. The speaker icon and per-message Listen / Stop / Save WAV controls will appear once the add-on ships. Push-to-talk (above) works today and is independent of this.

## Talk mode (full-screen)

> **Status — coming.** Talk mode is paired with Voice mode (above) and ships when the auto-speak backend lands. The 🎙 Talk button is reserved; the full-screen voice surface is on the roadmap.

## Languages

- **Push-to-talk** follows the browser's Web Speech locale. Set it to the language you'll speak (browser settings).

## What stays local vs goes through the engine

- **Push-to-talk transcription** — 100% client-side. No audio ever leaves your browser.
- **Assistant text** — same as a regular chat. Goes through the inference engine.

## Troubleshooting voice

- **Browser asks for mic on every reload** — that's the Web Speech API; some browsers don't persist the permission. Pin Companion as a PWA, or grant the site permanent mic permission in browser settings.
- **Push-to-talk transcribes empty / wrong language** — the browser's Web Speech API follows the OS locale. Set the browser language to the one you're speaking.
- **Space inserts a literal space instead of recording** — your focus is inside a text input. Click outside the input first (anywhere on the message area). The dot won't appear while you're focused in a typeable element.

## Related

- *Chat basics* (05) — the regular chat flow
- *Troubleshooting* (20) — voice-specific issues

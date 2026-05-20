# Voice

## Push-to-talk

Hold **Space** anywhere outside a text input to dictate. Release to send.

Push-to-talk uses your browser's Web Speech API — **no audio leaves your device** for transcription. The transcript drops into the input; you can edit it before sending if needed.

## Voice mode (auto-speak replies)

Toggle the **speaker** icon in the top bar, or open the **Talk** view from the sidebar bottom button.

Replies are streamed through Voxtral-Realtime running on your TTS server (configured in *Settings → Inference*). First audio plays in under 100 ms; the stream is gapless across sentence boundaries.

Per-message controls live in the action row under each assistant reply:

- **Listen** — replay the spoken version.
- **Stop** — interrupt playback.
- **Save WAV** — download the spoken reply as 24 kHz mono WAV.

## Talk view

The **Talk** button in the sidebar opens a dedicated full-screen voice surface — large mic, large reply, no chat chrome. Useful for hands-free use on a phone or when you want voice to be the primary interface.

## Languages

Push-to-talk follows your browser's speech-recognition language. TTS follows the engine — Voxtral-Realtime handles English and French natively; for other languages, set the engine accordingly.

## Troubleshooting voice

- **Browser asks for mic on every reload** — that's the Web Speech API; some browsers don't persist the permission. Pin Companion as a PWA or set a permanent permission in browser settings.
- **TTS doesn't speak** — Voxtral-Realtime needs to be reachable. Check *Settings → Inference* for the TTS server health probe.
- **Audio cuts mid-sentence** — usually a network hiccup against the TTS server. Voice mode falls back to text-only after one failed segment; toggle it off/on to retry.

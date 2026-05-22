# Attachments

Three ways to attach: click the **📎 paperclip**, drag files onto the input, or paste an image from clipboard. Multiple at once is fine.

## Text & code

These are read as text and inlined as fenced code blocks in your message:

`.txt` `.md` `.json` `.py` `.js` `.ts` `.tsx` `.jsx` `.csv` `.yaml` `.yml` `.toml` `.sh` `.bash` `.zsh` `.html` `.css` `.scss` `.xml` `.log` `.ini` `.conf` `.env.example`

The file content goes inside a fence with the language hint inferred from the extension. Large files are sent **as-is** — Companion doesn't summarise. If you want only a slice, paste it directly instead.

**Limits per file**: 200 KB hard cap. Beyond that the chip turns red and the message blocks sending.

**Limits per message**: 1 MB total across attachments. Image+PDF rasters are heavy — that cap is conservative for a reason.

## Images

`image/*` files are sent as multimodal `image_url` parts. Your model needs to be vision-capable (look for the **👁** chip on the model picker).

The image preview stays in the bubble so you can scroll back and see what you sent. The image is base64-encoded into the message body (data URI) when stored — so it's self-contained and survives export to `.md`.

Supported formats : PNG, JPEG, WebP, GIF (first frame only — not animated input).

Resolution recommendation: keep under 1600×1600 for cloud models (token cost grows quadratically with side length). Local cluster doesn't bill, but big images slow first-token time.

## PDFs

PDFs are processed **in your browser** with pdf.js — nothing is uploaded for OCR. Each page contributes:

- the **extracted text** (machine-readable text from the PDF), and
- a **rasterised PNG** so vision models can read figures, tables, charts, and scanned content.

**Cap: 20 pages per PDF.** Past that the file is truncated and the chip shows `Np (of N)` to make the cut obvious. Split the document if you need more.

If the PDF is text-only (no figures), the model gets just the text — cheap. If you need the model to see a chart, vision is automatic.

**Encrypted PDFs**: not supported (pdf.js refuses to render). Unlock first.

## Audio (Voice attachments)

When Voice mode ships, the response will be auto-spoken AND saved (see *Voice & talk*, 08).

Sending audio TO the model isn't supported in the input bar — push-to-talk transcribes locally and sends text. For audio-in to a multi-modal model, paste a transcript.

## Removing an attachment

Click the **×** on the chip before sending. After sending, the attachment is part of the message — to drop it, edit the message (pencil) and remove the chip.

## How attachments look in storage

In `messages.content` (the DB), an attachment-bearing message is stored as a multi-part array:

```json
[
  { "type": "text", "text": "look at this figure" },
  { "type": "image_url", "image_url": { "url": "data:image/png;base64,…" } }
]
```

That's the OpenAI multimodal shape. Companion preserves it across export, import, and engine routing.

## Cost & latency caveats

- **Cloud models** bill per token, and image tiles count. A 20-page PDF with figures can easily push 100k+ tokens.
- **Local cluster models** don't bill but each image adds prefill time. A vision turn on a local pool with a 5-image batch is significantly slower than a text turn.
- **First-token latency** is dominated by prefill, which scales with prompt size. PDFs especially can make TTFT jump from 1s to 10s.

If you're getting slow replies on a chat with attachments, that's not a bug — it's the prefill cost.

## Drag, drop, paste

- **Drag onto input** — works anywhere on the input bar surface, even from another browser tab (with the appropriate origin permissions).
- **Drag onto chat area** — works during typing. The bar highlights when a drop is valid.
- **Paste an image** — ⌘V / Ctrl+V from clipboard (screenshot, image from another app). Companion detects `image/*` types in the clipboard.
- **Paste text** — pastes as plain text into the input. To attach as a file, use the paperclip.

## What's NOT supported

- Video (no `video/*` MIME).
- Audio-in to LLMs (use push-to-talk transcription instead).
- Document formats other than PDF/text (no .docx, .xlsx, .pptx natively — convert to PDF or paste text).
- ZIP archives (extract first).

## Related

- *Voice & talk* (08) — push-to-talk, voice mode, WAV download
- *Model picker* (06) — picking a vision-capable model
- *Exports & imports* (17) — how attachments are preserved when you export a conversation

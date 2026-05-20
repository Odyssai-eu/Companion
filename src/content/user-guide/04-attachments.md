# Attachments

Three ways to attach: click the **paperclip**, drag files onto the input, or paste an image from the clipboard.

## Text & code

These are read as text and inlined as fenced code blocks in your message:

`.txt` `.md` `.json` `.py` `.js` `.ts` `.tsx` `.csv` `.yaml` `.toml` `.sh` `.html` `.css` `.xml` `.log`

Large files are sent as-is — Companion doesn't summarise. If you only want a slice, paste it directly.

## Images

`image/*` files are sent as multimodal `image_url` parts. Your model needs to be vision-capable (look for the **👁** chip on the model picker).

The image preview stays in the bubble so you can scroll back and see what you sent.

## PDFs

PDFs are processed **in your browser** with pdf.js — nothing is uploaded for OCR. Each page contributes:

- the extracted text, and
- a rasterised PNG so vision models can read figures, tables, and charts.

**Cap: 20 pages per PDF.** Past that, the file is truncated and the chip shows `Np (of N)` to make the cut obvious. Split the document if you need more.

## Removing an attachment

Click the **×** on the chip before sending. After sending, the attachment is part of the message — edit the message (pencil) to drop it.

## Cost & latency caveat

- Images and PDF rasters can be heavy. A 20-page PDF with images can push you past 1 MB of input.
- Cloud models bill per token — image tiles count. Local cluster models don't bill but a long image batch will slow first-token time.

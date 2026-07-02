// Client-side file attachments for the chat input.
// Mirrors ExoScopy's ergonomics:
//   - Text/code files are read as text and embedded as fenced markdown blocks
//     in the user message.
//   - Images are read as data URLs and sent as multimodal `image_url` parts.
//   - PDFs are processed client-side with pdf.js — up to MAX_PDF_PAGES pages,
//     each page contributing extracted text + a rasterised PNG.
//
// Storage trade-off: we never want a 5 MB image data URL hitting Postgres,
// so the persisted version of the user message is a flat text rendition with
// `[Image: filename]` markers. Live multimodal payload goes to the model only.

import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export const ACCEPT_ATTR =
  ".txt,.md,.json,.py,.js,.ts,.jsx,.tsx,.csv,.yaml,.yml,.toml,.sh,.html,.css,.xml,.log,.pdf,.docx,.doc,.pptx,.xlsx,image/*,application/pdf";

const MAX_PDF_PAGES = 20;
const PDF_RENDER_SCALE = 1.5;

// Suffixes routed to the server-side Docling parser (the Parser add-on),
// when it is enabled. The raw bytes are uploaded as a `document`
// content-part; the server swaps in the extracted markdown before the
// engine call. csv/md/html are here too — Docling extracts cleaner tables
// than a raw text read — but degrade gracefully to an inline text block
// when the add-on is off. .pdf is handled separately (pdf.js rasterize vs
// Docling) based on the add-on's pdfMode.
const DOCLING_SUFFIXES = new Set([
  "docx",
  "doc",
  "pptx",
  "xlsx",
  "csv",
  "md",
  "html",
]);

// Binary office suffixes that cannot be read as text — without the Parser
// add-on there is nothing useful we can do with them client-side.
const BINARY_DOC_SUFFIXES = new Set(["docx", "doc", "pptx", "xlsx"]);

/** Cap on a single raw document upload. Kept in sync with the add-on's
 *  default maxUploadBytes (20 MB) — the server re-checks against the
 *  per-user config, this is just a client-side guard. */
const MAX_DOCUMENT_BYTES = 20_000_000;

/** Parser add-on state, passed into processFile/buildUserMessage so the
 *  composer routes documents to the server-side Docling parser. */
export type ParserConfig = {
  enabled: boolean;
  pdfMode: "text" | "vision";
};

export type TextAttachment = {
  kind: "text";
  id: string;
  name: string;
  size: number;
  content: string;
};

export type ImageAttachment = {
  kind: "image";
  id: string;
  name: string;
  size: number;
  mimeType: string;
  dataUrl: string;
};

export type PdfPage = {
  pageNum: number;
  text: string;
  dataUrl: string; // PNG raster
};

export type PdfAttachment = {
  kind: "pdf";
  id: string;
  name: string;
  size: number;
  processing: boolean;
  progress?: string; // "3/12"
  error?: string;
  totalPages?: number;
  processedPages?: number;
  truncated?: boolean;
  pages?: PdfPage[];
  thumbnail?: string;
};

/** A document routed to the server-side Docling parser. Carries the RAW
 *  bytes as a data URL + the filename; the server decodes, calls Docling,
 *  and swaps in the extracted markdown before the engine call. */
export type DocumentAttachment = {
  kind: "document";
  id: string;
  name: string;
  size: number;
  mimeType: string;
  dataUrl: string;
  /** True when the file exceeds MAX_DOCUMENT_BYTES — kept in the chip so the
   *  user sees why it won't be sent; excluded from the outgoing message. */
  tooLarge?: boolean;
};

export type Attachment =
  | TextAttachment
  | ImageAttachment
  | PdfAttachment
  | DocumentAttachment;

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  // Raw-document part — stripped server-side (parseDocumentParts) into a
  // text part with the Docling markdown. Never reaches the engine as-is.
  | { type: "document"; document: { name: string; url: string; mime?: string } };

function uid(prefix = "att") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isImageMime(file: File) {
  return file.type.startsWith("image/");
}

function isPdf(file: File) {
  return (
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
  );
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function suffixOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

async function makeDocumentAttachment(file: File): Promise<DocumentAttachment> {
  const dataUrl = await readAsDataUrl(file);
  return {
    kind: "document",
    id: uid("doc"),
    name: file.name,
    size: file.size,
    mimeType: file.type || "application/octet-stream",
    dataUrl,
    tooLarge: file.size > MAX_DOCUMENT_BYTES,
  };
}

export async function processFile(
  file: File,
  onPdfProgress?: (id: string, processed: number, total: number) => void,
  parserConfig?: ParserConfig,
): Promise<Attachment> {
  if (isImageMime(file)) {
    const dataUrl = await readAsDataUrl(file);
    return {
      kind: "image",
      id: uid("img"),
      name: file.name,
      size: file.size,
      mimeType: file.type,
      dataUrl,
    };
  }
  if (isPdf(file)) {
    // PDF routing is governed by the Parser add-on's pdfMode:
    //   text (default) + enabled → server-side Docling (a `document` part).
    //   vision / disabled         → existing pdf.js rasterize path.
    if (parserConfig?.enabled && parserConfig.pdfMode === "text") {
      return makeDocumentAttachment(file);
    }
    const id = uid("pdf");
    return processPdfFile(file, id, onPdfProgress);
  }
  const suffix = suffixOf(file.name);
  // Docling-supported document → route to the server-side parser when the
  // add-on is enabled; else fall back to an inline text read (fine for
  // csv/md/html, garbage for binary office files but that's pre-existing).
  if (DOCLING_SUFFIXES.has(suffix)) {
    if (parserConfig?.enabled) {
      return makeDocumentAttachment(file);
    }
    if (BINARY_DOC_SUFFIXES.has(suffix)) {
      // No parser + binary → we can't read it as text. Surface a doc chip
      // flagged tooLarge=false but carry a note via the text path below is
      // not possible; keep it as a document attachment so the user still
      // sees the chip and the disabled-note fires server-side.
      return makeDocumentAttachment(file);
    }
  }
  const content = await readAsText(file);
  return {
    kind: "text",
    id: uid("txt"),
    name: file.name,
    size: file.size,
    content,
  };
}

async function processPdfFile(
  file: File,
  id: string,
  onProgress?: (id: string, processed: number, total: number) => void,
): Promise<PdfAttachment> {
  try {
    const buf = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    const total = doc.numPages;
    const limit = Math.min(total, MAX_PDF_PAGES);
    const pages: PdfPage[] = [];
    for (let i = 1; i <= limit; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas_unavailable");
      // pdfjs >=4 wants `canvas` in the params alongside canvasContext.
      // We pass both for safety across versions.
      await page.render({
        canvasContext: ctx,
        viewport,
        canvas,
      } as Parameters<typeof page.render>[0]).promise;
      const text = (await page.getTextContent()).items
        .map((it) => ("str" in it ? (it as { str: string }).str : ""))
        .join(" ");
      pages.push({
        pageNum: i,
        text,
        dataUrl: canvas.toDataURL("image/png"),
      });
      onProgress?.(id, i, limit);
    }
    return {
      kind: "pdf",
      id,
      name: file.name,
      size: file.size,
      processing: false,
      totalPages: total,
      processedPages: limit,
      truncated: total > limit,
      pages,
      thumbnail: pages[0]?.dataUrl,
    };
  } catch (e) {
    return {
      kind: "pdf",
      id,
      name: file.name,
      size: file.size,
      processing: false,
      error: (e as Error).message ?? "pdf_failed",
    };
  }
}

/**
 * Build the user message that gets sent to the model and the flat text
 * snapshot that gets persisted to the DB.
 *
 * Returns:
 *   - `content`: string OR ContentPart[] (multimodal). String when only text
 *     attachments and no images/PDFs.
 *   - `persistText`: flat string for the conversation log.
 */
export function buildUserMessage(
  prompt: string,
  attachments: Attachment[],
): { content: string | ContentPart[]; persistText: string } {
  const text = prompt.trim();

  const textAtt = attachments.filter(
    (a): a is TextAttachment => a.kind === "text",
  );
  const imageAtt = attachments.filter(
    (a): a is ImageAttachment => a.kind === "image",
  );
  const pdfAtt = attachments.filter(
    (a): a is PdfAttachment =>
      a.kind === "pdf" && !a.error && !!a.pages?.length,
  );
  // Documents routed to the server-side Docling parser. Oversized ones are
  // dropped from the outgoing payload (chip still shows tooLarge).
  const docAtt = attachments.filter(
    (a): a is DocumentAttachment => a.kind === "document" && !a.tooLarge,
  );

  // Text/code blocks always go inline as markdown.
  const textBlocks = textAtt
    .map((f) => {
      const ext = f.name.includes(".") ? f.name.split(".").pop() : "";
      return `**[${f.name}]**\n\`\`\`${ext}\n${f.content}\n\`\`\``;
    })
    .join("\n\n");

  const inlineText = [textBlocks, text].filter(Boolean).join("\n\n");

  const hasMultimodal =
    imageAtt.length > 0 || pdfAtt.length > 0 || docAtt.length > 0;

  if (!hasMultimodal) {
    return {
      content: inlineText,
      persistText: inlineText,
    };
  }

  const parts: ContentPart[] = [];
  if (inlineText) parts.push({ type: "text", text: inlineText });

  for (const img of imageAtt) {
    parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
  }

  // Raw-document parts — the server (parseDocumentParts) forwards each to
  // Docling and swaps in the extracted markdown before the engine call.
  for (const doc of docAtt) {
    parts.push({
      type: "document",
      document: { name: doc.name, url: doc.dataUrl, mime: doc.mimeType },
    });
  }

  for (const pdf of pdfAtt) {
    const header = `**[${pdf.name}] — ${pdf.processedPages} page${
      (pdf.processedPages ?? 0) > 1 ? "s" : ""
    }${pdf.truncated ? ` (truncated from ${pdf.totalPages})` : ""}**`;
    parts.push({ type: "text", text: header });
    for (const page of pdf.pages ?? []) {
      if (page.text.trim()) {
        parts.push({
          type: "text",
          text: `Page ${page.pageNum}:\n${page.text}`,
        });
      }
      parts.push({ type: "image_url", image_url: { url: page.dataUrl } });
    }
  }

  // Flat persistence: prompt + markers for opaque attachments
  const markers: string[] = [];
  if (textBlocks) markers.push(textBlocks);
  for (const img of imageAtt) markers.push(`[Image: ${img.name}]`);
  for (const pdf of pdfAtt)
    markers.push(`[PDF: ${pdf.name} — ${pdf.processedPages}p]`);
  for (const doc of docAtt) markers.push(`[Document: ${doc.name}]`);
  const persistText = [markers.join("\n"), text].filter(Boolean).join("\n\n");

  return { content: parts, persistText };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

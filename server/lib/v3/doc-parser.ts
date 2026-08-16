// Server-side document-parse hook for the v3 send path (restored
// 2026-08-16 after the v1 kill removed the original server/lib/parser.ts).
//
// The Parser add-on (routes/addon-parser.ts) lets text-only models read
// attached documents. The browser uploads RAW document bytes as a
// `document` content-part (a data: URL + filename); this module forwards
// each to the Docling service, gets markdown back, and REPLACES the part
// with a plain text part so the model sees inline text. Images and text
// parts pass through unchanged.
//
// Fail-soft: a Docling error never blocks the turn — the offending part is
// replaced with a short note. Zero overhead when a message has no document
// parts (short-circuits before any DB / network call).

import { loadParserConfigForUser } from "../../routes/addon-parser";
import type { ContentPart } from "../prompt-builder";

export type DocumentContentPart = {
  type: "document";
  document: { name: string; url: string; mime?: string };
};

type AnyPart = ContentPart | DocumentContentPart;
type Msg = { role: string; content: unknown };

const SUPPORTED_SUFFIXES = new Set([
  "pdf", "docx", "doc", "pptx", "xlsx", "xls", "csv", "md", "html", "txt", "json",
]);

function suffixOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function isDocumentPart(p: unknown): p is DocumentContentPart {
  return (
    typeof p === "object" &&
    p !== null &&
    (p as { type?: unknown }).type === "document" &&
    typeof (p as DocumentContentPart).document?.url === "string"
  );
}

function decodeDataUrl(url: string): { bytes: Buffer; mime: string } | null {
  const m = url.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  const isBase64 = Boolean(m[2]);
  const payload = m[3];
  try {
    return {
      bytes: isBase64
        ? Buffer.from(payload, "base64")
        : Buffer.from(decodeURIComponent(payload), "utf-8"),
      mime,
    };
  } catch {
    return null;
  }
}

async function doclingParse(
  url: string,
  name: string,
  bytes: Buffer,
  mime: string,
): Promise<string> {
  const form = new FormData();
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  form.append("file", new Blob([view], { type: mime || "application/octet-stream" }), name);
  const res = await fetch(url, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail.slice(0, 200) || `Docling HTTP ${res.status}`);
  }
  const body = (await res.json()) as { markdown?: string };
  return body.markdown ?? "";
}

async function transformParts(
  parts: AnyPart[],
  cfg: { url: string; maxUploadBytes: number },
): Promise<ContentPart[]> {
  const out: ContentPart[] = [];
  for (const part of parts) {
    if (!isDocumentPart(part)) {
      out.push(part as ContentPart);
      continue;
    }
    const name = part.document.name || "document";
    const suffix = suffixOf(name);
    const decoded = decodeDataUrl(part.document.url);
    if (!decoded) {
      out.push({ type: "text", text: `\n\n[Document ${name} could not be parsed: unreadable upload]\n\n` });
      continue;
    }
    if (suffix && !SUPPORTED_SUFFIXES.has(suffix)) {
      out.push({ type: "text", text: `\n\n[Document ${name} could not be parsed: unsupported type .${suffix}]\n\n` });
      continue;
    }
    if (decoded.bytes.byteLength > cfg.maxUploadBytes) {
      out.push({ type: "text", text: `\n\n[Document ${name} could not be parsed: exceeds ${Math.round(cfg.maxUploadBytes / 1_000_000)}MB upload limit]\n\n` });
      continue;
    }
    try {
      const markdown = await doclingParse(cfg.url, name, decoded.bytes, part.document.mime || decoded.mime);
      out.push({ type: "text", text: `\n\n[Document: ${name}]\n\n${markdown}\n\n[End of document: ${name}]\n\n` });
    } catch (e) {
      out.push({ type: "text", text: `\n\n[Document ${name} could not be parsed: ${(e as Error).message}]\n\n` });
    }
  }
  return out;
}

function hasDocumentParts(messages: Msg[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && (m.content as unknown[]).some(isDocumentPart),
  );
}

/** Scan outgoing messages for document parts; when the Parser add-on is on,
 *  replace each with a Docling-parsed text part. Add-on off → a note (a raw
 *  document part is not a shape the engine accepts). Returns a NEW array. */
export async function parseDocumentParts<T extends Msg>(
  messages: T[],
  userId: string,
): Promise<T[]> {
  if (!hasDocumentParts(messages)) return messages;
  const cfg = await loadParserConfigForUser(userId);
  const mapped: T[] = [];
  for (const m of messages) {
    const content = m.content;
    if (!Array.isArray(content) || !(content as unknown[]).some(isDocumentPart)) {
      mapped.push(m);
      continue;
    }
    if (!cfg) {
      const cleaned = (content as AnyPart[]).map((p) =>
        isDocumentPart(p)
          ? { type: "text" as const, text: `\n\n[Document ${p.document.name || "attachment"} not parsed: the Parser add-on is disabled]\n\n` }
          : (p as ContentPart),
      );
      mapped.push({ ...m, content: cleaned });
      continue;
    }
    mapped.push({ ...m, content: await transformParts(content as AnyPart[], cfg) });
  }
  return mapped;
}

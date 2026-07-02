/**
 * Server-side document-parse hook for the chat send path.
 *
 * The Parser add-on (see ../routes/addon-parser.ts) lets text-only models
 * (MiniMax) read attached documents. The browser uploads the RAW document
 * bytes as a `document` content-part (a data: URL + filename); this module
 * — invoked from assembleMessages, the single choke-point both the
 * streaming and non-streaming send paths traverse — forwards each document
 * part to the Docling service, gets markdown back, and REPLACES the part
 * with a plain text part so the model sees it as inline text.
 *
 * Fail-soft: a Docling error never blocks the turn. The offending part is
 * replaced with a short "[Document <name> could not be parsed: <reason>]"
 * note and the message still sends.
 *
 * Zero overhead when a message has no document parts — parseDocumentParts
 * short-circuits before any DB / network call.
 */

import { loadParserConfigForUser } from "../routes/addon-parser";
import type { ContentPart } from "./prompt-builder";
import type { ChatTurn } from "../routes/chat";

/** Wire shape of a raw-document attachment part. The browser emits this for
 *  non-image attachments; it is stripped out here before the engine call.
 *  Kept structurally separate from ContentPart (which stays text|image_url,
 *  the only shapes the engine accepts). */
export type DocumentContentPart = {
  type: "document";
  document: { name: string; url: string; mime?: string };
};

type AnyPart = ContentPart | DocumentContentPart;

/** Suffixes Docling accepts (mirrors the backend). Used only as a sanity
 *  filter — the browser already tags a part as `document`, but we guard
 *  against a stray image sneaking in. */
const SUPPORTED_SUFFIXES = new Set([
  "pdf",
  "docx",
  "doc",
  "pptx",
  "xlsx",
  "csv",
  "md",
  "html",
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

/** Decode a `data:<mime>;base64,<payload>` URL into bytes + mime. Returns
 *  null for a non-data URL (we never fetch remote URLs from here). */
function decodeDataUrl(url: string): { bytes: Buffer; mime: string } | null {
  const m = url.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  const isBase64 = Boolean(m[2]);
  const payload = m[3];
  try {
    if (isBase64) {
      return { bytes: Buffer.from(payload, "base64"), mime };
    }
    return { bytes: Buffer.from(decodeURIComponent(payload), "utf-8"), mime };
  } catch {
    return null;
  }
}

/** Forward one document's bytes to Docling; return its markdown or throw. */
async function doclingParse(
  url: string,
  name: string,
  bytes: Buffer,
  mime: string,
): Promise<string> {
  const form = new FormData();
  // Copy into a fresh Uint8Array backed by a plain ArrayBuffer so the Blob
  // constructor's BlobPart typing is satisfied (Buffer's backing store is
  // typed as ArrayBufferLike, which TS rejects).
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  form.append(
    "file",
    new Blob([view], { type: mime || "application/octet-stream" }),
    name,
  );
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

/**
 * Transform a single message's content parts: for each document part,
 * call Docling and turn it into a text part; drop images/text through
 * unchanged. Returns the new parts array (never mutates the input).
 *
 * `pdfMode === "vision"` keeps PDFs on the existing rasterized-image path,
 * which the browser has ALREADY emitted as image_url parts — a PDF never
 * arrives as a `document` part in vision mode, so nothing special is
 * needed here; documents that DO arrive are always routed to Docling.
 */
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
      out.push({
        type: "text",
        text: `\n\n[Document ${name} could not be parsed: unreadable upload]\n\n`,
      });
      continue;
    }
    if (suffix && !SUPPORTED_SUFFIXES.has(suffix)) {
      out.push({
        type: "text",
        text: `\n\n[Document ${name} could not be parsed: unsupported type .${suffix}]\n\n`,
      });
      continue;
    }
    if (decoded.bytes.byteLength > cfg.maxUploadBytes) {
      out.push({
        type: "text",
        text: `\n\n[Document ${name} could not be parsed: exceeds ${Math.round(
          cfg.maxUploadBytes / 1_000_000,
        )}MB upload limit]\n\n`,
      });
      continue;
    }

    try {
      const markdown = await doclingParse(
        cfg.url,
        name,
        decoded.bytes,
        part.document.mime || decoded.mime,
      );
      out.push({
        type: "text",
        text: `\n\n[Document: ${name}]\n\n${markdown}\n\n[End of document: ${name}]\n\n`,
      });
    } catch (e) {
      out.push({
        type: "text",
        text: `\n\n[Document ${name} could not be parsed: ${(e as Error).message}]\n\n`,
      });
    }
  }
  return out;
}

/** True when any message carries a document content-part. Cheap pre-check
 *  so the common no-attachment turn does zero work. */
function hasDocumentParts(messages: ChatTurn[]): boolean {
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (Array.isArray(content) && content.some(isDocumentPart)) return true;
  }
  return false;
}

/**
 * Entry point for the chat send path. Scans the outgoing messages for
 * document parts and, when the Parser add-on is enabled for the user,
 * replaces each with a Docling-parsed text part. Returns a NEW array
 * (or the same reference when there is nothing to do).
 *
 * When a message has document parts but the add-on is disabled, the parts
 * are dropped (with a short note) rather than forwarded raw — a `document`
 * part is not a shape the engine accepts, so leaving it in would break the
 * request.
 */
export async function parseDocumentParts(
  messages: ChatTurn[],
  userId: string,
): Promise<ChatTurn[]> {
  if (!hasDocumentParts(messages)) return messages;

  const cfg = await loadParserConfigForUser(userId);

  const mapped: ChatTurn[] = [];
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content) || !content.some(isDocumentPart)) {
      mapped.push(m);
      continue;
    }
    if (!cfg) {
      // Add-on off — a document part can't go to the engine, so replace it
      // with a note instead of dropping the whole turn.
      const cleaned: ContentPart[] = (content as AnyPart[]).map((p) =>
        isDocumentPart(p)
          ? {
              type: "text",
              text: `\n\n[Document ${p.document.name || "attachment"} not parsed: the Parser add-on is disabled]\n\n`,
            }
          : (p as ContentPart),
      );
      mapped.push({ ...(m as object), content: cleaned } as ChatTurn);
      continue;
    }
    const newParts = await transformParts(content as AnyPart[], cfg);
    mapped.push({ ...(m as object), content: newParts } as ChatTurn);
  }
  return mapped;
}

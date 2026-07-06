/**
 * Document Producer — output hook (mirror of lib/parser.ts, opposite
 * direction). The Parser rewrites INCOMING document parts into text; this
 * scans the model's OUTGOING reply for document blocks and renders each into
 * a real Office file via the user's configured render service.
 *
 * The model emits, inside its reply:
 *   <doc:docx name="rapport.docx">
 *   # Rapport\n\n## Résumé …            (markdown)
 *   </doc:docx>
 *   <doc:xlsx name="ca.xlsx">
 *   { "sheets": [ … ] }                 (JSON spec)
 *   </doc:xlsx>
 *
 * `produceFromReply` is a PURE function (no coupling to the stream path): it
 * takes the assistant text + userId and returns the cleaned text plus the
 * produced files. The completion path calls it after the reply is collected
 * and attaches the files (mirror of the ComfyUI image-attachment path). Kept
 * decoupled so wiring it into the live stream is a small, well-tested step.
 */

import { loadProducerConfigForUser } from "../routes/addon-producer";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type ProducedFile = {
  name: string;
  mime: string;
  /** base64-encoded file bytes — safe for JSON transport + attachment store. */
  base64: string;
  bytes: number;
};

export type ProduceResult = {
  /** Reply text with the <doc:*> blocks replaced by a short marker. */
  text: string;
  files: ProducedFile[];
  /** Non-fatal render errors, surfaced so the UI can show them. */
  errors: string[];
};

// <doc:docx name="x.docx"> … </doc:docx>  /  <doc:xlsx …> … </doc:xlsx>
const BLOCK_RE =
  /<doc:(docx|xlsx)(?:\s+name="([^"]*)")?\s*>([\s\S]*?)<\/doc:\1>/g;

/** True if the reply contains at least one document block — lets the caller
 *  skip the add-on lookup entirely for normal replies (mirror of
 *  hasDocumentParts). */
export function hasDocBlocks(text: string): boolean {
  BLOCK_RE.lastIndex = 0;
  return BLOCK_RE.test(text);
}

async function renderOne(
  base: string,
  kind: "docx" | "xlsx",
  name: string,
  body: string,
): Promise<ProducedFile> {
  const url = `${base}/${kind}`;
  const payload =
    kind === "docx"
      ? { markdown: body, filename: name }
      : { spec: JSON.parse(body), filename: name };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `render ${kind} HTTP ${res.status}: ${detail.slice(0, 200)}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    name,
    mime: kind === "docx" ? DOCX_MIME : XLSX_MIME,
    base64: buf.toString("base64"),
    bytes: buf.byteLength,
  };
}

/**
 * Scan the assistant reply for <doc:*> blocks and render each via the user's
 * render service. No-op (returns the text unchanged, no files) when the
 * add-on is disabled/unconfigured or the reply has no blocks.
 */
export async function produceFromReply(
  assistantContent: string,
  userId: string,
): Promise<ProduceResult> {
  if (!assistantContent || !hasDocBlocks(assistantContent)) {
    return { text: assistantContent, files: [], errors: [] };
  }
  const cfg = await loadProducerConfigForUser(userId);
  if (!cfg) {
    // Enabled-but-unconfigured or off → leave the blocks as-is so nothing is
    // silently lost; the user sees the raw block and can enable the add-on.
    return { text: assistantContent, files: [], errors: [] };
  }

  const files: ProducedFile[] = [];
  const errors: string[] = [];
  let counter = 0;

  const replacements: Array<{ match: string; marker: string }> = [];
  BLOCK_RE.lastIndex = 0;
  for (
    let m = BLOCK_RE.exec(assistantContent);
    m !== null;
    m = BLOCK_RE.exec(assistantContent)
  ) {
    const kind = m[1] as "docx" | "xlsx";
    counter += 1;
    const name =
      (m[2] && m[2].trim()) ||
      `document-${counter}.${kind === "docx" ? "docx" : "xlsx"}`;
    const body = m[3].trim();
    try {
      const file = await renderOne(cfg.url, kind, name, body);
      files.push(file);
      replacements.push({ match: m[0], marker: `\n\n[📄 ${file.name}]\n\n` });
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`${name}: ${msg}`);
      replacements.push({
        match: m[0],
        marker: `\n\n[⚠️ ${name} — render failed: ${msg}]\n\n`,
      });
    }
  }

  let text = assistantContent;
  for (const r of replacements) text = text.replace(r.match, r.marker);

  return { text, files, errors };
}

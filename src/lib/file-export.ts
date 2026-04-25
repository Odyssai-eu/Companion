// Code block extraction + file export helpers.
// Lifted from ExoScopy's index.html (lines 278-322) so Thecomp.ai messages
// can offer the same: save full response as .md, save each fenced code block
// as its own file, zip them when there are several.

import JSZip from "jszip";

export type CodeBlock = {
  filename: string;
  lang: string;
  code: string;
};

const LANG_TO_EXT: Record<string, string> = {
  javascript: "js",
  typescript: "ts",
  python: "py",
  ruby: "rb",
  rust: "rs",
  bash: "sh",
  shell: "sh",
  zsh: "sh",
  yaml: "yml",
  markdown: "md",
  html: "html",
  css: "css",
  json: "json",
  c: "c",
  cpp: "cpp",
  java: "java",
  go: "go",
  swift: "swift",
  kotlin: "kt",
  php: "php",
  sql: "sql",
};

function extToFromLang(lang: string): string {
  if (!lang) return "txt";
  return LANG_TO_EXT[lang.toLowerCase()] ?? lang.toLowerCase();
}

/**
 * Pulls every fenced code block out of the markdown.
 *
 * Filename detection: if the line right above the fence is something like
 *   **`bench.py`**   or   `bench.py`   or   bench.py
 * we use that. Otherwise we fall back to file-1.{ext}, file-2.{ext}…
 */
export function extractCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  const lines = text.split("\n");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const lang = match[1] || "txt";
    const code = match[2];
    const beforeIdx = text.substring(0, match.index).split("\n").length - 2;
    let filename: string | null = null;
    if (beforeIdx >= 0 && lines[beforeIdx]) {
      const line = lines[beforeIdx].trim();
      const fnMatch = line.match(
        /^(?:\*\*)?`?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)`?(?:\*\*)?:?$/,
      );
      if (fnMatch) filename = fnMatch[1];
    }
    if (!filename) {
      filename = `file-${blocks.length + 1}.${extToFromLang(lang)}`;
    }
    blocks.push({ filename, lang, code });
  }
  return blocks;
}

export function downloadFile(
  filename: string,
  content: string,
  mime = "text/plain",
) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function downloadAllAsZip(
  blocks: CodeBlock[],
  zipName = "code-blocks.zip",
) {
  const zip = new JSZip();
  const counts: Record<string, number> = {};
  for (const b of blocks) {
    let name = b.filename;
    if (counts[name]) {
      const dot = name.lastIndexOf(".");
      const stem = dot >= 0 ? name.slice(0, dot) : name;
      const ext = dot >= 0 ? name.slice(dot) : "";
      name = `${stem}-${counts[b.filename]}${ext}`;
    }
    counts[b.filename] = (counts[b.filename] || 0) + 1;
    zip.file(name, b.code);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = zipName;
  a.click();
  URL.revokeObjectURL(url);
}

/** Slug-safe filename for saving a single message as .md */
export function messageMdFilename(messageId: string, idx?: number): string {
  const stub = idx !== undefined ? `response-${idx + 1}` : "response";
  return `${stub}-${messageId.slice(0, 8)}.md`;
}

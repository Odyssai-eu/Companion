// Markdown renderer — ExoScopy parity + syntax highlighting:
//   - GFM, line breaks honoured
//   - Syntax highlighting via highlight.js (common language subset)
//   - Code blocks get a language label + Copy button (wired in MarkdownBody)
//   - <think>...</think> blocks become collapsible <details>
//   - Output sanitised before injection

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked, type Tokens } from "marked";

// ── Custom renderer ────────────────────────────────────────────────────────

const renderer = new marked.Renderer();

renderer.code = ({ text, lang }: Tokens.Code): string => {
  const rawLang = (lang ?? "").split(/[\s{]/)[0].toLowerCase();
  const validLang = rawLang && hljs.getLanguage(rawLang) ? rawLang : "";

  let highlighted: string;
  try {
    highlighted = validLang
      ? hljs.highlight(text, { language: validLang }).value
      : hljs.highlightAuto(text).value;
  } catch {
    // Escape and fall back to plain
    highlighted = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  const displayLang = validLang || rawLang || "text";

  return [
    `<div class="code-block">`,
    `<div class="code-block-header">`,
    `<span class="code-lang">${displayLang}</span>`,
    `<button class="copy-code-btn" type="button">Copy</button>`,
    `</div>`,
    `<pre><code class="hljs language-${displayLang}">${highlighted}</code></pre>`,
    `</div>`,
  ].join("");
};

marked.use({ renderer, breaks: true, gfm: true });

// ── Sanitiser ──────────────────────────────────────────────────────────────

/** Tags that survive sanitisation. Everything else → plain text. */
const ALLOWED_TAGS = new Set([
  "p", "br",
  "strong", "em", "u", "s", "del", "ins",
  "code", "pre",
  "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "a", "img",
  "table", "thead", "tbody", "tr", "th", "td",
  "hr",
  "details", "summary",
  "div", "span",
  "button",   // copy-code-btn
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a:       new Set(["href", "title", "target", "rel"]),
  img:     new Set(["src", "alt", "title"]),
  code:    new Set(["class"]),
  pre:     new Set(["class"]),
  details: new Set(["open"]),
  div:     new Set(["class"]),
  span:    new Set(["class"]),
  button:  new Set(["class", "type"]),
  th:      new Set(["align"]),
  td:      new Set(["align"]),
};

function sanitize(html: string): string {
  if (typeof window === "undefined") return html;
  // DOMPurify replaces the hand-rolled walker — handles mutation XSS,
  // data: URIs, event-handler injection and parser differentials the
  // custom walker could miss. ALLOWED_TAGS / ALLOWED_ATTRS preserved.
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: Array.from(ALLOWED_TAGS),
    ALLOWED_ATTR: [
      ...new Set(
        Object.values(ALLOWED_ATTRS).flatMap((s) => Array.from(s)),
      ),
      "target",
      "rel",
    ],
  });
  // Re-add target + rel on external links (DOMPurify strips them by default
  // when not in FORCE_BODY mode; we do it via DOM post-pass instead).
  const tpl = document.createElement("template");
  tpl.innerHTML = clean;
  tpl.content.querySelectorAll("a[href]").forEach((a) => {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });
  return tpl.innerHTML;
}

// ── Think blocks ───────────────────────────────────────────────────────────

function liftThinkBlocks(text: string): string {
  return text.replace(
    /<think>([\s\S]*?)<\/think>/g,
    (_m, inner) =>
      `\n\n<details class="think-block"><summary>Thought</summary>\n\n${inner}\n\n</details>\n\n`,
  );
}

// ── Public API ─────────────────────────────────────────────────────────────

export function renderMarkdown(text: string): string {
  if (!text) return "";
  const lifted = liftThinkBlocks(text);
  const html = marked.parse(lifted, { async: false }) as string;
  return sanitize(html);
}

/**
 * Strip markdown for TTS — so the synth doesn't read "asterisk asterisk".
 */
export function stripMarkdownForTts(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/<think>[\s\S]*?<\/think>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

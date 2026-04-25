// Markdown renderer mirroring ExoScopy's behaviour:
//   - GFM, line breaks honoured
//   - <think>...</think> blocks become collapsible <details>
//   - Output is sanitised before injection (we own the prompt input but
//     responses come from arbitrary models, so we strip <script> tags etc.)
//
// Library: marked (npm). Sanitisation: a tiny allowlist; we don't pull
// DOMPurify because the markdown surface is small and we control most of it.

import { marked } from "marked";

marked.setOptions({
  breaks: true,
  gfm: true,
});

/** Tags that survive sanitisation. Everything else becomes plain text. */
const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "strong",
  "em",
  "u",
  "s",
  "del",
  "ins",
  "code",
  "pre",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "a",
  "img",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "hr",
  "details",
  "summary",
  "div",
  "span",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title", "target", "rel"]),
  img: new Set(["src", "alt", "title"]),
  code: new Set(["class"]),
  pre: new Set(["class"]),
  details: new Set(["open"]),
  div: new Set(["class"]),
  span: new Set(["class"]),
  th: new Set(["align"]),
  td: new Set(["align"]),
};

function sanitize(html: string): string {
  if (typeof window === "undefined") return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  walk(tpl.content);
  return tpl.innerHTML;
}

function walk(node: Node) {
  // Iterate children up-front because we may remove some
  const children = Array.from(node.childNodes);
  for (const child of children) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        // Replace with its text content
        const text = document.createTextNode(el.textContent ?? "");
        el.replaceWith(text);
        continue;
      }
      // Strip non-allowlisted attributes
      const allowed = ALLOWED_ATTRS[tag] ?? new Set<string>();
      for (const attr of Array.from(el.attributes)) {
        if (!allowed.has(attr.name)) {
          el.removeAttribute(attr.name);
          continue;
        }
        // Block javascript: URLs
        if (
          (attr.name === "href" || attr.name === "src") &&
          /^\s*javascript:/i.test(attr.value)
        ) {
          el.removeAttribute(attr.name);
        }
      }
      // External links open in a new tab safely
      if (tag === "a" && el.getAttribute("href")) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
      walk(el);
    }
  }
}

/**
 * Pre-process: convert <think>...</think> wrappers (some models emit those
 * inline rather than via the protocol-level reasoning channel) into a
 * collapsible block. We do this BEFORE marked.parse so the inner content
 * is still rendered as markdown.
 */
function liftThinkBlocks(text: string): string {
  return text.replace(
    /<think>([\s\S]*?)<\/think>/g,
    (_m, inner) =>
      `\n\n<details class="think-block"><summary>Thought</summary>\n\n${inner}\n\n</details>\n\n`,
  );
}

export function renderMarkdown(text: string): string {
  if (!text) return "";
  const lifted = liftThinkBlocks(text);
  const html = marked.parse(lifted, { async: false }) as string;
  return sanitize(html);
}

/**
 * Strip markdown structure for TTS so the synthesizer doesn't read out
 * "asterisk asterisk hello asterisk asterisk".
 */
export function stripMarkdownForTts(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1") // images: keep alt
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links: keep label
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

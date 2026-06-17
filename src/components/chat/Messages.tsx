import { useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "~/hooks/useChat";
import { useVoiceMode } from "~/hooks/useVoiceMode";
import {
  downloadAllAsZip,
  downloadFile,
  extractCodeBlocks,
  messageMdFilename,
} from "~/lib/file-export";
import { copyToClipboard } from "~/lib/clipboard";
import { renderMarkdown } from "~/lib/markdown";
import { tts } from "~/lib/tts";
import SpaceInvaders from "./SpaceInvaders";

const ATARI_SEQ = ["a", "t", "a", "r", "i"];

export default function Messages({
  messages,
  error,
  onRegenerate,
  onEdit,
  showMetrics = false,
}: {
  messages: UIMessage[];
  error: string | null;
  onRegenerate?: (assistantId: string) => void;
  onEdit?: (messageId: string, newText: string) => void;
  /** Per-user toggle for the per-message stats box. Defaults off when
   *  parent doesn't pass — the box used to render unconditionally. */
  showMetrics?: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the viewport is pinned to the bottom. We only auto-scroll while
  // pinned, so scrolling UP to read mid-stream isn't yanked back down on the
  // next token. A ref (not state) — updated on every scroll, read at
  // auto-scroll time, no re-render needed.
  const stickRef = useRef(true);
  const voice = useVoiceMode();

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    // 80px tolerance so "near the bottom" still counts as pinned (smooth
    // programmatic scrolls + sub-pixel rounding don't accidentally unpin).
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distanceFromBottom < 80;
  }
  const spokenIdsRef = useRef<Set<string>>(new Set());

  // Easter egg — Space Invaders triggered by ⌥⇧ATARI on empty chat
  const [easterEgg, setEasterEgg] = useState(false);
  const eggBuf = useRef<string[]>([]);

  useEffect(() => {
    if (messages.length > 0) return;
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length !== 1) return;
      eggBuf.current.push(e.key.toLowerCase());
      if (eggBuf.current.length > ATARI_SEQ.length) eggBuf.current.shift();
      if (JSON.stringify(eggBuf.current) === JSON.stringify(ATARI_SEQ)) {
        setEasterEgg(true);
        eggBuf.current = [];
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [messages.length]);

  const prevLenRef = useRef(0);
  useEffect(() => {
    const grew = messages.length > prevLenRef.current;
    const lastIsUser = messages[messages.length - 1]?.role === "user";
    prevLenRef.current = messages.length;
    // Always snap to the bottom when the user just sent a message (and re-pin
    // — they want to see their turn + the incoming reply). Otherwise only
    // follow the assistant's stream while pinned: if they scrolled up to read,
    // leave them there until they scroll back down.
    if (grew && lastIsUser) stickRef.current = true;
    if (stickRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Auto-speak when Voice mode is on: each assistant message that finished
  // streaming gets spoken once. We track ids in a ref so React re-renders
  // don't replay them.
  useEffect(() => {
    if (!voice.enabled) return;
    const last = messages[messages.length - 1];
    if (!last) return;
    if (last.role !== "assistant") return;
    if (last.streaming) return;
    if (!last.content || last.content.startsWith("⚠︎")) return;
    if (spokenIdsRef.current.has(last.id)) return;
    spokenIdsRef.current.add(last.id);
    tts.speak(last.id, last.content).catch(() => undefined);
  }, [messages, voice.enabled]);

  if (messages.length === 0 && !error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8">
        {easterEgg && (
          <SpaceInvaders onClose={() => setEasterEgg(false)} />
        )}
        <div className="flex flex-col items-center gap-3 text-center">
          <img
            src="/logo/icon-192.png"
            alt=""
            className="h-14 w-14 rounded-full opacity-70"
          />
          <p className="font-display text-[20px] font-light text-navy">
            What would you like to ask?
          </p>
          <p className="text-[13px] text-gray-400">
            Your conversations stay on your hardware.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-10"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-8 md:gap-10">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 font-mono text-[12px] text-red-700">
            {error}
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <UserBubble
              key={m.id}
              content={m.content}
              onEdit={onEdit ? (next) => onEdit(m.id, next) : undefined}
            />
          ) : (
            <AssistantMessage
              key={m.id}
              message={m}
              onRegenerate={
                onRegenerate ? () => onRegenerate(m.id) : undefined
              }
              showMetrics={showMetrics}
            />
          ),
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function UserBubble({
  content,
  onEdit,
}: {
  content: string;
  onEdit?: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);

  if (editing && onEdit) {
    return (
      <div className="flex justify-end">
        <div className="flex w-[85%] flex-col gap-2 rounded-2xl border border-cyan bg-white p-3">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (draft.trim()) {
                  onEdit(draft.trim());
                  setEditing(false);
                }
              }
              if (e.key === "Escape") {
                setDraft(content);
                setEditing(false);
              }
            }}
            rows={Math.max(2, draft.split("\n").length)}
            className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink outline-none"
          />
          <div className="flex items-center justify-end gap-2 text-[12px]">
            <span className="mr-auto font-mono text-[11px] text-gray-400">
              <kbd>⌘</kbd> + <kbd>⏎</kbd> to send · <kbd>Esc</kbd> to cancel
            </span>
            <button
              type="button"
              onClick={() => {
                setDraft(content);
                setEditing(false);
              }}
              className="text-gray-500 hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (!draft.trim()) return;
                onEdit(draft.trim());
                setEditing(false);
              }}
              className="rounded-md bg-cyan px-3 py-1 font-medium text-white hover:opacity-95"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex justify-end">
      <div className="relative max-w-[85%] rounded-2xl bg-[rgba(79,179,217,0.14)] px-5 py-4">
        {onEdit && (
          <button
            type="button"
            onClick={() => {
              setDraft(content);
              setEditing(true);
            }}
            title="Edit message"
            className="absolute -top-2 -left-2 hidden h-6 w-6 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 shadow-sm hover:text-ink group-hover:flex"
          >
            <PencilIcon />
          </button>
        )}
        <p
          className="text-[15px] leading-relaxed whitespace-pre-wrap text-ink"
          onDoubleClick={() => {
            if (!onEdit) return;
            setDraft(content);
            setEditing(true);
          }}
        >
          {content}
        </p>
      </div>
    </div>
  );
}

function AssistantMessage({
  message,
  onRegenerate,
  showMetrics = false,
}: {
  message: UIMessage;
  onRegenerate?: () => void;
  showMetrics?: boolean;
}) {
  const thinking = !message.content && (message.streaming || !!message.reasoning);

  // "Breathing" glow: when the stream finishes (streaming true→false with
  // content), the bear icon pulses softly for ~2.5s — like Claude's asterisk,
  // a quiet signal that the reply just landed. No artificial delay added.
  const [justFinished, setJustFinished] = useState(false);
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = !!message.streaming;
    if (wasStreaming && !message.streaming && message.content) {
      setJustFinished(true);
      const t = setTimeout(() => setJustFinished(false), 2500);
      return () => clearTimeout(t);
    }
  }, [message.streaming, message.content]);

  return (
    <div className="flex gap-4">
      <img
        src="/logo/icon-192.png"
        alt="Bear"
        className={`h-8 w-8 flex-shrink-0 rounded-full transition-shadow duration-700 ${
          justFinished
            ? "shadow-[0_0_0_3px_rgba(0,204,204,0.55),0_0_14px_4px_rgba(0,204,204,0.3)] animate-pulse"
            : ""
        }`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {message.reasoning && (
          <ReasoningBlock
            reasoning={message.reasoning}
            thinking={thinking}
          />
        )}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <ToolCallsBlock calls={message.toolCalls} />
        )}
        <div className="text-[15px] leading-relaxed text-ink">
          {message.content ? (
            <MarkdownBody content={message.content} />
          ) : (
            !message.reasoning && (
              <span className="inline-flex items-center gap-2 text-[14px] text-gray-400">
                <TypingDots />
              </span>
            )
          )}
          {message.streaming && message.content && (
            <span className="inline-block h-4 w-0.5 animate-pulse bg-cyan align-middle" />
          )}
        </div>
        {/* Help chip — always visible when this message came from /help,
         *  regardless of showMetrics. The chip shows which wiki articles
         *  the answer was synthesised from, with links to the public docs. */}
        {message.stats?.isHelp &&
          Array.isArray(message.stats.helpFrom) &&
          message.stats.helpFrom.length > 0 && (
            <HelpSourcesRow
              slugs={message.stats.helpFrom}
              titles={message.stats.helpTitles ?? []}
            />
          )}
        {showMetrics && message.stats && !message.streaming && (
          <StatsRow stats={message.stats} model={message.model} />
        )}
        {!message.streaming && message.content && (
          <>
            <ActionsRow message={message} onRegenerate={onRegenerate} />
            <CodeBlockPills message={message} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Renders markdown HTML (from renderMarkdown) and wires copy buttons.
 * Using a ref + useEffect so we can attach native DOM listeners to the
 * .copy-code-btn elements that are baked into the sanitised HTML.
 */
function MarkdownBody({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(content), [content]);

  // Attach copy-button listeners every time the rendered HTML changes
  // (i.e. while streaming new tokens).
  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    const buttons = container.querySelectorAll<HTMLButtonElement>(".copy-code-btn");
    const cleanups: (() => void)[] = [];

    buttons.forEach((btn) => {
      const codeEl = btn
        .closest(".code-block")
        ?.querySelector("code");

      const handler = () => {
        const text = codeEl?.textContent ?? "";
        void copyToClipboard(text).then((ok) => {
          if (!ok) return;
          btn.textContent = "Copied!";
          setTimeout(() => { btn.textContent = "Copy"; }, 1800);
        });
      };

      btn.addEventListener("click", handler);
      cleanups.push(() => btn.removeEventListener("click", handler));
    });

    return () => cleanups.forEach((fn) => fn());
  }, [html]);

  return (
    <div
      ref={ref}
      className="md-body"
      // Sanitised in renderMarkdown — see src/lib/markdown.ts
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function CodeBlockPills({ message }: { message: UIMessage }) {
  const blocks = useMemo(
    () => extractCodeBlocks(message.content),
    [message.content],
  );
  if (blocks.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {blocks.map((b, j) => (
        <button
          key={j}
          type="button"
          onClick={() => downloadFile(b.filename, b.code)}
          className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-[11px] text-gray-600 hover:bg-gray-100 hover:text-ink"
        >
          <FileIcon />
          <span>{b.filename}</span>
        </button>
      ))}
      {blocks.length > 1 && (
        <button
          type="button"
          onClick={() => downloadAllAsZip(blocks)}
          className="flex items-center gap-1.5 rounded-md border border-cyan/30 bg-cyan/10 px-2 py-1 font-mono text-[11px] text-cyan-700 hover:bg-cyan/20"
        >
          <DownloadIcon />
          <span>Save all (.zip)</span>
        </button>
      )}
    </div>
  );
}

function ToolCallsBlock({
  calls,
}: {
  calls: NonNullable<UIMessage["toolCalls"]>;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {calls.map((c, i) => {
        const argSummary = summarizeArgs(c.name, c.args ?? {});
        const running = !c.result;
        return (
          <details
            key={i}
            className="rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2"
          >
            <summary className="flex cursor-pointer items-center gap-2 font-mono text-[12px] text-gray-600">
              <SearchIcon />
              <span className="font-medium text-ink">{c.name}</span>
              {argSummary && (
                <span className="truncate text-gray-500">({argSummary})</span>
              )}
              {running ? (
                <span className="ml-auto flex items-center gap-1.5 text-cyan">
                  <TypingDots />
                  <span className="text-[11px]">running…</span>
                </span>
              ) : c.result?.ok ? (
                <span className="ml-auto text-[11px] text-emerald-600">
                  ✓ {c.result.summary}
                </span>
              ) : (
                <span className="ml-auto text-[11px] text-rose-600">
                  ✗ {c.result?.summary}
                </span>
              )}
            </summary>
            {c.result?.sources && c.result.sources.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1 pl-6 text-[12px]">
                {c.result.sources.map((s, j) => (
                  <li key={j} className="truncate">
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-cyan hover:text-navy hover:underline"
                    >
                      {s.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </details>
        );
      })}
    </div>
  );
}

function summarizeArgs(name: string, args: Record<string, unknown>): string {
  if (name === "web_search" && typeof args.query === "string") {
    return `"${args.query}"`;
  }
  if (name === "web_fetch" && typeof args.url === "string") {
    return args.url;
  }
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
}

function SearchIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

const THINKING_STATUS_SENTENCES = [
  // #35 — Odyssée d'Ulysse + le Cid (tirade de Don Rodrigue, Acte IV sc. 3) :
  // un signe que « ça mijote » quand le bloc thinking est replié.
  "Ulysse trace sa route entre les écueils…",
  "Pénélope tisse la réponse, fil à fil…",
  "On hisse les voiles vers Ithaque…",
  "Le stratagème se met en place dans l'ombre…",
  "Les sirènes consultées, on poursuit la traversée…",
  "« Cette obscure clarté qui tombe des étoiles… »",
  "« Nous partîmes cinq cents ; mais par un prompt renfort… »",
  "« Notre profond silence abusant leurs esprits… »",
  "« L'onde s'enfle dessous, et d'un commun effort… »",
  "« Et je feins hardiment d'avoir reçu de vous… »",
];

function ReasoningBlock({
  reasoning,
  thinking,
}: {
  reasoning: string;
  thinking: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [statusIdx, setStatusIdx] = useState(() =>
    Math.floor(Math.random() * THINKING_STATUS_SENTENCES.length),
  );
  // #35: pendant que ça pense ET que le bloc est replié, on fait tourner une
  // phrase de statut — l'utilisateur voit que quelque chose se passe sans
  // avoir à déplier la fenêtre.
  useEffect(() => {
    if (!thinking || open) return;
    const t = setInterval(
      () => setStatusIdx((i) => (i + 1) % THINKING_STATUS_SENTENCES.length),
      4500,
    );
    return () => clearInterval(t);
  }, [thinking, open]);
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left"
      >
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-2 font-mono text-[11px] tracking-[0.04em] text-gray-600 uppercase">
            {thinking ? (
              <>
                <TypingDots />
                <span>Thinking</span>
              </>
            ) : (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-cyan" />
                <span>Thought</span>
              </>
            )}
          </span>
          {thinking && !open && (
            <span className="truncate text-[11px] font-normal text-gray-400 normal-case italic">
              {THINKING_STATUS_SENTENCES[statusIdx]}
            </span>
          )}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-gray-200 px-4 py-3 font-mono text-[12px] leading-[18px] whitespace-pre-wrap text-gray-600">
          {reasoning}
        </div>
      )}
    </div>
  );
}

function TypingDots() {
  return (
    <span className="flex gap-1">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" />
    </span>
  );
}

function StatsRow({
  stats,
  model,
}: {
  stats: NonNullable<UIMessage["stats"]>;
  model?: string;
}) {
  const items: [string, string][] = [];
  if (stats.ttft) items.push(["TTFT", stats.ttft]);
  if (stats.durationMs !== undefined)
    items.push(["Duration", `${(stats.durationMs / 1000).toFixed(2)}s`]);
  if (stats.promptTokens !== undefined)
    items.push(["Prompt", `${stats.promptTokens} tok`]);
  // Show cache savings only when there's something to brag about. Display
  // as "Cached: N tok (XX%)" so the user immediately sees the prefix-share
  // win from oMLX's tiered KV cache (or any upstream prompt cache).
  if (
    stats.cachedTokens !== undefined &&
    stats.cachedTokens > 0 &&
    stats.promptTokens !== undefined &&
    stats.promptTokens > 0
  ) {
    const pct = Math.round((stats.cachedTokens / stats.promptTokens) * 100);
    items.push(["Cached", `${stats.cachedTokens} tok (${pct}%)`]);
  }
  if (stats.completionTokens !== undefined)
    items.push(["Completion", `${stats.completionTokens} tok`]);
  if (
    stats.reasoningTokens !== undefined &&
    stats.reasoningTokens > 0
  )
    items.push(["Reasoning", `${stats.reasoningTokens} tok`]);
  if (
    stats.tokens !== undefined &&
    stats.promptTokens === undefined &&
    stats.completionTokens === undefined
  )
    items.push(["Tokens", `${stats.tokens} tok`]);
  if (stats.speed) items.push(["Speed", stats.speed]);
  // Decode-only tok/s — excludes TTFT from the denominator, matches the
  // figures model providers advertise (e.g. inferencer's 5 tok/s for
  // Mistral-Medium-3.5). Shown next to Speed so users can see how much
  // of the end-to-end rate was eaten by prompt eval.
  if (stats.decodeSpeed && stats.decodeSpeed !== stats.speed)
    items.push(["Decode", stats.decodeSpeed]);
  if (stats.chunks !== undefined) items.push(["Chunks", String(stats.chunks)]);
  if (model) items.push(["Model", model]);
  // Auto-router chip: when the picker was set to "auto" and the server
  // routed the request, surface the decision so the user can verify
  // (and tune the policy if the choice was wrong).
  if (typeof stats.routedFrom === "string" && typeof stats.routedLabel === "string") {
    const scoreStr = typeof stats.routedScore === "number"
      ? ` ${stats.routedScore.toFixed(2)}`
      : "";
    items.push(["Routed", `${stats.routedLabel}${scoreStr}`]);
  }
  if (stats.cost) items.push(["Cost", stats.cost]);

  if (items.length === 0) return null;

  function onCopy() {
    const line = items.map(([k, v]) => `${k}: ${v}`).join(" · ");
    void copyToClipboard(line);
  }

  return (
    <div className="group/stats flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border border-gray-200 bg-white px-5 py-3 font-mono text-[12px] text-gray-600">
      {items.map(([label, value]) => (
        <span key={label} className="flex items-center gap-2">
          <span className="text-gray-400">{label}</span>
          <span className="text-ink">{value}</span>
        </span>
      ))}
      <button
        type="button"
        onClick={onCopy}
        title="Copy stats"
        className="ml-auto text-[11px] text-gray-300 hover:text-ink"
      >
        Copy
      </button>
    </div>
  );
}

/**
 * Inline footer row for /help answers. Always visible (independent of
 * the metrics toggle) so the user can immediately see which wiki
 * articles informed the answer + click through to the public docs for
 * the full version.
 */
function HelpSourcesRow({
  slugs,
  titles,
}: {
  slugs: string[];
  titles: string[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-cyan/30 bg-cyan/5 px-4 py-2 font-mono text-[11px]">
      <span className="rounded bg-cyan/15 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-cyan-700 uppercase">
        Help
      </span>
      <span className="text-gray-500">from</span>
      {slugs.map((slug, i) => (
        <span key={slug} className="flex items-center">
          <a
            href={`https://odyssai.eu/docs/companion/${slug}/`}
            target="_blank"
            rel="noopener noreferrer"
            title={titles[i] ?? slug}
            className="text-cyan-700 underline-offset-2 hover:text-navy hover:underline"
          >
            {slug}
          </a>
          {i < slugs.length - 1 && (
            <span className="ml-1.5 text-gray-400">·</span>
          )}
        </span>
      ))}
      <a
        href="https://odyssai.eu/docs/"
        target="_blank"
        rel="noopener noreferrer"
        className="ml-auto text-[10px] text-gray-400 hover:text-cyan-700"
      >
        full docs ↗
      </a>
    </div>
  );
}

function ActionsRow({
  message,
  onRegenerate,
}: {
  message: UIMessage;
  onRegenerate?: () => void;
}) {
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  useEffect(() => {
    const unsub = tts.subscribe((s) => setSpeakingId(s.speakingId));
    return () => {
      unsub();
    };
  }, []);
  const speaking = speakingId === message.id;

  function onCopy() {
    if (!message.content) return;
    void copyToClipboard(message.content);
  }

  function onSpeak() {
    if (speaking) {
      tts.stop();
    } else {
      tts.speak(message.id, message.content).catch(() => undefined);
    }
  }

  function onSaveMd() {
    if (!message.content) return;
    downloadFile(
      messageMdFilename(message.id),
      message.content,
      "text/markdown",
    );
  }

  function onSaveWav() {
    tts
      .save(message.content, `companion-${message.id.slice(0, 8)}.wav`)
      .catch(() => undefined);
  }

  return (
    <div className="flex items-center gap-5 text-[12px] text-gray-400">
      <button
        type="button"
        onClick={onSpeak}
        className={`flex items-center gap-1.5 hover:text-ink ${speaking ? "text-cyan" : ""}`}
      >
        <SpeakIcon />
        <span>{speaking ? "Stop" : "Listen"}</span>
      </button>
      <button
        type="button"
        onClick={onCopy}
        className="flex items-center gap-1.5 hover:text-ink"
      >
        <CopyIcon />
        <span>Copy</span>
      </button>
      <button
        type="button"
        onClick={onSaveMd}
        className="flex items-center gap-1.5 hover:text-ink"
      >
        <SaveIcon />
        <span>Save</span>
      </button>
      {onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          className="flex items-center gap-1.5 hover:text-ink"
          title="Regenerate this answer"
        >
          <RegenerateIcon />
          <span>Regenerate</span>
        </button>
      )}
      <button
        type="button"
        onClick={onSaveWav}
        className="flex items-center gap-1.5 hover:text-ink"
        title="Save spoken audio (.wav)"
      >
        <WaveIcon />
        <span>Save WAV</span>
      </button>
    </div>
  );
}

function FileIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function WaveIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="3" y1="12" x2="5" y2="12" />
      <line x1="7" y1="8" x2="7" y2="16" />
      <line x1="11" y1="4" x2="11" y2="20" />
      <line x1="15" y1="8" x2="15" y2="16" />
      <line x1="19" y1="12" x2="21" y2="12" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function RegenerateIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </svg>
  );
}

function SpeakIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 5 6 9H2v6h4l5 4z" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}


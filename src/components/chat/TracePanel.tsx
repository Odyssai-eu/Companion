// Trace panel — "show your work" (v2.0 β). Read-only side panel with the
// full sub-conversation transcript. Primary source = the persisted
// messages of the sub-conversation (never purged); agent_spans only
// enrich the admin traces page, not this panel.

import { useEffect, useState } from "react";
import { api, type ApiMessage } from "~/lib/api";
import { renderMarkdown } from "~/lib/markdown";

export default function TracePanel({
  subConversationId,
  agent,
  onClose,
}: {
  subConversationId: string;
  agent: string;
  onClose: () => void;
}) {
  const [msgs, setMsgs] = useState<ApiMessage[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getConversation(subConversationId)
      .then(({ messages }) => {
        if (alive) setMsgs(messages);
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [subConversationId]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20">
      <button
        type="button"
        aria-label="Close trace"
        className="flex-1"
        onClick={onClose}
      />
      <aside className="flex h-full w-full max-w-[560px] flex-col border-l border-gray-200 bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <div>
            <span className="font-sans text-[11px] font-medium tracking-[0.08em] text-cyan uppercase">
              Trace
            </span>
            <h3 className="font-display text-[18px] font-light text-navy">
              {agent}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-lg text-gray-400 hover:text-ink"
          >
            ×
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {err && <p className="text-[13px] text-red-600">{err}</p>}
          {!err && !msgs && (
            <p className="text-[13px] text-gray-400">Loading…</p>
          )}
          {msgs?.map((m) => (
            <div key={m.id} className="mb-3">
              <span className="font-sans text-[10px] font-medium tracking-[0.06em] text-gray-400 uppercase">
                {m.role}
              </span>
              <div
                className="md-body text-[13px] leading-relaxed text-ink"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
              />
            </div>
          ))}
          {msgs && msgs.length === 0 && (
            <p className="text-[13px] text-gray-400">Empty transcript.</p>
          )}
        </div>
      </aside>
    </div>
  );
}

/**
 * ComfyUI image attachments rendered inline in a chat message.
 *
 * The image bytes are NOT in the message payload — they live on the
 * ComfyUI compute host (`/Volumes/models-1/comfyui/output/...`) and
 * are served via the OdyssAI-Imager bridge's
 * `GET /v1/image/{filename}` endpoint. The message only carries the
 * reference (filename + mime + bridge URL); the browser fetches the
 * bytes on every render via a plain <img src>.
 *
 * Hover overlay offers a "Save picture" button that fetches the same
 * URL via XHR and triggers a download via a Blob + a.download.
 */

import type { ComfyuiAttachment } from "~/hooks/useChat";

export function ComfyuiAttachments({
  attachments,
}: {
  attachments: ComfyuiAttachment[];
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {attachments.map((att, i) => (
        <AttachmentWithSave key={`${att.bridge_url}-${att.filename}-${i}`} att={att} />
      ))}
    </div>
  );
}

function AttachmentWithSave({ att }: { att: ComfyuiAttachment }) {
  // Construct the bridge URL once per render. The bridge is on the LAN
  // (no auth required from the browser); we store the URL per message
  // so changing the configured bridge later doesn't silently break
  // old images.
  const params = new URLSearchParams({ type: "output" });
  const src = `${att.bridge_url.replace(/\/+$/, "")}/v1/image/${encodeURIComponent(att.filename)}?${params.toString()}`;

  async function onSave() {
    // Fetch through the bridge and save as Blob so the browser's Save
    // dialog sees a real image MIME, not text/plain octet-stream.
    try {
      const r = await fetch(src);
      if (!r.ok) return;
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = att.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* network blip — silent */
    }
  }

  return (
    <div className="group relative inline-block max-w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
      <img
        src={src}
        alt={att.filename}
        className="block max-h-[640px] max-w-full object-contain"
      />
      <div className="pointer-events-none absolute inset-0 flex items-end justify-end bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        <button
          type="button"
          onClick={onSave}
          aria-label={`Save ${att.filename}`}
          className="pointer-events-auto m-3 flex items-center gap-1.5 rounded-md bg-white/95 px-3 py-1.5 font-mono text-[11px] font-medium text-ink shadow-sm hover:bg-white"
        >
          <SaveIcon />
          Save picture
        </button>
      </div>
    </div>
  );
}

function SaveIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}

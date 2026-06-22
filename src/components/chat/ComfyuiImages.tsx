/**
 * ComfyUI image attachments rendered inline in a chat message.
 *
 * Replaces the old data-URI markdown approach. Each image gets a
 * hover overlay with a Save button that downloads the original
 * filename at its original mime type. The data URI is built at
 * paint time so the message payload stays JSON-serialisable.
 */

export type ComfyuiImage = {
  filename: string;
  mime: string;
  /** Base64 WITHOUT the `data:<mime>;base64,` prefix. */
  dataBase64: string;
};

export function ComfyuiImages({ images }: { images: ComfyuiImage[] }) {
  if (images.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {images.map((img, i) => (
        <ImageWithSave key={`${img.filename}-${i}`} image={img} />
      ))}
    </div>
  );
}

function ImageWithSave({ image }: { image: ComfyuiImage }) {
  const src = `data:${image.mime};base64,${image.dataBase64}`;
  function onSave() {
    // Decode + re-encode via Blob so the browser's Save dialog sees
    // a real image MIME, not a text/plain octet-stream. (downloadFile
    // would work too but Blob is the right primitive for binary data.)
    const bytes = atob(image.dataBase64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    const blob = new Blob([arr], { type: image.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = image.filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="group relative inline-block max-w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
      <img
        src={src}
        alt={image.filename}
        className="block max-h-[640px] max-w-full object-contain"
      />
      <div className="pointer-events-none absolute inset-0 flex items-end justify-end bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        <button
          type="button"
          onClick={onSave}
          aria-label={`Save ${image.filename}`}
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

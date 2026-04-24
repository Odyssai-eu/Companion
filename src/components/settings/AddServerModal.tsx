import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "~/lib/api";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
};

export default function AddServerModal({ open, onClose, onCreated }: Props) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      setName("");
      setAddress("");
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = parseAddress(address);
    if (!parsed) {
      setError("Address must look like host:port (e.g. 192.168.86.29:52415).");
      return;
    }
    if (!name.trim()) {
      setError("Give this server a name.");
      return;
    }
    setSubmitting(true);
    try {
      const { server } = await api.createServer({
        name: name.trim(),
        ip: parsed.ip,
        port: parsed.port,
      });
      onCreated();
      navigate(`/settings/servers/${server.id}`);
    } catch (e) {
      setError((e as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 px-4 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[560px] rounded-2xl border border-gray-200 bg-white shadow-[0_30px_60px_rgba(10,10,10,0.18)]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-gray-100 px-7 pt-6 pb-5">
          <div className="flex flex-col gap-1">
            <span className="font-sans text-[11px] font-medium tracking-[0.1em] text-cyan uppercase">
              Infrastructure
            </span>
            <h2 className="font-display text-[24px] leading-[30px] font-light text-navy">
              Add a server.
            </h2>
            <p className="text-[13px] text-gray-600">
              Paste an address — we'll create the primary endpoint so you can
              test the connection right away.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-50 hover:text-ink"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="flex flex-col gap-5 px-7 py-6">
          <Field label="Server name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Home Mac Studios"
              autoFocus
              className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors placeholder:text-gray-400 focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
            />
          </Field>

          <Field
            label="Address"
            hint="IP or hostname with port — e.g. 192.168.86.29:52415 or https://macstudio-office.ts.net"
          >
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="192.168.86.29:52415"
              className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 font-mono text-[14px] text-ink outline-none transition-colors placeholder:text-gray-400 focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
            />
          </Field>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[12px] text-red-700">
              {error}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-gray-100 px-7 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="flex h-9 items-center rounded-lg px-4 text-[13px] font-medium text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="flex h-9 items-center rounded-lg bg-navy px-4 text-[13px] font-medium text-white transition-opacity hover:opacity-95 disabled:opacity-50"
          >
            {submitting ? "Adding…" : "Add server"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-gray-400">{hint}</span>}
    </label>
  );
}

function parseAddress(
  input: string,
): { ip: string; port: number } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // http(s)://host[:port][/path]
  try {
    const url = new URL(
      trimmed.match(/^https?:\/\//) ? trimmed : `http://${trimmed}`,
    );
    const ip = url.hostname;
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 0;
    if (!ip || !Number.isFinite(port) || port < 1) return null;
    return { ip, port };
  } catch {
    return null;
  }
}

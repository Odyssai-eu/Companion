import { useEffect, useState } from "react";
import { api, type ApiEndpoint } from "~/lib/api";

type Props = {
  serverId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (endpoint: ApiEndpoint) => void;
};

export default function AddEndpointModal({
  serverId,
  open,
  onClose,
  onCreated,
}: Props) {
  const [label, setLabel] = useState("EXO Endpoint");
  const [role, setRole] = useState<"primary" | "secondary">("secondary");
  const [node, setNode] = useState("");
  const [ip, setIp] = useState("");
  const [port, setPort] = useState("52415");
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
      setLabel("EXO Endpoint");
      setRole("secondary");
      setNode("");
      setIp("");
      setPort("52415");
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const portNum = parseInt(port, 10);
    if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
      setError("Port must be 1–65535.");
      return;
    }
    if (!ip.trim()) {
      setError("IP or hostname is required.");
      return;
    }
    setSubmitting(true);
    try {
      const { endpoint } = await api.addEndpoint(serverId, {
        label: label.trim(),
        role,
        node: node.trim() || undefined,
        ip: ip.trim(),
        port: portNum,
      });
      onCreated(endpoint);
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
        className="w-full max-w-[520px] rounded-2xl border border-gray-200 bg-white shadow-[0_30px_60px_rgba(10,10,10,0.18)]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-gray-100 px-7 pt-6 pb-5">
          <div className="flex flex-col gap-1">
            <span className="font-sans text-[11px] font-medium tracking-[0.1em] text-cyan uppercase">
              Endpoint
            </span>
            <h2 className="font-display text-[22px] leading-[28px] font-light text-navy">
              Add an endpoint.
            </h2>
            <p className="text-[13px] text-gray-600">
              Primary endpoints are the ones we'll dispatch chat calls to.
              Secondaries let you hit individual nodes directly.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-50 hover:text-ink"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="flex flex-col gap-4 px-7 py-6">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Label">
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] text-ink outline-none focus:border-cyan"
              />
            </Field>
            <Field label="Role">
              <div className="flex gap-0.5 rounded-lg border border-gray-200 bg-white p-0.5">
                {(["primary", "secondary"] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRole(r)}
                    className={`flex-1 rounded-md px-3 py-1.5 text-[12px] capitalize transition-colors ${
                      role === r
                        ? "bg-gray-50 font-medium text-ink"
                        : "font-normal text-gray-400 hover:text-ink"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </Field>
          </div>

          <Field label="Node name (optional)" hint="e.g. ultra-512, exo1">
            <input
              value={node}
              onChange={(e) => setNode(e.target.value)}
              placeholder="ultra-512"
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-gray-400 focus:border-cyan"
            />
          </Field>

          <div className="grid grid-cols-[1fr_120px] gap-3">
            <Field label="IP / hostname">
              <input
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                placeholder="192.168.86.29"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-gray-400 focus:border-cyan"
              />
            </Field>
            <Field label="Port">
              <input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                inputMode="numeric"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-cyan"
              />
            </Field>
          </div>

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
            {submitting ? "Adding…" : "Add endpoint"}
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
      <span className="text-[12px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-gray-400">{hint}</span>}
    </label>
  );
}

function CloseIcon() {
  return (
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
  );
}

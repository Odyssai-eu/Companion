import { useEffect, useState } from "react";
import { useAuth } from "~/hooks/useAuth";

type Device = {
  id: string;
  name: string;
  kind: "desktop" | "tablet" | "phone";
  userAgent: string;
  lastSeen: string;
  current: boolean;
};

const STORAGE_KEY = "thecompai:devices";

function detectDeviceKind(): Device["kind"] {
  if (typeof window === "undefined") return "desktop";
  const ua = window.navigator.userAgent.toLowerCase();
  if (/iphone|android.*mobile|mobile/.test(ua)) return "phone";
  if (/ipad|tablet/.test(ua)) return "tablet";
  return "desktop";
}

function detectDeviceName(): string {
  if (typeof window === "undefined") return "Device";
  const ua = window.navigator.userAgent;
  if (/Mac OS X|Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Linux/.test(ua)) return "Linux";
  return "This device";
}

export default function DevicesPage() {
  const { user } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);

  useEffect(() => {
    if (!user) return;
    const currentId = getOrCreateDeviceId();
    const stored = loadDevices();
    const now = new Date().toISOString();
    const name = detectDeviceName();
    const kind = detectDeviceKind();
    const ua = window.navigator.userAgent;
    const idx = stored.findIndex((d) => d.id === currentId);
    if (idx >= 0) {
      stored[idx] = { ...stored[idx], lastSeen: now, current: true, name, kind, userAgent: ua };
    } else {
      stored.push({ id: currentId, name, kind, userAgent: ua, lastSeen: now, current: true });
    }
    saveDevices(stored);
    setDevices(stored);
  }, [user]);

  function revoke(id: string) {
    const next = devices.filter((d) => d.id !== id);
    saveDevices(next);
    setDevices(next);
  }

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
          Infrastructure
        </span>
        <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
          Devices & sync.
        </h1>
        <p className="max-w-[560px] text-[15px] leading-[24px] text-gray-600">
          Every device where you've signed in. Your conversations, projects,
          and settings follow you automatically. Sign out a device to revoke
          access.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        {devices.map((d) => (
          <div
            key={d.id}
            className="flex items-center justify-between gap-4 rounded-xl border border-gray-200 bg-white px-5 py-4"
          >
            <div className="flex items-center gap-4">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[rgba(79,179,217,0.12)]">
                <DeviceIcon kind={d.kind} />
              </div>
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-medium text-ink">
                    {d.name}
                  </span>
                  {d.current && (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                      This device
                    </span>
                  )}
                </div>
                <span className="font-mono text-[11px] text-gray-400">
                  Last seen {new Date(d.lastSeen).toLocaleString()}
                </span>
              </div>
            </div>
            {!d.current && (
              <button
                type="button"
                onClick={() => revoke(d.id)}
                className="flex h-9 items-center rounded-lg border border-gray-200 bg-white px-3.5 text-[13px] font-medium text-ink hover:bg-gray-50"
              >
                Forget
              </button>
            )}
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-2 rounded-xl border border-dashed border-gray-300 bg-white/60 px-5 py-4">
        <span className="text-[13px] font-medium text-ink">Sync status</span>
        <span className="text-[13px] text-gray-600">
          Your servers, projects, conversations and messages sync through your
          account. What stays on each device: temporary UI state, model picker
          selection, inference-panel values, accessibility toggles.
        </span>
      </section>
    </div>
  );
}

function DeviceIcon({ kind }: { kind: Device["kind"] }) {
  if (kind === "phone") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0F2F4F" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <rect x="7" y="2" width="10" height="20" rx="2" />
        <line x1="11" y1="18" x2="13" y2="18" />
      </svg>
    );
  }
  if (kind === "tablet") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0F2F4F" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="2" width="16" height="20" rx="2" />
        <line x1="11" y1="18" x2="13" y2="18" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0F2F4F" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function getOrCreateDeviceId(): string {
  if (typeof window === "undefined") return "server";
  const existing = window.localStorage.getItem("thecompai:deviceId");
  if (existing) return existing;
  const id = crypto.randomUUID();
  window.localStorage.setItem("thecompai:deviceId", id);
  return id;
}

function loadDevices(): Device[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Device[];
    return parsed.map((d) => ({ ...d, current: false }));
  } catch {
    return [];
  }
}

function saveDevices(devices: Device[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(devices));
}

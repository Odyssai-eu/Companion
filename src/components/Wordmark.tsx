import { useEffect, useState } from "react";

export default function Wordmark({ size = "md" }: { size?: "sm" | "md" }) {
  const logoSize = size === "sm" ? "h-7 w-7" : "h-8 w-8";
  const textSize = size === "sm" ? "text-sm" : "text-base";
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { version?: string } | null) => {
        if (!cancelled && d?.version) setVersion(d.version);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div className="flex items-center gap-2.5">
      <img
        src="/logo/icon-192.png"
        alt="Companion"
        className={`${logoSize} flex-shrink-0 rounded-full`}
      />
      <span className={`${textSize} font-mono tracking-tight`}>
        <span className="font-medium text-cyan">&gt;</span>
        <span className="font-light">the comp</span>
        <span className="font-medium text-cyan">.ai</span>
      </span>
      {version && (
        <span
          className="font-mono text-[10px] tracking-wide text-gray-400"
          title="Version"
        >
          v{version}
        </span>
      )}
    </div>
  );
}

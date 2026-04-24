export default function Wordmark({ size = "md" }: { size?: "sm" | "md" }) {
  const logoSize = size === "sm" ? "h-7 w-7" : "h-8 w-8";
  const textSize = size === "sm" ? "text-sm" : "text-base";
  return (
    <div className="flex items-center gap-2.5">
      <img
        src="/logo/icon-192.png"
        alt="Thecomp.ai"
        className={`${logoSize} flex-shrink-0 rounded-full`}
      />
      <span className={`${textSize} font-mono tracking-tight`}>
        <span className="font-medium text-cyan">&gt;</span>
        <span className="font-light">the comp</span>
        <span className="font-medium text-cyan">.ai</span>
      </span>
    </div>
  );
}

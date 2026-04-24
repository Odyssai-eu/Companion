export default function Wordmark({ size = "md" }: { size?: "sm" | "md" }) {
  const avatarSize = size === "sm" ? "h-7 w-7" : "h-8 w-8";
  const avatarText = size === "sm" ? "text-[10px]" : "text-xs";
  const textSize = size === "sm" ? "text-sm" : "text-base";
  return (
    <div className="flex items-center gap-2.5">
      <div
        className={`${avatarSize} flex items-center justify-center rounded-full bg-cyan`}
      >
        <span className={`${avatarText} font-mono font-medium text-white`}>
          [B]
        </span>
      </div>
      <span className={`${textSize} font-mono tracking-tight`}>
        <span className="font-medium text-cyan">&gt;</span>
        <span className="font-light">the comp</span>
        <span className="font-medium text-cyan">.ai</span>
      </span>
    </div>
  );
}

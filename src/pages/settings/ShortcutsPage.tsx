const SHORTCUTS = [
  { group: "Navigation", keys: ["⌘", "K"], action: "Open search" },
  { group: "Navigation", keys: ["⌘", ","], action: "Open Settings" },
  { group: "Navigation", keys: ["⌘", "N"], action: "New conversation" },
  { group: "Chat", keys: ["⏎"], action: "Send message" },
  { group: "Chat", keys: ["⇧", "⏎"], action: "New line" },
  { group: "Chat", keys: ["Esc"], action: "Stop generation" },
  { group: "Chat", keys: ["⌘", "/"], action: "Toggle inference settings" },
  { group: "Voice", keys: ["⌘", "⇧", "V"], action: "Toggle voice mode" },
  { group: "Voice", keys: ["Space"], action: "Hold to talk (while voice mode is on)" },
];

export default function ShortcutsPage() {
  const groups = Array.from(new Set(SHORTCUTS.map((s) => s.group)));
  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
          Preferences
        </span>
        <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
          Shortcuts.
        </h1>
        <p className="max-w-[560px] text-[15px] leading-[24px] text-gray-600">
          Keyboard map. Customizable bindings are coming; for now these are the
          defaults on macOS. Replace <kbd className="rounded border border-gray-200 bg-white px-1 font-mono text-[11px]">⌘</kbd> with <kbd className="rounded border border-gray-200 bg-white px-1 font-mono text-[11px]">Ctrl</kbd> on Windows and Linux.
        </p>
      </header>

      <section className="flex flex-col gap-6">
        {groups.map((group) => (
          <div key={group} className="flex flex-col gap-2">
            <h2 className="font-sans text-[11px] font-medium tracking-[0.08em] text-gray-400 uppercase">
              {group}
            </h2>
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
              {SHORTCUTS.filter((s) => s.group === group).map((s, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between border-b border-gray-100 px-5 py-3 last:border-b-0"
                >
                  <span className="text-[14px] text-ink">{s.action}</span>
                  <div className="flex items-center gap-1">
                    {s.keys.map((k) => (
                      <kbd
                        key={k}
                        className="rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 font-mono text-[12px] text-ink"
                      >
                        {k}
                      </kbd>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

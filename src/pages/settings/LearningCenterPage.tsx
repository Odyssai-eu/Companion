/**
 * Learning Center — placeholder shell.
 *
 * Will host an "AI Score" tracking the user's evolution over time (memory
 * richness, prompt quality, breadth of topics, …). T3 — Premium tier on
 * the roadmap. Skeleton today so the navigation slot is wired.
 */

export default function LearningCenterPage() {
  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
          Premium
        </span>
        <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
          Learning Center.
        </h1>
        <p className="max-w-[640px] text-[15px] leading-[24px] text-gray-600">
          Track how your conversations grow over time — depth of memory,
          breadth of topics, evolving expertise. A score that reflects what
          you've taught your assistant about you, and what it's helping you
          learn back.
        </p>
      </header>

      <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 p-10 text-center">
        <span className="font-mono text-[11px] tracking-[0.06em] text-gray-400 uppercase">
          Coming in v2
        </span>
        <p className="mt-3 max-w-md mx-auto text-[14px] text-gray-500">
          We're designing this carefully — what gets measured shapes how
          you'll use the tool. No half-baked gauge. Stay tuned.
        </p>
      </div>
    </div>
  );
}

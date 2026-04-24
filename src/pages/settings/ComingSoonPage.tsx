export default function ComingSoonPage({ title }: { title: string }) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
          Settings
        </span>
        <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
          {title}.
        </h1>
      </header>
      <div className="rounded-xl border border-dashed border-gray-300 bg-white/50 px-6 py-10 text-center">
        <p className="text-[14px] text-gray-600">
          Coming soon — the design is in Paper, the code is on the way.
        </p>
      </div>
    </div>
  );
}

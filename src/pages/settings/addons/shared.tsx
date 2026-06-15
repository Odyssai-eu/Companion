/**
 * Shared building blocks for the add-on configuration panels.
 *
 * Extracted from AddonsPage.tsx (issue #16) so each panel can live in its
 * own file without duplicating the bits used by more than one of them.
 */

/** Labelled field wrapper used by every add-on panel form. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] tracking-[0.04em] text-gray-500 uppercase">
        {label}
      </span>
      {children}
      {hint && (
        <span className="font-mono text-[11px] text-gray-400">{hint}</span>
      )}
    </div>
  );
}

/**
 * Small icon row signalling which project settings are active.
 *
 * Convention: an icon is shown only when its setting is on/filled —
 * off/empty stays invisible. Tooltips name each indicator so the row
 * reads at a glance once the user knows the icon language.
 *
 * Used in two places:
 *   - ProjectPage header (right-aligned, under the action buttons)
 *   - ProjectsListPage tiles (bottom row of each tile)
 *
 * The two callsites share the same icon glyphs but vary `size` and the
 * background treatment. `tone="solid"` paints a cyan-tinted pill (used
 * on the project page where the row sits on the gray background);
 * `tone="ghost"` is transparent for the tile where the card already
 * provides contrast.
 */

import type { ApiProject } from "~/lib/api";

type Props = {
  project: Pick<
    ApiProject,
    | "systemPrompt"
    | "memoryEnabled"
    | "globalMemoryReadOnly"
    | "dedicatedMemoryEnabled"
  >;
  size?: number;
  tone?: "solid" | "ghost";
};

export function ProjectStatusIcons({
  project,
  size = 14,
  tone = "solid",
}: Props) {
  const indicators = [
    {
      key: "system-prompt",
      active: Boolean(project.systemPrompt && project.systemPrompt.trim()),
      label: "System prompt set",
      svg: (
        <path
          d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h6 M9 9h2"
        />
      ),
    },
    {
      key: "global-wiki",
      active: Boolean(project.memoryEnabled),
      label: "Global wiki injected",
      svg: (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20 M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </>
      ),
    },
    {
      key: "read-only",
      active: Boolean(project.globalMemoryReadOnly),
      label: "Wiki is read-only here (no write-back)",
      svg: (
        <>
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </>
      ),
    },
    {
      key: "project-wiki",
      active: Boolean(project.dedicatedMemoryEnabled),
      label: "Project corpus injected",
      svg: (
        <>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </>
      ),
    },
  ];

  const active = indicators.filter((i) => i.active);
  if (active.length === 0) return null;

  const itemClass =
    tone === "solid"
      ? "flex h-6 w-6 items-center justify-center rounded-md bg-[rgba(79,179,217,0.10)] text-cyan-700"
      : "flex h-6 w-6 items-center justify-center rounded-md text-cyan-700";

  return (
    <div className="flex flex-wrap items-center gap-1">
      {active.map((i) => (
        <span key={i.key} className={itemClass} title={i.label}>
          <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {i.svg}
          </svg>
        </span>
      ))}
    </div>
  );
}

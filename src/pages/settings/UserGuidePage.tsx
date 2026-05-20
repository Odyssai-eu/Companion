import { useMemo } from "react";
import { NavLink, Navigate, useParams } from "react-router";
import { renderMarkdown } from "~/lib/markdown";

// Wiki-style user guide. Each topic is a single .md file under
// src/content/user-guide/<NN>-<slug>.md. Numeric prefix controls the
// order in the rail. First line `# Title` becomes the rail label.
//
// Add a topic → drop a new file in the folder. Vite's glob import
// picks it up at build time, no code change needed.

const RAW_FILES = import.meta.glob("/src/content/user-guide/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

type Topic = { slug: string; title: string; body: string };

function buildTopics(): Topic[] {
  return Object.entries(RAW_FILES)
    .map(([path, raw]) => {
      const file = path.split("/").pop() ?? "";
      // Strip leading "NN-" prefix and the ".md" suffix.
      const slug = file.replace(/^\d+-/, "").replace(/\.md$/, "");
      const lines = raw.split("\n");
      const titleLine = lines.find((l) => l.startsWith("# "));
      const title = titleLine ? titleLine.slice(2).trim() : slug;
      const body = titleLine
        ? raw.replace(titleLine, "").replace(/^\s*\n/, "")
        : raw;
      return { slug, title, body, path };
    })
    .sort((a, b) =>
      (a as unknown as { path: string }).path.localeCompare(
        (b as unknown as { path: string }).path,
      ),
    )
    .map(({ slug, title, body }) => ({ slug, title, body }));
}

export default function UserGuidePage() {
  const topics = useMemo(buildTopics, []);
  const { slug } = useParams<{ slug: string }>();
  const active = topics.find((t) => t.slug === slug) ?? topics[0];

  if (!slug && topics.length > 0) {
    return <Navigate to={`/settings/user-guide/${topics[0].slug}`} replace />;
  }
  if (!active) {
    return (
      <div className="px-6 py-10 text-gray-500">No guide topics found.</div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
          Reference
        </span>
        <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
          User Guide
        </h1>
        <p className="max-w-[640px] text-[15px] leading-[24px] text-gray-600">
          A field manual for Companion. Each topic is its own page —
          editable in <code className="font-mono text-[13px]">src/content/user-guide/</code>.
        </p>
      </header>

      <div className="flex gap-10">
        <aside className="w-[220px] shrink-0">
          <nav className="sticky top-6 flex flex-col gap-1">
            {topics.map((t) => (
              <NavLink
                key={t.slug}
                to={`/settings/user-guide/${t.slug}`}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-[13px] transition-colors ${
                    isActive
                      ? "bg-[rgba(79,179,217,0.12)] font-medium text-navy"
                      : "text-gray-600 hover:bg-gray-50 hover:text-ink"
                  }`
                }
                end
              >
                {t.title}
              </NavLink>
            ))}
          </nav>
        </aside>

        <article className="min-w-0 flex-1">
          <h2 className="mb-6 font-display text-[28px] font-light text-navy">
            {active.title}
          </h2>
          <div
            className="md-body max-w-[760px] text-[15px] leading-relaxed text-ink"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(active.body) }}
          />
        </article>
      </div>
    </div>
  );
}

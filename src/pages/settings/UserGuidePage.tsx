import { Navigate, useParams } from "react-router";
import { USER_GUIDE_TOPICS } from "~/content/user-guide";
import { renderMarkdown } from "~/lib/markdown";

export default function UserGuidePage() {
  const { slug } = useParams<{ slug: string }>();
  const active = USER_GUIDE_TOPICS.find((t) => t.slug === slug);

  if (!slug && USER_GUIDE_TOPICS.length > 0) {
    return (
      <Navigate
        to={`/settings/user-guide/${USER_GUIDE_TOPICS[0].slug}`}
        replace
      />
    );
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
          User Guide
        </span>
        <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
          {active.title}
        </h1>
      </header>

      <article
        className="md-body max-w-[820px] text-[15px] leading-relaxed text-ink"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(active.body) }}
      />
    </div>
  );
}

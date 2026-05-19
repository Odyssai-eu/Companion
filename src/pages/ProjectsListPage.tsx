import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ProjectIcon } from "~/components/ProjectIcon";
import { ProjectStatusIcons } from "~/components/ProjectStatusIcons";
import Sidebar from "~/components/chat/Sidebar";
import { api, type ApiConversation, type ApiProject } from "~/lib/api";

/**
 * /projects — project workspace landing page.
 *
 * Grid of square tiles, 4 per row. Each tile = one project: icon, name,
 * conversation count. Last tile is "+ New project" → /projects/new.
 *
 * Pattern: same Sidebar mounted on the left (preserves nav consistency),
 * grid in the main column. Click a tile → /projects/:id (existing
 * ProjectPage component handles the rest).
 */

export default function ProjectsListPage() {
  const [projects, setProjects] = useState<ApiProject[] | null>(null);
  const [conversations, setConversations] = useState<ApiConversation[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listProjects(), api.listConversations()])
      .then(([{ projects }, { conversations }]) => {
        if (cancelled) return;
        setProjects(projects);
        setConversations(conversations);
      })
      .catch((e) => {
        if (cancelled) return;
        setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function convCount(projectId: string): number {
    return conversations.filter((c) => c.projectId === projectId).length;
  }

  return (
    <div className="flex h-screen">
      <Sidebar activeConversationId={null} activeProjectId={null} />
      <main className="flex-1 overflow-y-auto bg-white">
        <div className="mx-auto max-w-[1200px] px-8 py-10">
          <header className="mb-8 flex flex-col gap-1">
            <span className="font-sans text-[11px] font-medium tracking-[0.08em] text-cyan uppercase">
              Workspace
            </span>
            <h1 className="font-display text-[32px] font-light text-navy">
              Projects
            </h1>
            <p className="text-[13px] text-gray-500">
              Each project bundles its own conversations, memory, and system
              prompt. Click a tile to enter.
            </p>
          </header>

          {error && (
            <div className="mb-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 font-mono text-[12px] text-red-700">
              {error}
            </div>
          )}

          {projects === null ? (
            <div className="font-mono text-[12px] text-gray-400">Loading…</div>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {projects.map((p) => (
                <ProjectTile
                  key={p.id}
                  project={p}
                  conversationCount={convCount(p.id)}
                />
              ))}
              <NewProjectTile />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function ProjectTile({
  project,
  conversationCount,
}: {
  project: ApiProject;
  conversationCount: number;
}) {
  return (
    <Link
      to={`/projects/${project.id}`}
      className="group flex aspect-square flex-col items-start justify-between rounded-2xl border border-gray-200 bg-white p-5 transition-all hover:border-cyan hover:shadow-md"
    >
      <div className="flex w-full items-start justify-between">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[rgba(79,179,217,0.10)] text-cyan transition-colors group-hover:bg-cyan group-hover:text-white">
          <ProjectIcon name={project.icon} size={22} />
        </div>
        {/* Status icons mirror the project page header: shows what's
         *  wired up at a glance. Hidden when nothing is active. */}
        <ProjectStatusIcons project={project} size={12} tone="ghost" />
      </div>
      <div className="flex w-full flex-col gap-1">
        <span className="line-clamp-2 text-[15px] font-medium text-ink">
          {project.name}
        </span>
        <span className="font-mono text-[11px] text-gray-400">
          {conversationCount} chat{conversationCount === 1 ? "" : "s"}
        </span>
      </div>
    </Link>
  );
}

function NewProjectTile() {
  return (
    <Link
      to="/projects/new"
      className="group flex aspect-square flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-gray-200 bg-white p-5 transition-all hover:border-cyan hover:bg-[rgba(79,179,217,0.04)]"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gray-50 text-gray-400 transition-colors group-hover:bg-cyan group-hover:text-white">
        <PlusIcon />
      </div>
      <span className="text-[13px] font-medium text-gray-500 group-hover:text-navy">
        New project
      </span>
    </Link>
  );
}

function PlusIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

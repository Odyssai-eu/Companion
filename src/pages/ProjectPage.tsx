import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import Sidebar from "~/components/chat/Sidebar";
import { ProjectIcon } from "~/components/ProjectIcon";
import {
  api,
  type ApiConversation,
  type ApiProject,
  type ApiProjectCategory,
} from "~/lib/api";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = id === "new";
  const [project, setProject] = useState<ApiProject | null>(null);
  const [conversations, setConversations] = useState<ApiConversation[]>([]);
  const [categories, setCategories] = useState<ApiProjectCategory[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [category, setCategory] = useState("general");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [instructions, setInstructions] = useState("");
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .listProjectCategories()
      .then((r) => setCategories(r.categories))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (isNew) {
      setProject(null);
      setName("");
      setCategory("general");
      setSystemPrompt("");
      setInstructions("");
      setMemoryEnabled(true);
      return;
    }
    if (!id) return;
    setError(null);
    Promise.all([api.getProject(id), api.listConversations()])
      .then(([p, c]) => {
        setProject(p.project);
        setName(p.project.name);
        setCategory(p.project.category);
        setSystemPrompt(p.project.systemPrompt ?? "");
        setInstructions(p.project.instructions ?? "");
        setMemoryEnabled(p.project.memoryEnabled ?? true);
        setConversations(c.conversations.filter((x) => x.projectId === id));
      })
      .catch((e) => setError((e as Error).message));
  }, [id, isNew]);

  function applyCategoryPreset(newCategory: string) {
    setCategory(newCategory);
    const preset = categories.find((c) => c.id === newCategory);
    if (preset && (!systemPrompt || isPresetContent(systemPrompt))) {
      setSystemPrompt(preset.systemPrompt);
    }
  }

  function isPresetContent(text: string): boolean {
    return categories.some((c) => c.systemPrompt === text);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      if (isNew) {
        const { project } = await api.createProject({
          name: name.trim(),
          category,
          systemPrompt,
          instructions,
          memoryEnabled,
        });
        navigate(`/projects/${project.id}`, { replace: true });
      } else if (id) {
        const { project } = await api.updateProject(id, {
          name: name.trim(),
          category,
          systemPrompt,
          instructions,
          memoryEnabled,
        });
        setProject(project);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function startNewChat() {
    if (!project) return;
    try {
      const { conversation } = await api.createConversation({
        projectId: project.id,
        title: "New conversation",
      });
      navigate(`/c/${conversation.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove() {
    if (!project) return;
    if (!confirm(`Delete project "${project.name}"?`)) return;
    try {
      await api.deleteProject(project.id);
      navigate("/", { replace: true });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-50">
      <Sidebar
        activeConversationId={null}
        // While viewing a project, the sidebar lists *that* project's
        // conversations only.
        activeProjectId={isNew ? null : id ?? null}
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[820px] flex-col gap-10 px-14 py-16">
          <header className="flex items-start justify-between gap-6">
            <div className="flex flex-col gap-2">
              <Link
                to="/"
                className="flex items-center gap-1.5 text-[13px] text-gray-500 hover:text-ink"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                Back to chat
              </Link>
              <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
                Project
              </span>
              <h1 className="flex items-center gap-3 font-display text-[40px] leading-[48px] font-light text-navy">
                <ProjectIcon
                  name={categoryIcon(categories, category)}
                  size={32}
                  className="text-navy"
                />
                {isNew ? "New project." : `${project?.name ?? "…"}.`}
              </h1>
            </div>
            {!isNew && project && (
              <div className="flex flex-shrink-0 gap-2">
                <a
                  href={api.exportProjectUrl(project.id)}
                  download
                  className="flex h-9 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3.5 text-[13px] font-medium text-ink hover:bg-gray-50"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Export .md
                </a>
                <button
                  type="button"
                  onClick={startNewChat}
                  className="flex h-9 items-center gap-2 rounded-lg bg-navy px-4 text-[13px] font-medium text-white hover:opacity-95"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  New chat in project
                </button>
              </div>
            )}
          </header>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 font-mono text-[12px] text-red-700">
              {error}
            </div>
          )}

          <form onSubmit={save} className="flex flex-col gap-5">
            <Field label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Q3 strategy, thesis research, …"
                required
                className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
              />
            </Field>

            <Field label="Category">
              <div className="grid grid-cols-5 gap-2">
                {categories.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => applyCategoryPreset(cat.id)}
                    className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-3 text-[12px] transition-colors ${
                      category === cat.id
                        ? "border-cyan bg-[rgba(79,179,217,0.08)] text-navy"
                        : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                    }`}
                  >
                    <ProjectIcon
                      name={cat.icon}
                      size={22}
                      className={
                        category === cat.id ? "text-navy" : "text-gray-500"
                      }
                    />
                    <span className="font-medium">{cat.name}</span>
                  </button>
                ))}
              </div>
            </Field>

            <Field
              label="System prompt"
              hint="Sent as the first system message in every conversation in this project."
            >
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={6}
                className="w-full resize-y rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[13px] leading-[20px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
              />
            </Field>

            <Field
              label="Instructions"
              hint="Private notes — for you, not sent to the engine."
            >
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={3}
                placeholder="Anything you want to remember about how you're using this project."
                className="w-full resize-y rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[13px] leading-[20px] text-ink outline-none placeholder:text-gray-400 focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
              />
            </Field>

            <Field
              label="Memory"
              hint="When ON, every new conversation in this project starts with your memory wiki injected into the system prompt. Each conversation can still flip its own toggle from the chat header. Turn OFF if this project deals with sensitive context that shouldn't bleed into your wiki — or if you simply want a clean slate."
            >
              <button
                type="button"
                role="switch"
                aria-checked={memoryEnabled}
                onClick={() => setMemoryEnabled((v) => !v)}
                className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-3 transition-colors ${
                  memoryEnabled
                    ? "border-cyan bg-[rgba(79,179,217,0.06)]"
                    : "border-gray-200 bg-white hover:bg-gray-50"
                }`}
              >
                <span className="flex flex-col gap-0.5 text-left">
                  <span className="text-[13px] font-medium text-ink">
                    Memory injection {memoryEnabled ? "ON" : "OFF"}
                  </span>
                  <span className="text-[12px] text-gray-500">
                    {memoryEnabled
                      ? "Wiki snapshot is loaded into every new conversation here."
                      : "New conversations start with no wiki context."}
                  </span>
                </span>
                <span
                  className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors ${
                    memoryEnabled ? "bg-cyan" : "bg-gray-300"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-[left] ${
                      memoryEnabled ? "left-[22px]" : "left-0.5"
                    }`}
                  />
                </span>
              </button>
            </Field>

            <div className="flex items-center justify-between gap-3 pt-2">
              {!isNew && (
                <button
                  type="button"
                  onClick={remove}
                  className="flex h-9 items-center rounded-lg border border-red-200 bg-white px-4 text-[13px] font-medium text-red-600 hover:bg-red-50"
                >
                  Delete project
                </button>
              )}
              <button
                type="submit"
                disabled={submitting || !name.trim()}
                className="ml-auto flex h-9 items-center rounded-lg bg-navy px-4 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
              >
                {submitting ? "Saving…" : isNew ? "Create project" : "Save changes"}
              </button>
            </div>
          </form>

          {!isNew && conversations.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="font-display text-[20px] font-light text-navy">
                Conversations
              </h2>
              <div className="flex flex-col gap-2">
                {conversations.map((c) => (
                  <Link
                    key={c.id}
                    to={`/c/${c.id}`}
                    className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-cyan"
                  >
                    <span className="truncate text-[13px] text-ink">
                      {c.title}
                    </span>
                    <span className="font-mono text-[11px] text-gray-400">
                      {new Date(c.updatedAt).toLocaleDateString()}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-gray-400">{hint}</span>}
    </label>
  );
}

function categoryIcon(
  cats: ApiProjectCategory[],
  id: string,
): string {
  return cats.find((c) => c.id === id)?.icon ?? "📁";
}

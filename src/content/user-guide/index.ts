// Topic loader shared by SettingsNav (sidebar expansion) and
// UserGuidePage (body content). Vite picks up every .md file in
// this folder at build time, sorted by filename so the numeric
// prefix controls order.
const RAW = import.meta.glob("./*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export type Topic = { slug: string; title: string; body: string };

function parse(path: string, raw: string): Topic {
  const file = path.split("/").pop() ?? "";
  const slug = file.replace(/^\d+-/, "").replace(/\.md$/, "");
  const lines = raw.split("\n");
  const titleLine = lines.find((l) => l.startsWith("# "));
  const title = titleLine ? titleLine.slice(2).trim() : slug;
  const body = titleLine
    ? raw.replace(titleLine, "").replace(/^\s*\n/, "")
    : raw;
  return { slug, title, body };
}

export const USER_GUIDE_TOPICS: Topic[] = Object.entries(RAW)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, raw]) => parse(path, raw));

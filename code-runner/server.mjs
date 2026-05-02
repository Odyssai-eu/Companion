import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT ?? 8765);
const TOKEN = process.env.CODE_RUNNER_TOKEN ?? "";
const ALLOWED_ROOTS = (process.env.CODE_RUNNER_ALLOWED_ROOTS ?? `${process.env.HOME}/repos`)
  .split(",")
  .map((p) => resolvePath(p.trim()))
  .filter(Boolean);

const DOC_CANDIDATES = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "MEMORY.md",
  "docs/architecture.md",
  "docs/coding-agent-architecture.md",
];

const MANIFEST_CANDIDATES = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "deno.json",
  "bun.lock",
  "pnpm-lock.yaml",
  "package-lock.json",
];

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, {
        ok: true,
        runner: "thecompai-code-runner",
        host: process.env.HOSTNAME ?? "unknown",
        allowedRoots: ALLOWED_ROOTS,
        writeMode: false,
      });
    }

    if (!isAuthorized(req)) {
      return json(res, 401, { error: "unauthorized" });
    }

    if (req.method === "POST" && req.url === "/preflight") {
      const body = await readJson(req);
      const preflight = await runPreflight({
        repoPath: String(body.repoPath ?? ""),
        task: String(body.task ?? ""),
      });
      return json(res, 200, { preflight });
    }

    return json(res, 404, { error: "not_found" });
  } catch (e) {
    return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`thecompai-code-runner listening on :${PORT}`);
});

async function runPreflight({ repoPath, task }) {
  const blockers = [];
  if (!repoPath.trim()) blockers.push("missing_repo_path");
  if (!task.trim()) blockers.push("missing_task");

  const requested = resolvePath(repoPath);
  const allowed = ALLOWED_ROOTS.some((root) => isInside(requested, root));
  if (!allowed) blockers.push("repo_path_outside_allowed_roots");

  let repoExists = false;
  let resolvedRepo = requested;
  try {
    const s = await stat(requested);
    repoExists = s.isDirectory();
    if (!repoExists) blockers.push("repo_path_not_directory");
    resolvedRepo = await realpath(requested);
  } catch {
    blockers.push("repo_path_not_found");
  }

  const docsRead = repoExists && allowed ? await readDocs(resolvedRepo) : [];
  if (!docsRead.some((d) => d.path.endsWith("AGENTS.md"))) {
    blockers.push("missing_AGENTS_md");
  }

  const manifests = repoExists && allowed
    ? await findExisting(resolvedRepo, MANIFEST_CANDIDATES)
    : [];
  const git = repoExists && allowed ? await inspectGit(resolvedRepo) : null;

  return {
    runnerHost: await hostname(),
    repoPath: resolvedRepo,
    repoName: basename(resolvedRepo),
    repoExists,
    allowed,
    gitRepo: git?.gitRepo ?? false,
    dirtyTree: git?.dirtyTree ?? null,
    docsRead,
    manifests,
    blockers,
    forbiddenMoves: [
      "No writes in preflight.",
      "No package install.",
      "No git reset/checkout/commit.",
      "No rsync workaround.",
    ],
    risk: blockers.length > 0 ? "high" : git?.dirtyTree ? "medium" : "low",
  };
}

async function readDocs(repo) {
  const out = [];
  for (const inherited of await findInheritedInstructionDocs(repo)) {
    const text = await readFile(inherited.full, "utf8");
    out.push({
      path: inherited.label,
      bytes: Buffer.byteLength(text, "utf8"),
      excerpt: text.slice(0, 1200),
    });
  }
  for (const path of DOC_CANDIDATES) {
    const full = join(repo, path);
    if (!(await pathExists(full))) continue;
    if (out.some((d) => d.path === path)) continue;
    const text = await readFile(full, "utf8");
    out.push({
      path,
      bytes: Buffer.byteLength(text, "utf8"),
      excerpt: text.slice(0, 1200),
    });
  }
  return out;
}

async function findInheritedInstructionDocs(repo) {
  const found = [];
  let current = repo;
  while (ALLOWED_ROOTS.some((root) => isInside(current, root))) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const full = join(current, name);
      if (await pathExists(full)) {
        found.push({ full, label: relative(repo, full) || name });
      }
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return found;
}

async function findExisting(repo, candidates) {
  const out = [];
  for (const path of candidates) {
    if (await pathExists(join(repo, path))) out.push(path);
  }
  return out;
}

async function inspectGit(repo) {
  try {
    await execFileAsync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { timeout: 3000 });
    const { stdout } = await execFileAsync("git", ["-C", repo, "status", "--porcelain"], {
      timeout: 3000,
    });
    return { gitRepo: true, dirtyTree: stdout.trim().length > 0 };
  } catch {
    return { gitRepo: false, dirtyTree: null };
  }
}

async function hostname() {
  try {
    const { stdout } = await execFileAsync("hostname", [], { timeout: 1000 });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

function isAuthorized(req) {
  if (!TOKEN) return false;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function resolvePath(p) {
  if (isAbsolute(p)) return resolve(p);
  return resolve(process.cwd(), p);
}

function isInside(candidate, root) {
  const rel = candidate === root ? "" : candidate.slice(root.length);
  return candidate === root || (candidate.startsWith(root) && rel.startsWith(sep));
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}


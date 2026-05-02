import { execFile } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CodePreflightInput = {
  repoPath: string;
  task: string;
  project?: string;
};

export type CodePreflightResult = {
  repoPath: string;
  repoName: string;
  repoExists: boolean;
  allowed: boolean;
  gitRepo: boolean;
  dirtyTree: boolean | null;
  docsRead: Array<{ path: string; bytes: number; excerpt: string }>;
  manifests: string[];
  memorySources: string[];
  factsUsed: string[];
  forbiddenMoves: string[];
  blockers: string[];
  risk: "low" | "medium" | "high";
};

const DEFAULT_ALLOWED_ROOTS = [
  "/Users/sophie/Claude/code",
  "/home/admin",
  "/workspace",
];

const DOC_CANDIDATES = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "MEMORY.md",
  "docs/architecture.md",
  "docs/migration/12-decisions-log.md",
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

const INFRA_TERMS = [
  "ssh",
  "cluster",
  "deploy",
  "deployment",
  "hermes",
  "rag",
  "litellm",
  "exo",
  "rpi",
  "docker",
  ".44",
  "192.168.",
];

export async function runCodePreflight(
  input: CodePreflightInput,
): Promise<CodePreflightResult> {
  const blockers: string[] = [];
  const factsUsed: string[] = [];
  const memorySources: string[] = [];
  const forbiddenMoves = [
    "Do not ask for facts that are present in AGENTS.md, local docs, memory, or RAG.",
    "Do not SSH before reading cluster-infrastructure when infra is involved.",
    "Do not rsync a repository as a workaround for runner/filesystem access.",
    "Do not write outside the declared write scope.",
    "Do not invent local service APIs when source code is readable.",
  ];

  if (!input.repoPath.trim()) blockers.push("missing_repo_path");
  if (!input.task.trim()) blockers.push("missing_task");

  const requested = resolvePath(input.repoPath);
  const allowedRoots = getAllowedRoots();
  const allowed = allowedRoots.some((root) => isInside(requested, root));
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

  const docsRead =
    repoExists && allowed ? await readDocs(resolvedRepo) : [];
  if (!docsRead.some((d) => d.path.endsWith("AGENTS.md"))) {
    blockers.push("missing_AGENTS_md");
  }

  const manifests =
    repoExists && allowed ? await findExisting(resolvedRepo, MANIFEST_CANDIDATES) : [];

  const git = repoExists && allowed ? await inspectGit(resolvedRepo) : null;
  const gitRepo = git?.gitRepo ?? false;
  const dirtyTree = git?.dirtyTree ?? null;

  if (shouldLoadInfra(input.task)) {
    const infra = await readSharedMemoryArticle(
      "knowledge/concepts/cluster-infrastructure.md",
    );
    if (infra) {
      memorySources.push("concepts/cluster-infrastructure");
      factsUsed.push(
        "m4pro-24/RAG/Hermes/LiteLLM = admin@192.168.86.44",
        "rpi-dev/TheCompAI dev deploy = admin@192.168.86.18",
        "mbp-m5-32 = sophie@192.168.86.79 and marked personal/not deployment target",
      );
    } else {
      blockers.push("infra_task_without_cluster_infrastructure_memory");
    }
  }

  if (input.task.toLowerCase().includes("hermes")) {
    const bridgeReadable = await pathExists(
      "/Users/sophie/Claude/code/thecompai-hermes-bridge/src/hermes_bridge/main.py",
    );
    if (bridgeReadable) {
      factsUsed.push(
        "Hermes bridge source is locally readable before changing Hermes API assumptions.",
      );
    } else {
      blockers.push("hermes_task_without_local_bridge_source");
    }
  }

  const risk = classifyRisk({
    blockers,
    dirtyTree,
    gitRepo,
    task: input.task,
  });

  return {
    repoPath: resolvedRepo,
    repoName: basename(resolvedRepo),
    repoExists,
    allowed,
    gitRepo,
    dirtyTree,
    docsRead,
    manifests,
    memorySources,
    factsUsed,
    forbiddenMoves,
    blockers,
    risk,
  };
}

function resolvePath(p: string): string {
  if (isAbsolute(p)) return resolve(p);
  return resolve(process.cwd(), p);
}

function getAllowedRoots(): string[] {
  return (process.env.CODE_RUNNER_ALLOWED_ROOTS ?? DEFAULT_ALLOWED_ROOTS.join(","))
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolvePath(p));
}

function isInside(candidate: string, root: string): boolean {
  const rel = candidate === root ? "" : candidate.slice(root.length);
  return candidate === root || (candidate.startsWith(root) && rel.startsWith(sep));
}

async function readDocs(repo: string) {
  const out: CodePreflightResult["docsRead"] = [];
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

async function findInheritedInstructionDocs(repo: string) {
  const allowedRoots = getAllowedRoots();
  const found: Array<{ full: string; label: string }> = [];
  let current = repo;
  while (allowedRoots.some((root) => isInside(current, root))) {
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

async function findExisting(repo: string, candidates: string[]) {
  const out: string[] = [];
  for (const path of candidates) {
    if (await pathExists(join(repo, path))) out.push(path);
  }
  return out;
}

async function inspectGit(repo: string) {
  try {
    await execFileAsync("git", ["-C", repo, "rev-parse", "--show-toplevel"], {
      timeout: 3000,
    });
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repo, "status", "--porcelain"],
      { timeout: 3000 },
    );
    return { gitRepo: true, dirtyTree: stdout.trim().length > 0 };
  } catch {
    return { gitRepo: false, dirtyTree: null };
  }
}

function shouldLoadInfra(task: string): boolean {
  const lower = task.toLowerCase();
  return INFRA_TERMS.some((term) => lower.includes(term));
}

async function readSharedMemoryArticle(relativePath: string) {
  const root =
    process.env.SHARED_MEMORY_ROOT ?? "/Users/sophie/Claude/code/shared-memory";
  const full = join(root, relativePath);
  if (!(await pathExists(full))) return null;
  return readFile(full, "utf8").catch(() => null);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function classifyRisk({
  blockers,
  dirtyTree,
  gitRepo,
  task,
}: {
  blockers: string[];
  dirtyTree: boolean | null;
  gitRepo: boolean;
  task: string;
}): "low" | "medium" | "high" {
  if (blockers.length > 0) return "high";
  if (dirtyTree) return "medium";
  if (!gitRepo) return "medium";
  const lower = task.toLowerCase();
  if (
    lower.includes("migration") ||
    lower.includes("deploy") ||
    lower.includes("auth") ||
    lower.includes("billing")
  ) {
    return "medium";
  }
  return "low";
}

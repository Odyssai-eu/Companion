import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
        writeMode: true,
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

    if (req.method === "POST" && req.url === "/write-tests") {
      const body = await readJson(req);
      const result = await writeTests({
        repoPath: String(body.repoPath ?? ""),
        task: String(body.task ?? ""),
        files: Array.isArray(body.files) ? body.files : [],
      });
      return json(res, 200, { write: result });
    }

    if (req.method === "POST" && req.url === "/run-tests") {
      const body = await readJson(req);
      const result = await runTests({
        repoPath: String(body.repoPath ?? ""),
        task: String(body.task ?? ""),
        command: String(body.command ?? ""),
      });
      return json(res, 200, { test: result });
    }

    if (req.method === "POST" && req.url === "/status") {
      const body = await readJson(req);
      const result = await repoStatus({
        repoPath: String(body.repoPath ?? ""),
        task: String(body.task ?? ""),
        files: Array.isArray(body.files) ? body.files.map(String) : [],
      });
      return json(res, 200, { status: result });
    }

    if (req.method === "POST" && req.url === "/discard") {
      const body = await readJson(req);
      const result = await discardChanges({
        repoPath: String(body.repoPath ?? ""),
        task: String(body.task ?? ""),
        files: Array.isArray(body.files) ? body.files.map(String) : [],
      });
      return json(res, 200, { discard: result });
    }

    if (req.method === "POST" && req.url === "/commit") {
      const body = await readJson(req);
      const result = await commitChanges({
        repoPath: String(body.repoPath ?? ""),
        task: String(body.task ?? ""),
        files: Array.isArray(body.files) ? body.files.map(String) : [],
        message: String(body.message ?? ""),
      });
      return json(res, 200, { commit: result });
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

async function writeTests({ repoPath, task, files }) {
  const preflight = await runPreflight({ repoPath, task });
  if (preflight.blockers.length > 0) {
    return {
      ok: false,
      repoPath: preflight.repoPath,
      filesWritten: [],
      blockers: preflight.blockers,
      diffStat: "",
      diff: "",
    };
  }

  const blockers = [];
  const normalizedFiles = [];
  for (const file of files) {
    const path = String(file?.path ?? "").trim();
    const content = String(file?.content ?? "");
    if (!path) {
      blockers.push("missing_file_path");
      continue;
    }
    if (!isAllowedTestPath(path)) {
      blockers.push(`path_outside_test_scope:${path}`);
      continue;
    }
    const full = resolve(preflight.repoPath, path);
    if (!isInside(full, preflight.repoPath)) {
      blockers.push(`path_escape:${path}`);
      continue;
    }
    normalizedFiles.push({ path, full, content });
  }

  if (normalizedFiles.length === 0) blockers.push("no_valid_test_files");
  if (blockers.length > 0) {
    return {
      ok: false,
      repoPath: preflight.repoPath,
      filesWritten: [],
      blockers,
      diffStat: "",
      diff: "",
    };
  }

  for (const file of normalizedFiles) {
    await mkdir(dirname(file.full), { recursive: true });
    await writeFile(file.full, file.content, "utf8");
  }

  const diffStat = preflight.gitRepo ? await gitOutput(preflight.repoPath, ["diff", "--stat"]) : "";
  const diff = preflight.gitRepo
    ? await gitOutput(preflight.repoPath, ["diff", "--", ...normalizedFiles.map((f) => f.path)])
    : "";

  return {
    ok: true,
    repoPath: preflight.repoPath,
    repoName: preflight.repoName,
    filesWritten: normalizedFiles.map((f) => f.path),
    blockers: [],
    gitRepo: preflight.gitRepo,
    diffStat,
    diff,
    forbiddenMoves: [
      "Only test files were allowed.",
      "No package install.",
      "No git reset/checkout/commit.",
      "No deploy.",
    ],
  };
}

async function runTests({ repoPath, task, command }) {
  const preflight = await runPreflight({ repoPath, task });
  if (preflight.blockers.length > 0) {
    return {
      ok: false,
      repoPath: preflight.repoPath,
      command: "",
      exitCode: null,
      stdout: "",
      stderr: "",
      blockers: preflight.blockers,
      elapsedMs: 0,
    };
  }

  const selected = command.trim() || defaultTestCommand(preflight);
  const parsed = parseAllowedTestCommand(selected);
  if (!parsed) {
    return {
      ok: false,
      repoPath: preflight.repoPath,
      command: selected,
      exitCode: null,
      stdout: "",
      stderr: "",
      blockers: [`test_command_not_allowed:${selected}`],
      elapsedMs: 0,
    };
  }

  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(parsed.bin, parsed.args, {
      cwd: preflight.repoPath,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
      },
    });
    return {
      ok: true,
      repoPath: preflight.repoPath,
      command: selected,
      exitCode: 0,
      stdout,
      stderr,
      blockers: [],
      elapsedMs: Date.now() - started,
    };
  } catch (e) {
    return {
      ok: false,
      repoPath: preflight.repoPath,
      command: selected,
      exitCode: typeof e?.code === "number" ? e.code : 1,
      stdout: String(e?.stdout ?? ""),
      stderr: String(e?.stderr ?? e?.message ?? e),
      blockers: [],
      elapsedMs: Date.now() - started,
    };
  }
}

async function repoStatus({ repoPath, task, files }) {
  const preflight = await runPreflight({ repoPath, task });
  if (preflight.blockers.length > 0) {
    return { ok: false, repoPath: preflight.repoPath, blockers: preflight.blockers };
  }
  if (!preflight.gitRepo) {
    return {
      ok: true,
      repoPath: preflight.repoPath,
      gitRepo: false,
      dirtyFiles: [],
      diffStat: "",
      diff: "",
      blockers: [],
    };
  }
  const scoped = normalizeScopedTestFiles(preflight.repoPath, files);
  if (scoped.blockers.length > 0) {
    return { ok: false, repoPath: preflight.repoPath, blockers: scoped.blockers };
  }
  const args = scoped.files.length > 0 ? ["--", ...scoped.files] : [];
  const porcelain = await gitOutput(preflight.repoPath, ["status", "--porcelain", ...args]);
  return {
    ok: true,
    repoPath: preflight.repoPath,
    gitRepo: true,
    dirtyFiles: porcelain
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    diffStat: await gitOutput(preflight.repoPath, ["diff", "--stat", ...args]),
    diff: await gitOutput(preflight.repoPath, ["diff", ...args]),
    blockers: [],
  };
}

async function discardChanges({ repoPath, task, files }) {
  const preflight = await runPreflight({ repoPath, task });
  if (preflight.blockers.length > 0) {
    return { ok: false, repoPath: preflight.repoPath, filesDiscarded: [], blockers: preflight.blockers };
  }
  if (!preflight.gitRepo) {
    return { ok: false, repoPath: preflight.repoPath, filesDiscarded: [], blockers: ["discard_requires_git_repo"] };
  }
  const scoped = normalizeScopedTestFiles(preflight.repoPath, files);
  if (scoped.blockers.length > 0) {
    return { ok: false, repoPath: preflight.repoPath, filesDiscarded: [], blockers: scoped.blockers };
  }
  if (scoped.files.length === 0) {
    return { ok: false, repoPath: preflight.repoPath, filesDiscarded: [], blockers: ["missing_files"] };
  }
  const porcelain = await gitOutput(preflight.repoPath, ["status", "--porcelain", "--", ...scoped.files]);
  await execFileAsync("git", ["-C", preflight.repoPath, "checkout", "--", ...scoped.files], {
    timeout: 5000,
  }).catch(() => undefined);
  for (const line of porcelain.split("\n")) {
    if (!line.startsWith("?? ")) continue;
    const path = line.slice(3).trim();
    if (scoped.files.includes(path)) {
      await rm(resolve(preflight.repoPath, path), { force: true, recursive: true });
    }
  }
  return {
    ok: true,
    repoPath: preflight.repoPath,
    filesDiscarded: scoped.files,
    blockers: [],
    status: await repoStatus({ repoPath: preflight.repoPath, task, files: scoped.files }),
  };
}

async function commitChanges({ repoPath, task, files, message }) {
  const preflight = await runPreflight({ repoPath, task });
  if (preflight.blockers.length > 0) {
    return { ok: false, repoPath: preflight.repoPath, sha: "", blockers: preflight.blockers };
  }
  if (!preflight.gitRepo) {
    return { ok: false, repoPath: preflight.repoPath, sha: "", blockers: ["commit_requires_git_repo"] };
  }
  const scoped = normalizeScopedTestFiles(preflight.repoPath, files);
  if (scoped.blockers.length > 0) {
    return { ok: false, repoPath: preflight.repoPath, sha: "", blockers: scoped.blockers };
  }
  if (scoped.files.length === 0) {
    return { ok: false, repoPath: preflight.repoPath, sha: "", blockers: ["missing_files"] };
  }
  const msg = message.trim() || "test: add Hermes generated test coverage";
  await execFileAsync("git", ["-C", preflight.repoPath, "add", "--", ...scoped.files], { timeout: 5000 });
  const porcelain = await gitOutput(preflight.repoPath, ["diff", "--cached", "--name-only", "--", ...scoped.files]);
  if (!porcelain.trim()) {
    return { ok: false, repoPath: preflight.repoPath, sha: "", blockers: ["nothing_to_commit"] };
  }
  await execFileAsync("git", ["-C", preflight.repoPath, "commit", "-m", msg], { timeout: 10000 });
  const sha = (await gitOutput(preflight.repoPath, ["rev-parse", "HEAD"])).trim();
  return {
    ok: true,
    repoPath: preflight.repoPath,
    sha,
    message: msg,
    filesCommitted: scoped.files,
    blockers: [],
    status: await repoStatus({ repoPath: preflight.repoPath, task, files: scoped.files }),
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

async function gitOutput(repo, args) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

function isAllowedTestPath(path) {
  if (isAbsolute(path)) return false;
  if (path.split(/[\\/]/).some((part) => part === "..")) return false;
  return (
    path.startsWith("tests/") ||
    path.includes("/__tests__/") ||
    path.startsWith("__tests__/") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
  );
}

function normalizeScopedTestFiles(repo, files) {
  const blockers = [];
  const normalized = [];
  for (const raw of files) {
    const path = String(raw ?? "").trim();
    if (!path) continue;
    if (!isAllowedTestPath(path)) {
      blockers.push(`path_outside_test_scope:${path}`);
      continue;
    }
    const full = resolve(repo, path);
    if (!isInside(full, repo)) {
      blockers.push(`path_escape:${path}`);
      continue;
    }
    normalized.push(path);
  }
  return { files: [...new Set(normalized)], blockers };
}

function defaultTestCommand(preflight) {
  if (preflight.manifests.includes("package.json")) return "npm test";
  if (preflight.manifests.includes("pnpm-lock.yaml")) return "pnpm test";
  if (preflight.manifests.includes("bun.lock")) return "bun test";
  if (preflight.manifests.includes("deno.json")) return "deno test";
  if (preflight.manifests.includes("Cargo.toml")) return "cargo test";
  if (preflight.manifests.includes("go.mod")) return "go test ./...";
  if (preflight.manifests.includes("pyproject.toml")) return "python -m pytest";
  return "node --test";
}

function parseAllowedTestCommand(command) {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  const exact = command.trim();
  const allowedExact = new Map([
    ["npm test", ["npm", ["test"]]],
    ["pnpm test", ["pnpm", ["test"]]],
    ["yarn test", ["yarn", ["test"]]],
    ["bun test", ["bun", ["test"]]],
    ["deno test", ["deno", ["test"]]],
    ["cargo test", ["cargo", ["test"]]],
    ["go test ./...", ["go", ["test", "./..."]]],
    ["python -m pytest", ["python", ["-m", "pytest"]]],
    ["python3 -m pytest", ["python3", ["-m", "pytest"]]],
    ["node --test", ["node", ["--test"]]],
  ]);
  const match = allowedExact.get(exact);
  if (match) return { bin: match[0], args: match[1] };
  if (parts[0] === "node" && parts[1] === "--test") {
    const testPaths = parts.slice(2);
    if (testPaths.length === 0 || testPaths.every(isAllowedTestPath)) {
      return { bin: "node", args: ["--test", ...testPaths] };
    }
  }
  return null;
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

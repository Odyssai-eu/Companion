/**
 * Project memory auto-compile.
 *
 * For each eligible project (dedicated memory ON + writes allowed) with
 * activity in the last 24h, gather the day's messages, ask an LLM to
 * extract 1-3 durable notes, and write the result to the project's
 * configured destination.
 *
 * Destinations (in priority order):
 *   1. `externalVaultPath` starts with `tcai://project/<uuid>` →
 *      upsert into the target project's `project_memory_files` table.
 *      Requires the source's `externalVaultReadOnly` to be false.
 *   2. `externalVaultPath` is an absolute filesystem path →
 *      write `auto/YYYY-MM-DD.md` under that directory.
 *      Requires the source's `externalVaultReadOnly` to be false.
 *   3. `externalVaultPath` is null → upsert into the project's own
 *      `project_memory_files` table. Always allowed (your own corpus).
 *
 * The LLM model is picked from env (`PROJECT_COMPILE_MODEL`) or defaults
 * to a fast/cheap alias known to the user's LiteLLM proxy. The call is
 * via the user's saved litellm credentials; falls back to the env
 * defaults if the user hasn't set them.
 *
 * Idempotent: `auto/YYYY-MM-DD.md` overwrites the same day's file on
 * a re-run, so accidental double-fire doesn't compound.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "../db/index";
import { nemoIngest } from "./memory";
import {
  conversations,
  messages,
  projectMemoryFiles,
  projects,
  users,
} from "../db/schema";

const TCAI_PROJECT_PREFIX = "tcai://project/";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Summarizer model resolution. Primary is local; secondary is cloud
 * and only fires if the primary call errors (network / 5xx / timeout).
 *
 * Primary order:
 *   1. env PROJECT_COMPILE_MODEL (deploy-wide override)
 *   2. users.default_model (whatever the user picked in Settings)
 *   3. 'agent-fast' (Qwen3.6-35B-A3B-MLX-8bit local on the cluster)
 *
 * Cloud fallback: 'Qwen3.6-flash' (routes to OpenRouter via LiteLLM
 * on a typical deployment). Only used if the primary path fails — keeps
 * normal traffic on the local cluster but doesn't drop the compile
 * when the cluster is down for maintenance.
 */
const COMPILE_MODEL_LOCAL_FALLBACK = "agent-fast";
const COMPILE_MODEL_CLOUD_FALLBACK = "Qwen3.6-flash";
const DEFAULT_LITELLM = process.env.LITELLM_URL ?? "";
const DEFAULT_KEY = process.env.LITELLM_API_KEY ?? null;
/** Match the per-file cap in project-memory.ts so a single compile
 *  result never blows past it. */
const MAX_NOTE_BYTES = 1 * 1024 * 1024;

const SUMMARIZER_PROMPT = `You distill recent project conversations into a
small set of durable knowledge entries — facts, decisions, preferences,
named entities — that future conversations should remember.

Rules:
- 1 to 3 entries maximum, each terse (1-4 sentences).
- Use markdown. Each entry as a "## Heading" + 1-3 lines of body.
- Skip pleasantries, scaffolding, anything the next chat already
  obviously knows.
- If nothing in the input is worth remembering, return literally
  "(nothing to retain)" and stop.
- Do NOT speculate, hedge, or add disclaimers. Either it's a fact
  worth keeping, or it's not in the output.

Output: markdown only. No preamble, no postscript.`;

type EligibleProject = {
  id: string;
  name: string;
  userId: string;
  externalVaultPath: string | null;
  externalVaultReadOnly: boolean;
};

/**
 * Pick the projects that should be compiled this slot. Eligibility:
 *  - dedicatedMemoryEnabled = true
 *  - either no externalVaultPath OR externalVaultReadOnly = false
 *  - the OWNER user had chat activity in the last `activeWindowMs`
 *
 * We don't filter on project-specific activity yet — the per-project
 * gather step will return [] when there are no messages, which the
 * caller handles as a no-op.
 */
export async function listEligibleProjects(
  activeWindowMs: number,
): Promise<EligibleProject[]> {
  const since = new Date(Date.now() - activeWindowMs);
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      userId: projects.userId,
      externalVaultPath: projects.externalVaultPath,
      externalVaultReadOnly: projects.externalVaultReadOnly,
      dedicatedMemoryEnabled: projects.dedicatedMemoryEnabled,
      lastInteractionAt: users.lastInteractionAt,
    })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.userId))
    .where(
      and(
        eq(projects.dedicatedMemoryEnabled, true),
        gte(users.lastInteractionAt, since),
      ),
    );
  return rows
    .filter((r) => {
      // Write allowed iff no external link OR the consumer is RW.
      if (!r.externalVaultPath) return true;
      return !r.externalVaultReadOnly;
    })
    .map((r) => ({
      id: r.id,
      name: r.name,
      userId: r.userId,
      externalVaultPath: r.externalVaultPath,
      externalVaultReadOnly: r.externalVaultReadOnly,
    }));
}

/**
 * Top-level entry. Returns a short status string for logging; never
 * throws — internal errors are caught and surfaced via console.warn
 * so a single bad project doesn't break the whole scheduler tick.
 */
export async function compileProject(p: EligibleProject): Promise<string> {
  try {
    const msgs = await gatherRecentMessages(p.id, 24 * 60 * 60 * 1000);
    if (msgs.length === 0) return "no-activity";
    const summary = await summarize(p, msgs);
    if (!summary || summary.trim() === "(nothing to retain)") {
      return "nothing-notable";
    }
    if (summary.length > MAX_NOTE_BYTES) {
      console.warn(
        `[project-compile] summary > ${MAX_NOTE_BYTES} bytes for project ${p.id}; truncating`,
      );
    }
    const note = summary.slice(0, MAX_NOTE_BYTES);
    const dest = await writeResult(p, note);
    // Project memory is a RAG tier: every compiled note also lands in the
    // project's own nemo collection (keyed by projectId, like team), so
    // chat retrieves it semantically instead of injecting the raw vault.
    nemoIngest(
      p.id,
      `project-auto:${p.id}:${new Date().toISOString().slice(0, 10)}`,
      note,
      "project",
    );
    return `wrote ${dest}`;
  } catch (err) {
    console.warn(
      `[project-compile] project=${p.id} failed:`,
      (err as Error).message,
    );
    return "error";
  }
}

async function gatherRecentMessages(
  projectId: string,
  windowMs: number,
): Promise<Array<{ role: string; content: string }>> {
  const since = new Date(Date.now() - windowMs);
  const rows = await db
    .select({
      role: messages.role,
      content: messages.content,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(conversations.projectId, projectId),
        gte(messages.createdAt, since),
      ),
    )
    .orderBy(asc(messages.createdAt));
  // Drop system messages from the digest — they're our wiki injection,
  // not user content. We also drop empty / placeholder assistants.
  return rows
    .filter((r) => r.role !== "system" && r.content.trim().length > 0)
    .map((r) => ({ role: r.role, content: r.content }));
}

async function summarize(
  p: EligibleProject,
  msgs: Array<{ role: string; content: string }>,
): Promise<string> {
  const [user] = await db
    .select({
      litellmUrl: users.litellmUrl,
      litellmApiKey: users.litellmApiKey,
      defaultModel: users.defaultModel,
    })
    .from(users)
    .where(eq(users.id, p.userId))
    .limit(1);
  const baseUrl = (user?.litellmUrl ?? DEFAULT_LITELLM).replace(/\/+$/, "");
  const apiKey = user?.litellmApiKey ?? DEFAULT_KEY;
  const primaryModel =
    process.env.PROJECT_COMPILE_MODEL ??
    user?.defaultModel ??
    COMPILE_MODEL_LOCAL_FALLBACK;

  // 60 KB input cap — a giant day shouldn't blow the prompt.
  const MAX_INPUT_BYTES = 60 * 1024;
  let body = "";
  for (const m of msgs) {
    const piece = `**${m.role}**: ${m.content}\n\n`;
    if (body.length + piece.length > MAX_INPUT_BYTES) break;
    body += piece;
  }

  // Try primary (local). On failure (timeout / 5xx / network), retry
  // ONCE with the cloud fallback. The compile shouldn't silently skip
  // when the cluster is down — we'd rather pay a cloud call than miss
  // a day's notes.
  const candidates =
    primaryModel === COMPILE_MODEL_CLOUD_FALLBACK
      ? [primaryModel]
      : [primaryModel, COMPILE_MODEL_CLOUD_FALLBACK];

  let lastErr: Error | null = null;
  for (const model of candidates) {
    try {
      return await callLLM(baseUrl, apiKey, model, p.name, body);
    } catch (err) {
      lastErr = err as Error;
      console.warn(
        `[project-compile] model=${model} failed: ${lastErr.message.slice(0, 120)}`,
      );
      // Try next candidate.
    }
  }
  throw lastErr ?? new Error("summarizer: no model succeeded");
}

async function callLLM(
  baseUrl: string,
  apiKey: string | null,
  model: string,
  projectName: string,
  body: string,
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: 800,
      temperature: 0.3,
      messages: [
        { role: "system", content: SUMMARIZER_PROMPT },
        {
          role: "user",
          content: `Project: ${projectName}\n\nRecent conversations:\n\n${body}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(
      `summarizer ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * Write the summary to the project's configured destination. Returns
 * a short string describing where it landed (for logging).
 */
async function writeResult(
  p: EligibleProject,
  note: string,
): Promise<string> {
  const today = new Date();
  const datePath = `auto/${today.toISOString().slice(0, 10)}.md`;
  const sizeBytes = new TextEncoder().encode(note).length;

  // (1) tcai:// link → upsert into the target project's DB corpus.
  if (
    p.externalVaultPath &&
    p.externalVaultPath.startsWith(TCAI_PROJECT_PREFIX)
  ) {
    const targetId = p.externalVaultPath.slice(TCAI_PROJECT_PREFIX.length).trim();
    if (!UUID_RE.test(targetId)) {
      throw new Error(`invalid tcai:// uuid: ${targetId}`);
    }
    // Defence in depth: confirm same-owner before writing.
    const [target] = await db
      .select({ id: projects.id, userId: projects.userId })
      .from(projects)
      .where(and(eq(projects.id, targetId), eq(projects.userId, p.userId)))
      .limit(1);
    if (!target) throw new Error("tcai target not found or owned by another user");
    await upsertProjectFile(target.id, datePath, note);
    return `tcai://project/${targetId} @ ${datePath}`;
  }

  // (2) Absolute filesystem path → write to disk.
  if (p.externalVaultPath) {
    const abs = join(p.externalVaultPath, datePath);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, note, "utf8");
    return `${abs}`;
  }

  // (3) No external destination → write into this project's own DB.
  await upsertProjectFile(p.id, datePath, note);
  return `db://project/${p.id} @ ${datePath}`;

  function upsertProjectFile(
    targetProjectId: string,
    path: string,
    content: string,
  ): Promise<unknown> {
    return db
      .insert(projectMemoryFiles)
      .values({
        projectId: targetProjectId,
        path,
        mimeType: "text/markdown",
        sizeBytes,
        content,
      })
      .onConflictDoUpdate({
        target: [projectMemoryFiles.projectId, projectMemoryFiles.path],
        set: {
          content,
          sizeBytes,
          mimeType: "text/markdown",
          updatedAt: new Date(),
        },
      });
  }
}

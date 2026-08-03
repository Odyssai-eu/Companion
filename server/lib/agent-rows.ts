// Agent resolution + builtin seeding — v2.0 « Cowork » runtime.
//
// The `agents` table uses the same asymmetric ownership pattern as
// `addons` (user_id NULL = instance row inherited by everyone; user_id
// set = personal row that shadows the instance one by name). The addons
// era produced five mirror-image bugs from bare `eq(userId)` queries —
// so ALL agent reads go through this module, never direct db queries.
//
// Precedence per name: user row > instance row. A disabled user row
// hides the agent for that user even if an enabled instance row exists
// (an override is an override).

import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../db/index";
import { agents, type AgentRow } from "../db/schema";
import {
  NARRATION_CONTRACT,
  NEMO_SOCLE,
  EXPLORE_PROMPT,
  WRITER_PROMPT,
  OPS_PROMPT,
} from "./agent-prompts";

// ── Builtin seeds ──────────────────────────────────────────────────────
// CONTRACT (revised v2.1): builtin rows TRACK the shipped seeds — the
// boot sync upserts prompt/description/tools/model on every deploy, so
// prompt evolutions actually reach live instances (the v2.0
// insert-if-missing contract silently stranded them). Personalization
// does NOT edit builtins anymore: it creates a user-level shadow row
// with the same name (resolution already gives user rows precedence).
// Only `enabled` is preserved on sync — disabling a builtin is an
// instance-level choice that survives deploys.

type SeedAgent = {
  name: string;
  displayName: string;
  description: string;
  mode: "primary" | "subagent";
  systemPrompt: string;
  model: string | null;
  toolsAllow: string[];
  maxSteps: number;
};

const BUILTIN_AGENTS: SeedAgent[] = [
  {
    name: "nemo",
    displayName: "Nemo",
    description:
      "Companion's default assistant — holds the conversation and delegates to subagents via the task tool.",
    mode: "primary",
    systemPrompt: NEMO_SOCLE,
    model: null,
    // The primary's DIRECT tools stay governed by the existing gating
    // (agent-mode toggle & co) — tools_allow is not enforced on primary
    // conversations in v2.0. Kept empty to make that explicit.
    toolsAllow: [],
    maxSteps: 15,
  },
  {
    name: "explore",
    displayName: "Explore",
    description:
      "Read-only research across memory, RAG, workspace files, web search and MCP sources. Delegate when the user needs facts gathered, prior decisions recalled, or sources compared.",
    mode: "subagent",
    systemPrompt: EXPLORE_PROMPT,
    model: null, // v2.1 — CoeOS classification decides
    toolsAllow: [
      "rag_search",
      "web_*",
      "fs_read",
      "fs_list",
      "skill_*",
      "mcp_*",
    ],
    maxSteps: 15,
  },
  {
    name: "writer",
    displayName: "Writer",
    description:
      "Produces complete long-form documents (reports, articles, syntheses) in the workspace. Delegate when the deliverable is a written file, not a chat answer.",
    mode: "subagent",
    systemPrompt: WRITER_PROMPT,
    model: null, // quality of prose → inherit the parent's model
    toolsAllow: ["fs_*", "rag_search", "skill_*"],
    maxSteps: 15,
  },
  {
    name: "ops",
    displayName: "Ops",
    description:
      "Executes well-scoped actions on the user's connected sources (Notion, Linear, infra MCP…). Delegate explicit, bounded operations — never open-ended exploration.",
    mode: "subagent",
    systemPrompt: OPS_PROMPT,
    model: null, // v2.1 — CoeOS classification decides
    toolsAllow: ["mcp_*", "skill_*"],
    maxSteps: 15,
  },
];

export async function seedBuiltinAgents(): Promise<void> {
  for (const seed of BUILTIN_AGENTS) {
    const [existing] = await db
      .select({ id: agents.id, systemPrompt: agents.systemPrompt })
      .from(agents)
      .where(
        and(
          isNull(agents.userId),
          eq(agents.name, seed.name),
          eq(agents.source, "builtin"),
        ),
      )
      .limit(1);
    if (!existing) {
      await db.insert(agents).values({
        userId: null,
        name: seed.name,
        displayName: seed.displayName,
        description: seed.description,
        mode: seed.mode,
        systemPrompt: seed.systemPrompt,
        model: seed.model,
        toolsAllow: seed.toolsAllow,
        maxSteps: seed.maxSteps,
        source: "builtin",
        enabled: true,
      });
      console.log(`[agents] seeded builtin '${seed.name}'`);
      continue;
    }
    // Sync pass — builtins track the code (see contract above). `enabled`
    // is deliberately left alone.
    await db
      .update(agents)
      .set({
        displayName: seed.displayName,
        description: seed.description,
        mode: seed.mode,
        systemPrompt: seed.systemPrompt,
        model: seed.model,
        toolsAllow: seed.toolsAllow,
        maxSteps: seed.maxSteps,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, existing.id));
    if (existing.systemPrompt !== seed.systemPrompt) {
      console.log(`[agents] builtin '${seed.name}' synced to shipped seed`);
    }
  }
}

// ── Resolution ─────────────────────────────────────────────────────────

/** Every agent visible to one user, user rows shadowing instance rows by
 *  name. Disabled rows are INCLUDED (the settings page needs them);
 *  callers that want only usable agents filter on .enabled. */
export async function resolveAgentsForUser(
  userId: string,
): Promise<AgentRow[]> {
  const [ownRows, instRows] = await Promise.all([
    db
      .select()
      .from(agents)
      .where(eq(agents.userId, userId))
      .orderBy(asc(agents.createdAt), asc(agents.id)),
    db
      .select()
      .from(agents)
      .where(isNull(agents.userId))
      .orderBy(asc(agents.createdAt), asc(agents.id)),
  ]);
  const byName = new Map<string, AgentRow>();
  for (const r of instRows) if (!byName.has(r.name)) byName.set(r.name, r);
  for (const r of ownRows) byName.set(r.name, r); // user shadows instance
  return [...byName.values()];
}

/** One agent by name for one user (user row wins). Null if unknown. */
export async function resolveAgentByName(
  userId: string,
  name: string,
): Promise<AgentRow | null> {
  const [own] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.name, name)))
    .limit(1);
  if (own) return own;
  const [inst] = await db
    .select()
    .from(agents)
    .where(and(isNull(agents.userId), eq(agents.name, name)))
    .limit(1);
  return inst ?? null;
}

/** Enabled subagents for the task tool's live catalog. */
export async function resolveSubagentsForUser(
  userId: string,
): Promise<AgentRow[]> {
  const all = await resolveAgentsForUser(userId);
  return all.filter((a) => a.enabled && a.mode === "subagent");
}

/** The primary agent for a user's conversations — 'nemo' unless a user
 *  row shadows it. Falls back to null when the seed is missing (boot
 *  incomplete); callers must degrade to the pre-v2 prompt path. */
export async function resolvePrimaryAgent(
  userId: string,
): Promise<AgentRow | null> {
  const row = await resolveAgentByName(userId, "nemo");
  return row?.enabled ? row : null;
}

/** OpenAI tool definition for `task`, with the live subagent catalog in
 *  the description (progressive disclosure — kept short: name + one-line
 *  description each). Returns null when the user has no enabled
 *  subagents (no point exposing a tool that can only fail). */
export async function buildTaskToolDef(
  userId: string,
): Promise<unknown | null> {
  const subs = await resolveSubagentsForUser(userId);
  if (subs.length === 0) return null;
  const catalog = subs
    .map((a) => `- ${a.name}: ${a.description}`)
    .join("\n");
  return {
    type: "function" as const,
    function: {
      name: "task",
      description:
        "Delegate a self-contained job to a specialized subagent. " +
        "MANDATORY usage rules: research spanning MORE THAN ONE source " +
        "(memory+files, memory+web, several connected sources) MUST go " +
        "to 'explore' — do not chain direct lookups yourself. Any " +
        "deliverable that is a document (report, article, synthesis) " +
        "MUST go to 'writer'. The subagent runs in its own " +
        "sub-conversation with its own tools and reports back; the user " +
        "watches it live. Write the prompt SELF-CONTAINED — the " +
        "subagent sees nothing of this conversation. Available " +
        "subagents:\n" +
        catalog,
      parameters: {
        type: "object",
        properties: {
          subagent: {
            type: "string",
            description: "Name of the subagent (from the list above).",
          },
          prompt: {
            type: "string",
            description:
              "Full task instructions, self-contained (facts, paths, constraints).",
          },
          description: {
            type: "string",
            description: "Short human-readable label for the task card (≤80 chars).",
          },
        },
        required: ["subagent", "prompt", "description"],
      },
    },
  };
}

export { NARRATION_CONTRACT };

/**
 * User persona — 5 reserved memory_articles under the `profile/` namespace.
 *
 * The memory wiki normally compiles itself from conversations (the Python
 * `thecompai-memory` service runs an LLM to keep articles fresh). The
 * `profile/*` articles are different: they're authored manually by the user
 * (here, in the app, or via Obsidian later). The compiler honours
 * `edited_by_user=true` so it never overwrites them.
 *
 * Reserved slugs:
 *   profile/identity        — who I am
 *   profile/preferences     — how I want to be talked to
 *   profile/expertise       — what I already know, my level
 *   profile/working-style   — methods, tools, rituals
 *   profile/writing-guide   — pro writing rules to follow
 *
 * On first access we lazy-create empty templates so the UI has 5 cards
 * to show. Saving any card sets `edited_by_user=true` and recomputes the
 * sha256 body hash (matches the Python compiler's hashing).
 *
 * Endpoints (gated requireUser):
 *   GET    /api/profile                  → list the 5 persona articles
 *   PUT    /api/profile/:slug            → upsert one article
 *   POST   /api/profile/import           → bulk-import via Haiku from a
 *                                          free-form textarea (Phase 3)
 */

import { zValidator } from "@hono/zod-validator";
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index";
import { memoryArticles, users } from "../db/schema";
import { authHeaders } from "../lib/litellm";

type Env = { Variables: { userId: string } };
const profileRoute = new Hono<Env>();

export const PERSONA_SLUGS = [
  "identity",
  "preferences",
  "expertise",
  "working-style",
  "writing-guide",
] as const;
type PersonaSlug = (typeof PERSONA_SLUGS)[number];

const SLUG_DEFAULTS: Record<
  PersonaSlug,
  { title: string; placeholder: string }
> = {
  identity: {
    title: "Identity",
    placeholder:
      "# Identity\n\n_Who you are. Name, role, where you live, current projects, anything that helps the model address you correctly._\n\n- Name:\n- Role:\n- Based in:\n- Current projects:\n",
  },
  preferences: {
    title: "Preferences",
    placeholder:
      "# Preferences\n\n_How you want to be talked to. Language, tone, level of detail, things to avoid._\n\n- Language:\n- Tone:\n- Detail level:\n- Avoid:\n",
  },
  expertise: {
    title: "Expertise",
    placeholder:
      "# Expertise\n\n_What you already know. Skip the basics. Domains, tools, frameworks._\n\n- Strong in:\n- Comfortable with:\n- Learning:\n- Not interested in:\n",
  },
  "working-style": {
    title: "Working style",
    placeholder:
      "# Working style\n\n_Methods, rituals, tools you live in. How you make decisions._\n\n- Methods:\n- Tools:\n- Decision-making:\n- Pace:\n",
  },
  "writing-guide": {
    title: "Writing guide",
    placeholder:
      "# Writing guide\n\n_Rules for written output you receive — pro environment, audience, formatting, voice._\n\n- Audience:\n- Voice:\n- Formatting:\n- Banned phrases / clichés:\n",
  },
};

function slugPath(slug: PersonaSlug): string {
  return `profile/${slug}.md`;
}

function isPersonaSlug(s: string): s is PersonaSlug {
  return (PERSONA_SLUGS as readonly string[]).includes(s);
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function firstLineSummary(body: string, fallback: string): string {
  const stripped = body
    .replace(/^#+\s.*$/gm, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return stripped[0]?.slice(0, 200) ?? fallback;
}

/** Ensure all 5 reserved persona articles exist for this user (empty
 *  templates if missing). Returns the rows in slug order. */
async function ensurePersonaArticles(userId: string) {
  const paths = PERSONA_SLUGS.map(slugPath);
  const existing = await db
    .select()
    .from(memoryArticles)
    .where(
      and(
        eq(memoryArticles.userId, userId),
        inArray(memoryArticles.path, paths),
        isNull(memoryArticles.projectId), // user-scope, not project-scope
      ),
    );
  const byPath = new Map(existing.map((r) => [r.path, r]));
  const missingInserts: typeof memoryArticles.$inferInsert[] = [];
  for (const slug of PERSONA_SLUGS) {
    const p = slugPath(slug);
    if (!byPath.has(p)) {
      const def = SLUG_DEFAULTS[slug];
      missingInserts.push({
        userId,
        path: p,
        title: def.title,
        summary: `Empty — fill in via Settings → Profile or Obsidian.`,
        body: def.placeholder,
        hash: sha256Hex(def.placeholder),
        editedByUser: false, // template; flips to true on first user save
      });
    }
  }
  if (missingInserts.length > 0) {
    await db.insert(memoryArticles).values(missingInserts);
  }
  // Re-read so the response includes both pre-existing and newly-created.
  return db
    .select()
    .from(memoryArticles)
    .where(
      and(
        eq(memoryArticles.userId, userId),
        inArray(memoryArticles.path, paths),
        isNull(memoryArticles.projectId),
      ),
    );
}

profileRoute.get("/", async (c) => {
  const userId = c.get("userId");
  const rows = await ensurePersonaArticles(userId);
  // Order rows to match PERSONA_SLUGS order; UI relies on stable ordering.
  const indexed = new Map(rows.map((r) => [r.path, r]));
  const persona = PERSONA_SLUGS.map((slug) => {
    const r = indexed.get(slugPath(slug));
    if (!r) {
      // Shouldn't happen — ensurePersonaArticles seeds missing rows.
      const def = SLUG_DEFAULTS[slug];
      return {
        slug,
        title: def.title,
        body: def.placeholder,
        editedByUser: false,
        updatedAt: null as string | null,
      };
    }
    return {
      slug,
      title: r.title,
      body: r.body,
      editedByUser: r.editedByUser,
      updatedAt: r.updatedAt.toISOString(),
    };
  });
  return c.json({ persona });
});

const putBodySchema = z.object({
  body: z.string().min(0).max(64000),
  /** Optional override for the article title (defaults to the SLUG_DEFAULTS). */
  title: z.string().min(1).max(200).optional(),
});

profileRoute.put("/:slug", zValidator("json", putBodySchema), async (c) => {
  const userId = c.get("userId");
  const slugParam = c.req.param("slug");
  if (!isPersonaSlug(slugParam)) {
    return c.json({ error: "unknown_slug" }, 400);
  }
  const slug: PersonaSlug = slugParam;
  const { body, title } = c.req.valid("json");
  const def = SLUG_DEFAULTS[slug];
  const finalTitle = title ?? def.title;
  const path = slugPath(slug);

  await ensurePersonaArticles(userId); // makes sure the row exists

  const summary = firstLineSummary(body, def.title);
  const hash = sha256Hex(body);
  const updated = await db
    .update(memoryArticles)
    .set({
      title: finalTitle,
      summary,
      body,
      hash,
      editedByUser: true,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(memoryArticles.userId, userId),
        eq(memoryArticles.path, path),
        isNull(memoryArticles.projectId),
      ),
    )
    .returning();

  if (updated.length === 0) {
    return c.json({ error: "update_failed" }, 500);
  }
  const r = updated[0];
  return c.json({
    persona: {
      slug,
      title: r.title,
      body: r.body,
      editedByUser: r.editedByUser,
      updatedAt: r.updatedAt.toISOString(),
    },
  });
});

// POST /api/profile/import — bulk-import persona via Haiku (or whatever fast
// model the user has). Body: { text: string } — anything the user pasted
// from another LLM (ChatGPT memory dump, Claude.ai instructions, a personal
// "about me" doc, etc.). We send it to a small extraction model with a strict
// JSON schema and write the 5 slugs that come back. We never modify slugs
// the model doesn't return (so a partial paste just fills what's available).
const importBodySchema = z.object({
  text: z.string().min(20).max(50_000),
  model: z.string().min(1).max(120).optional(),
  /** When true, return the proposed articles without saving — lets the UI
   *  show a diff/preview before commit. */
  dryRun: z.boolean().optional(),
});

const EXTRACTION_PROMPT = `You read a free-form text the user pasted from another LLM (ChatGPT memory dump, Claude project instructions, a personal bio, a CV, anything).

Your job: extract structured persona facts and return JSON with up to five string fields, each containing a clean Markdown article body. Skip a field entirely (omit it from the JSON) when the input has no relevant material — do NOT invent.

Required JSON shape:
{
  "identity":       "<markdown body or omit>",
  "preferences":    "<markdown body or omit>",
  "expertise":      "<markdown body or omit>",
  "working-style":  "<markdown body or omit>",
  "writing-guide":  "<markdown body or omit>"
}

Field meanings:
- identity:        who the user is (name, role, location, current projects). Concrete facts only.
- preferences:     how they want to be talked to (language, tone, level of detail, things to avoid).
- expertise:       what they already know — domains, tools, frameworks, level. Skip the basics.
- working-style:   methods, rituals, decision-making, pace, tools they live in.
- writing-guide:   rules for how output should be written (audience, voice, formatting, banned phrases).

Each body must:
- Start with a level-2 heading like \`## Identity\`
- Use bullet lists, no narrative paragraphs
- Stay grounded — only what the input actually says
- Be in the same language as the input

Return ONLY the JSON, no preamble, no code fences.`;

profileRoute.post(
  "/import",
  zValidator("json", importBodySchema),
  async (c) => {
    const userId = c.get("userId");
    const { text, model, dryRun } = c.req.valid("json");

    const [u] = await db
      .select({
        litellmUrl: users.litellmUrl,
        litellmApiKey: users.litellmApiKey,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!u) return c.json({ error: "user_not_found" }, 404);

    const target = {
      baseUrl: (
        u.litellmUrl ?? process.env.LITELLM_URL ?? "http://192.168.86.44:4000"
      ).replace(/\/+$/, ""),
      apiKey: u.litellmApiKey ?? process.env.LITELLM_API_KEY ?? null,
    };

    const upstreamBody = {
      model: model ?? "claude-haiku",
      stream: false,
      max_tokens: 4096,
      temperature: 0.2,
      messages: [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: text },
      ],
    };

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(`${target.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(target),
        },
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      return c.json(
        { error: "llm_unreachable", detail: (err as Error).message },
        502,
      );
    }
    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text().catch(() => "");
      return c.json(
        {
          error: "llm_error",
          status: upstreamRes.status,
          detail: errText.slice(0, 500),
        },
        502,
      );
    }

    const data = (await upstreamRes.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>;
    } | null;
    const raw = data?.choices?.[0]?.message?.content?.trim() ?? "";
    if (!raw) {
      return c.json({ error: "empty_completion" }, 502);
    }

    // The model is asked for raw JSON, but defensive: strip code fences.
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      return c.json(
        {
          error: "bad_json",
          detail:
            "The model didn't return valid JSON. Try again or paste cleaner input.",
          raw: stripped.slice(0, 800),
        },
        502,
      );
    }
    if (!parsed || typeof parsed !== "object") {
      return c.json({ error: "bad_shape" }, 502);
    }

    const proposed: Partial<Record<PersonaSlug, string>> = {};
    for (const slug of PERSONA_SLUGS) {
      const v = (parsed as Record<string, unknown>)[slug];
      if (typeof v === "string" && v.trim().length > 0) {
        proposed[slug] = v.trim();
      }
    }

    if (Object.keys(proposed).length === 0) {
      return c.json({
        ok: true,
        written: [] as string[],
        proposed,
        note: "The model didn't extract any persona fields from this input.",
      });
    }

    if (dryRun) {
      return c.json({ ok: true, dryRun: true, proposed, written: [] });
    }

    // Persist each proposed body, flipping edited_by_user=true.
    await ensurePersonaArticles(userId);
    const written: string[] = [];
    for (const [slug, body] of Object.entries(proposed) as [
      PersonaSlug,
      string,
    ][]) {
      const def = SLUG_DEFAULTS[slug];
      await db
        .update(memoryArticles)
        .set({
          title: def.title,
          summary: firstLineSummary(body, def.title),
          body,
          hash: sha256Hex(body),
          editedByUser: true,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(memoryArticles.userId, userId),
            eq(memoryArticles.path, slugPath(slug)),
            isNull(memoryArticles.projectId),
          ),
        );
      written.push(slug);
    }

    return c.json({ ok: true, written, proposed });
  },
);

export default profileRoute;

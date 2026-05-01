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
import { memoryArticles } from "../db/schema";

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

export default profileRoute;

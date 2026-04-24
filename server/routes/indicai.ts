import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index";
import { addons, conversations, messages, projects } from "../db/schema";

const indicaiRoute = new Hono();

type Level = { n: number; label: string; minScore: number };

const LEVELS: Level[] = [
  { n: 1, label: "Novice", minScore: 0 },
  { n: 2, label: "Apprentice", minScore: 20 },
  { n: 3, label: "Practitioner", minScore: 60 },
  { n: 4, label: "Advanced", minScore: 150 },
  { n: 5, label: "Expert", minScore: 400 },
];

indicaiRoute.get("/", async (c) => {
  const userId = c.get("userId");

  const [convCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(eq(conversations.userId, userId));
  const conversationsCount = convCountRow?.count ?? 0;

  const [msgCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(and(eq(conversations.userId, userId), eq(messages.role, "user")));
  const userMessagesCount = msgCountRow?.count ?? 0;

  const modelsRows = await db
    .selectDistinct({ model: conversations.model })
    .from(conversations)
    .where(
      and(eq(conversations.userId, userId), isNotNull(conversations.model)),
    );
  const distinctModels = modelsRows.filter((r) => r.model).length;

  const [projCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projects)
    .where(eq(projects.userId, userId));
  const projectsCount = projCountRow?.count ?? 0;

  const [addonCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.enabled, true)));
  const activeAddons = addonCountRow?.count ?? 0;

  const [withPromptRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projects)
    .where(
      and(eq(projects.userId, userId), isNotNull(projects.systemPrompt)),
    );
  const projectsWithPrompt = withPromptRow?.count ?? 0;

  // Heuristic score: rewards breadth + richness more than raw message count.
  const score =
    userMessagesCount * 1 +
    conversationsCount * 3 +
    distinctModels * 15 +
    projectsCount * 10 +
    projectsWithPrompt * 10 +
    activeAddons * 12;

  const level = LEVELS.reduce((acc, lv) =>
    score >= lv.minScore ? lv : acc,
  );
  const next = LEVELS[level.n] ?? null;
  const progress = next
    ? Math.min(
        1,
        Math.max(
          0,
          (score - level.minScore) / (next.minScore - level.minScore),
        ),
      )
    : 1;

  return c.json({
    level: level.n,
    label: level.label,
    score,
    next: next
      ? { label: next.label, at: next.minScore }
      : null,
    progress,
    metrics: {
      conversations: conversationsCount,
      userMessages: userMessagesCount,
      distinctModels,
      projects: projectsCount,
      projectsWithPrompt,
      activeAddons,
    },
  });
});

export default indicaiRoute;

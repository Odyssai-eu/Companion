import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash"),
  // Inference settings — LiteLLM proxy is the single inference layer.
  // Falls back to env LITELLM_URL when null.
  defaultModel: text("default_model"),
  litellmUrl: text("litellm_url"),
  litellmApiKey: text("litellm_api_key"),
  // Temporal awareness — fed into every inference as a context tag.
  timezone: text("timezone").notNull().default("Europe/Brussels"),
  lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: text("category").notNull().default("general"),
    icon: text("icon"),
    systemPrompt: text("system_prompt"),
    instructions: text("instructions"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userUpdatedIdx: index("projects_user_updated_idx").on(
      t.userId,
      t.updatedAt,
    ),
  }),
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull().default("New conversation"),
    model: text("model"),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userUpdatedIdx: index("conversations_user_updated_idx").on(
      t.userId,
      t.updatedAt,
    ),
    projectIdx: index("conversations_project_idx").on(t.projectId),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    content: text("content").notNull().default(""),
    reasoning: text("reasoning"),
    stats: jsonb("stats").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    conversationIdx: index("messages_conversation_idx").on(
      t.conversationId,
      t.createdAt,
    ),
  }),
);

export type User = typeof users.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export const addons = pgTable(
  "addons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["core", "plugin", "mcp"] })
      .notNull()
      .default("plugin"),
    description: text("description"),
    version: text("version"),
    enabled: boolean("enabled").notNull().default(false),
    config: jsonb("config").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userKindIdx: index("addons_user_kind_idx").on(t.userId, t.kind),
  }),
);

export type Addon = typeof addons.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

// ── Memory (LLM wiki) ─────────────────────────────────────────────────
// Compiled by the thecompai-memory Python service. The backend reads
// memory_articles to inject "what I remember about you" into the system
// prompt, and writes only via the lock endpoint when a user edits an article.

export const memoryArticles = pgTable(
  "memory_articles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    path: text("path").notNull(), // e.g. "profile/identity.md"
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    body: text("body").notNull(),
    hash: text("hash").notNull(),
    editedByUser: boolean("edited_by_user").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    // One article per (user, project, path). project_id NULL = global scope.
    uniqUserProjectPath: uniqueIndex("memory_articles_user_project_path_idx").on(
      t.userId,
      t.projectId,
      t.path,
    ),
    userUpdatedIdx: index("memory_articles_user_updated_idx").on(
      t.userId,
      t.updatedAt,
    ),
  }),
);

export const memoryCompileState = pgTable(
  "memory_compile_state",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    lastCompiledAt: timestamp("last_compiled_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: uniqueIndex("memory_compile_state_pk").on(t.userId, t.conversationId),
  }),
);

export type MemoryArticle = typeof memoryArticles.$inferSelect;
export type NewMemoryArticle = typeof memoryArticles.$inferInsert;

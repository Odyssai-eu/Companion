import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
  // Admin Extended — RBAC. Values: 'admin' | 'organiser' | 'user' | 'guest'.
  role: text("role").notNull().default("user"),
  active: boolean("active").notNull().default(true),
  // Inference mode: 'easy' | 'advanced' | 'expert' (see migration 0015).
  inferenceMode: text("inference_mode").notNull().default("expert"),
  // Easy mode: a single LiteLLM alias the admin curates. UI hides picker.
  easyModel: text("easy_model"),
  // Advanced mode: 4 named slots → LiteLLM aliases.
  // Shape: { conversation: string, analyse: string, engineer: string, expert: string }
  namedModels: jsonb("named_models").$type<{
    conversation?: string;
    analyse?: string;
    engineer?: string;
    expert?: string;
  }>(),
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
    // Default for new conversations created under this project. The
    // conversation can override it. When false, no memory wiki is read,
    // injected, or written for any conversation in this project.
    memoryEnabled: boolean("memory_enabled").notNull().default(true),
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
    // 'chat' = classic text/multimodal chat (default).
    // 'talk' = Voice Live conversation (no model picker, big-mic input,
    // transcripts persisted as messages).
    kind: text("kind", { enum: ["chat", "talk"] })
      .notNull()
      .default("chat"),
    model: text("model"),
    pinned: boolean("pinned").notNull().default(false),
    // Memory wiki snapshot — frozen at creation (or on explicit "Remember
    // now") and reused as-is on every chat turn. Keeps the system-prompt
    // prefix byte-stable across turns so EXO's KV prefix cache hits, and
    // prevents context drift when the memory service recompiles in the
    // background.
    memorySnapshot: text("memory_snapshot"),
    memorySnapshotAt: timestamp("memory_snapshot_at", { withTimezone: true }),
    // Per-conversation memory toggle. Inherited from project.memoryEnabled
    // at creation; user can flip it from the chat header. When false, the
    // wiki is not injected into the prompt and "Remember now" is disabled.
    memoryEnabled: boolean("memory_enabled").notNull().default(true),
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

// ── Admin Extended ───────────────────────────────────────────────────
// Multi-tenant orchestrator for remote nodes (rsync model distribution),
// guest tokens with budget caps, and an append-only auth log.

export const nodes = pgTable(
  "nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Hostname (e.g. "studio-01.lan") or IPv4.
    ip: text("ip").notNull(),
    sshUser: text("ssh_user").notNull().default("admin"),
    // Encrypted (libsodium). Cleared once sshKeySetup = true.
    sshPassword: text("ssh_password"),
    sshKeySetup: boolean("ssh_key_setup").notNull().default(false),
    // e.g. '~/mlx-models' or '~/.exo/models'
    modelPath: text("model_path").notNull(),
    status: text("status").notNull().default("unknown"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userIdx: index("nodes_user_idx").on(t.userId),
  }),
);

export const nodeGroups = pgTable(
  "node_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userNameUniq: uniqueIndex("node_groups_user_name_idx").on(t.userId, t.name),
  }),
);

export const nodeGroupMembers = pgTable(
  "node_group_members",
  {
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => nodeGroups.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.nodeId, t.groupId] }),
  }),
);

export const syncJobs = pgTable(
  "sync_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceNodeId: uuid("source_node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    targetNodeIds: uuid("target_node_ids").array().notNull(),
    groupId: uuid("group_id").references(() => nodeGroups.id, {
      onDelete: "set null",
    }),
    // e.g. 'mlx-community/gemma-4-26b-a4b-it-bf16'
    modelPath: text("model_path").notNull(),
    status: text("status").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    // Last 4KB of stdout/stderr.
    log: text("log"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userCreatedIdx: index("sync_jobs_user_created_idx").on(
      t.userId,
      t.createdAt.desc(),
    ),
    statusIdx: index("sync_jobs_status_idx").on(t.status),
  }),
);

export const guestTokens = pgTable(
  "guest_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // sha256 of the raw token. The token is shown once at creation.
    tokenHash: text("token_hash").notNull().unique(),
    label: text("label"),
    // Max LLM tokens this guest can consume. 0 = unlimited.
    tokenBudget: integer("token_budget").notNull(),
    tokensUsed: integer("tokens_used").notNull().default(0),
    // Future: 'chat' | 'chat+memory' | etc.
    scope: text("scope").notNull().default("chat"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    tokenHashIdx: index("guest_tokens_token_hash_idx").on(t.tokenHash),
    createdByCreatedIdx: index("guest_tokens_created_by_created_idx").on(
      t.createdBy,
      t.createdAt.desc(),
    ),
  }),
);

export const authLog = pgTable(
  "auth_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable so we can log failed-login attempts where no user resolved.
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // 'login.success' | 'login.fail' | 'logout' | 'password.change'
    // | 'role.change' | 'guest.mint' | 'guest.use'
    event: text("event").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    createdIdx: index("auth_log_created_idx").on(t.createdAt.desc()),
    userCreatedIdx: index("auth_log_user_created_idx").on(
      t.userId,
      t.createdAt.desc(),
    ),
  }),
);

export type Node = typeof nodes.$inferSelect;
export type NewNode = typeof nodes.$inferInsert;
export type NodeGroup = typeof nodeGroups.$inferSelect;
export type SyncJob = typeof syncJobs.$inferSelect;
export type NewSyncJob = typeof syncJobs.$inferInsert;
export type GuestToken = typeof guestTokens.$inferSelect;
export type NewGuestToken = typeof guestTokens.$inferInsert;
export type AuthLog = typeof authLog.$inferSelect;
export type NewAuthLog = typeof authLog.$inferInsert;


// ── Workspace files ────────────────────────────────────────────────────────
// Per-user virtual filesystem exposed to the LLM via the fs_* tools.
// v1: text content stored directly in Postgres. Binary blobs and FS-backed
// storage will land in v2 (see docs/migration/13-roadmap-and-gaps.md).

export const workspaceFiles = pgTable(
  "workspace_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    mimeType: text("mime_type").notNull().default("text/plain"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userPathUniq: uniqueIndex("workspace_files_user_path_unique").on(
      t.userId,
      t.path,
    ),
    userUpdatedIdx: index("workspace_files_user_idx").on(
      t.userId,
      t.updatedAt,
    ),
  }),
);

export type WorkspaceFileRow = typeof workspaceFiles.$inferSelect;
export type NewWorkspaceFileRow = typeof workspaceFiles.$inferInsert;

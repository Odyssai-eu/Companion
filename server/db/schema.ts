import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
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
  // Odyssai capability contract — direct address of an engine that
  // implements `GET /.well-known/inference-engine.json` and per-model
  // `x_odyssai` capabilities. Distinct from litellm_url which routes
  // inference. The engine URL is polled to enrich the model list with
  // accurate caps (loaded?, context_length, supports_tools, …) instead
  // of relying on heuristics on model ids.
  engineUrl: text("engine_url"),
  engineToken: text("engine_token"),
  engineMeta: jsonb("engine_meta").$type<Record<string, unknown>>(),
  // Provider mode — drives how Companion routes chat + lists models.
  //   'gateway' → 100% via engine_url (Odysseus proxies cloud + local)
  //   'hybrid'  → inference via litellm_url, caps via engine_url
  //   'legacy'  → LiteLLM only (no Odysseus paired)
  // Auto-set by the pair flow based on engine features.cloud-passthrough.
  engineMode: text("engine_mode").notNull().default("legacy"),
  // Master switch to turn LiteLLM off entirely. When true, models listing
  // and chat routing both refuse to use litellm_url even if set. Used by
  // pure-gateway setups that want to drop LiteLLM from the chain.
  litellmDisabled: boolean("litellm_disabled").notNull().default(false),
  // Per-user toggle for the per-message metrics box (TTFT, tok/s, …).
  // Off by default — the bar feels like clutter once you've stopped
  // tuning latency. Power users flip it on in Settings.
  showMetrics: boolean("show_metrics").notNull().default(false),
  // Per-user toggle for verbose debug logging. When true, chat.ts logs
  // the upstream request body (with `[chat:upstream]` prefix) before
  // every `/v1/chat/completions` POST. Useful for diagnosing tool calling
  // shape issues, model id resolution, etc. Off by default — produces
  // a lot of stdout. Server-only sink (console.log → docker logs).
  debugVerbose: boolean("debug_verbose").notNull().default(false),
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
  // Model picker hide list — per-user curation of which model ids
  // appear in the chat picker. Set populated via Settings → Inference
  // (advanced) or via the eye-toggle in the picker itself. In `easy`
  // mode, hidden ids are filtered out; in `advanced`/`expert` mode,
  // they appear grayed out so the user can un-hide them in context.
  // Default null = "show everything" (no hide list yet).
  hiddenModels: jsonb("hidden_models").$type<string[]>(),
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
    // Master switch — when false, NO memory is injected for this project.
    memoryEnabled: boolean("memory_enabled").notNull().default(true),
    // When true, the project's own corpus (project_memory_files) is
    // injected into the system prompt. Independent from the global user
    // wiki — turning this on does NOT include global. Turning both on
    // composes (project corpus + read-only global).
    dedicatedMemoryEnabled: boolean("dedicated_memory_enabled")
      .notNull()
      .default(false),
    // When true, the global user wiki is included but conversations in
    // this project do NOT trigger updates to it (triggerCompile is
    // suppressed). Use for projects that should benefit from prior
    // wisdom without polluting it.
    globalMemoryReadOnly: boolean("global_memory_read_only")
      .notNull()
      .default(false),
    // Absolute filesystem path on the gateway host that the chat route
    // reads LIVE every turn. Different shape from project_memory_files
    // (which holds DB-copied content): the external vault stays in
    // sync with the disk on its own. Useful when the user keeps an
    // Obsidian vault locally and wants TheCompAI to see edits
    // immediately. Null = no external mount.
    //
    // Also accepts the shape `tcai://project/<uuid>` to point at another
    // project's internal corpus. This is the shared-memory mechanism —
    // user copies the share path from project A and pastes it into
    // project B's linked field. Reads only (forced RO server-side).
    externalVaultPath: text("external_vault_path"),
    // Read-only flag for external_vault_path. Default true — writing to
    // a filesystem vault is opt-in. When the path is a tcai:// link,
    // this is treated as true regardless of the stored value.
    externalVaultReadOnly: boolean("external_vault_read_only")
      .notNull()
      .default(true),
    // Consent flag: must be true for this project to be linkable via
    // tcai://project/<uuid> from another project. Default false —
    // sharing is explicit. The Share path field in the UI is hidden
    // (or greyed out) until this is on.
    sharingEnabled: boolean("sharing_enabled").notNull().default(false),
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

/**
 * Per-project memory corpus. Files imported via vault upload land here
 * and get injected (raw, concatenated, size-capped) into the system
 * prompt when projects.dedicatedMemoryEnabled is true. Phase 2 will
 * replace the raw-concat path with RAG indexing.
 */
export const projectMemoryFiles = pgTable(
  "project_memory_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Destination path inside the project vault (e.g. "concepts/foo.md"). */
    path: text("path").notNull(),
    mimeType: text("mime_type").notNull().default("text/markdown"),
    sizeBytes: integer("size_bytes").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    projectIdx: index("project_memory_files_project_idx").on(t.projectId),
  }),
);

export type ProjectMemoryFile = typeof projectMemoryFiles.$inferSelect;

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
    // 'hermes' = direct conversation with the Hermes Agent gateway,
    // bypassing LiteLLM (Hermes handles its own tool routing natively).
    kind: text("kind", { enum: ["chat", "talk", "hermes"] })
      .notNull()
      .default("chat"),
    // Optional repo binding (kind='hermes' only). Free-text path on the
    // gateway host. When set, the chat route prepends a "working
    // directory" preamble to the system prompt so Hermes operates inside
    // the bound repo (git ops, edits, builds, tests).
    repoPath: text("repo_path"),
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
    // Per-conversation "agent mode". When false (default), NO tool defs are
    // injected — `tools` is omitted from the upstream body entirely. This
    // gives a clean ~250-token prompt instead of 1000+ tokens of always-on
    // FS/RAG/Web schemas, and lets the engine stream normally (no
    // `shouldUseNonStream` forcing on jaccl). User flips this on per-conv
    // when they actually want agentic capability (file ops, web fetch,
    // RAG search, MCP servers). Default OFF so the typical case (a chat
    // with a model) gets streaming + minimal prompt out of the box.
    agentMode: boolean("agent_mode").notNull().default(false),
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

// Inference presets — named bundles of LLM sampling params the user
// can save and reload. System prompt lives elsewhere (project / chat).
// Each preset can optionally bind to a model id; applying it then
// switches the picker too.
export const inferencePresets = pgTable(
  "inference_presets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    modelId: text("model_id"),
    temperature: doublePrecision("temperature"),
    topP: doublePrecision("top_p"),
    topK: integer("top_k"),
    minP: doublePrecision("min_p"),
    repetitionPenalty: doublePrecision("repetition_penalty"),
    maxTokens: integer("max_tokens"),
    // seed can be very large; bigint covers any 64-bit value. Stored as
    // string in TS to dodge JS number precision loss on huge seeds.
    seed: bigint("seed", { mode: "number" }),
    // Reasoning controls — captured by the preset alongside the
    // sampling block so loading a preset restores the full thinking
    // configuration (not just temperature etc.).
    thinking: boolean("thinking"),
    reasoningEffort: text("reasoning_effort"),
    hfReferenceUrl: text("hf_reference_url"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userIdx: index("inference_presets_user_id_idx").on(t.userId),
  }),
);

export type InferencePresetRow = typeof inferencePresets.$inferSelect;
export type NewInferencePresetRow = typeof inferencePresets.$inferInsert;

// External MCP servers — Companion is the client. Each row points at
// an MCP-compatible HTTP endpoint the user wants Companion to expose
// as tools to the LLM. The slug namespaces the tool names so a Notion
// `search` doesn't collide with a Qdrant `search`.
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Lowercased ascii, unique per user. Used to prefix tool names
     *  (`mcp_<slug>_<tool>`) so they don't collide with built-in tools
     *  or with each other. */
    slug: text("slug").notNull(),
    /** 'streamable_http' (modern) | 'sse' (legacy). stdio deliberately
     *  unsupported — child-process spawning inside Docker is painful
     *  and every hosted MCP server exposes an HTTP variant. */
    transport: text("transport").notNull(),
    url: text("url").notNull(),
    /** 'bearer' (static authHeader) | 'oauth' (OAuth fields) | 'none'. */
    authKind: text("auth_kind").notNull().default("bearer"),
    /** Full header value verbatim, e.g. "Bearer sk_test_…". Used when
     *  authKind = 'bearer'. */
    authHeader: text("auth_header"),
    /** Cached `.well-known/oauth-authorization-server` document. */
    oauthMetadata: jsonb("oauth_metadata").$type<{
      issuer?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
      registration_endpoint?: string;
      revocation_endpoint?: string;
      scopes_supported?: string[];
      code_challenge_methods_supported?: string[];
      [k: string]: unknown;
    }>(),
    oauthClientId: text("oauth_client_id"),
    oauthClientSecret: text("oauth_client_secret"),
    oauthAccessToken: text("oauth_access_token"),
    oauthRefreshToken: text("oauth_refresh_token"),
    oauthExpiresAt: timestamp("oauth_expires_at", { withTimezone: true }),
    oauthScopes: text("oauth_scopes").array(),
    enabled: boolean("enabled").notNull().default(true),
    /** Last `tools/list` snapshot. Refreshed lazily (5 min TTL) or on
     *  explicit POST /refresh. Avoids a round-trip per chat turn. */
    toolsCache: jsonb("tools_cache").$type<
      Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      }>
    >(),
    toolsCacheAt: timestamp("tools_cache_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userIdx: index("mcp_servers_user_id_idx").on(t.userId),
    slugUnique: uniqueIndex("mcp_servers_user_slug_unique").on(
      t.userId,
      t.slug,
    ),
  }),
);

export type McpServerRow = typeof mcpServers.$inferSelect;
export type NewMcpServerRow = typeof mcpServers.$inferInsert;

// In-flight OAuth authorization-code → token exchanges. Created at
// /oauth/start, consumed at /oauth/callback. Single-use, 10-min TTL.
// PKCE code_verifier stays server-side (never exposed to the browser).
export const mcpOauthPending = pgTable(
  "mcp_oauth_pending",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    /** Random opaque token returned to the auth server in the `state`
     *  param, echoed back in the callback, used to find this row. */
    state: text("state").notNull().unique(),
    /** PKCE verifier — kept server-side, sent only to the token
     *  endpoint at exchange time. */
    codeVerifier: text("code_verifier").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    scopes: text("scopes").array(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    stateIdx: index("mcp_oauth_pending_state_idx").on(t.state),
    createdAtIdx: index("mcp_oauth_pending_created_at_idx").on(t.createdAt),
  }),
);

export type McpOauthPendingRow = typeof mcpOauthPending.$inferSelect;
export type NewMcpOauthPendingRow = typeof mcpOauthPending.$inferInsert;

// Prompt skills — named system-prompt fragments the user saves and
// reloads from the chat's InferencePanel. Different shape from
// inference_presets (prose, no params) and different lifecycle
// (model-agnostic), so kept separate.
export const promptSkills = pgTable(
  "prompt_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    body: text("body").notNull(),
    /** Free-text categories for filtering — "writing", "code-review", … */
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userIdx: index("prompt_skills_user_id_idx").on(t.userId),
  }),
);

export type PromptSkillRow = typeof promptSkills.$inferSelect;
export type NewPromptSkillRow = typeof promptSkills.$inferInsert;

// Hermes tokens — bearer credentials used by the Hermes Agent and Cowork
// dispatch (via the thecompai-mcp MCP server) to call back into Companion
// on behalf of a user. Scope is per-user (large). Plain token shown once
// at mint, only the sha256 hash is persisted.
export const hermesTokens = pgTable(
  "hermes_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    label: text("label"),
    convId: uuid("conv_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    source: text("source", { enum: ["hermes", "cowork"] })
      .notNull()
      .default("hermes"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    tokenHashIdx: index("hermes_tokens_token_hash_idx").on(t.tokenHash),
    userCreatedIdx: index("hermes_tokens_user_created_idx").on(
      t.userId,
      t.createdAt.desc(),
    ),
  }),
);

export type HermesToken = typeof hermesTokens.$inferSelect;
export type NewHermesToken = typeof hermesTokens.$inferInsert;

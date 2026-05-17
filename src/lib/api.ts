export type OdyssaiModelCapabilities = {
  loaded: boolean;
  loading: boolean;
  pool: string | null;
  backend: string | null;
  nodes: number | null;
  context_length: number | null;
  max_output_tokens: number | null;
  quantization: string | null;
  size_bytes: number | null;
  modalities: string[];
  family: string | null;
  supports_tools: boolean | null;
  supports_vision: boolean | null;
  supports_json_mode: boolean | null;
  supports_streaming: boolean;
  estimated_tps: number | null;
  estimated_load_s: number | null;
  warm: boolean;
  kv_cache_q8: boolean;
  admin_loadable: boolean;
  alias_for?: string;
};

export type ApiGlobalModel = {
  id: string;
  name: string;
  tags: string[];
  capabilities: { vision: boolean; tools: boolean };
  /** Rich per-model contract from an Odyssai-compatible engine. Present
   *  only when the user configured an engine URL AND the engine returned
   *  an `x_odyssai` block for this model id. */
  odyssai?: OdyssaiModelCapabilities;
};

export type ApiInferenceMode = "easy" | "advanced" | "expert";

export type ApiNamedModels = {
  conversation?: string;
  analyse?: string;
  engineer?: string;
  expert?: string;
};

export type ApiInferenceSettings = {
  defaultModel: string | null;
  litellmUrl: string | null;
  timezone: string;
  hasApiKey: boolean;
  envDefaultUrl: string;
  inferenceMode: ApiInferenceMode;
  easyModel: string | null;
  namedModels: ApiNamedModels;
  /** Direct URL to an Odyssai-compatible engine for capability discovery
   *  (distinct from litellmUrl which routes inference). */
  engineUrl: string | null;
  /** True when an engine bearer token is on file (its value is never
   *  returned, only its presence). */
  hasEngineToken: boolean;
  /** Cached `.well-known/inference-engine.json` body from the last
   *  successful probe. Lets the UI render version/features without an
   *  extra round-trip. */
  engineMeta: Record<string, unknown> | null;
  /** Provider mode — auto-derived from features.cloud-passthrough at pair
   *  time. Drives chat routing + model listing. */
  engineMode: "gateway" | "hybrid" | "legacy";
  /** Master switch to turn LiteLLM off. When true, /api/models and
   *  /api/chat refuse to use litellmUrl even if set. */
  litellmDisabled: boolean;
  /** Per-user toggle for the per-assistant-message stats box. Off by
   *  default. Power users flip it on in Settings → Inference. */
  showMetrics: boolean;
  /** Per-user toggle for verbose debug logging on chat.ts (logs upstream
   *  request bodies to docker logs). Off by default. */
  debugVerbose: boolean;
};

export type ApiEngineProbeResult = {
  reachable: boolean;
  isOdyssai: boolean;
  meta?: {
    name?: string;
    vendor?: string;
    version?: string;
    api_compat?: string[];
    auth?: { required: boolean };
    features?: string[];
  };
  authRequired: boolean;
  authProvided: boolean;
  modelsReachable: boolean;
  modelsCount?: number;
  error?: string;
};

export type ApiInferencePreset = {
  id: string;
  userId: string;
  name: string;
  modelId: string | null;
  temperature: number | null;
  topP: number | null;
  topK: number | null;
  minP: number | null;
  repetitionPenalty: number | null;
  maxTokens: number | null;
  seed: number | null;
  thinking: boolean | null;
  reasoningEffort:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | null;
  hfReferenceUrl: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ApiInferencePresetInput = {
  name: string;
  modelId?: string | null;
  temperature?: number | null;
  topP?: number | null;
  topK?: number | null;
  minP?: number | null;
  repetitionPenalty?: number | null;
  maxTokens?: number | null;
  seed?: number | null;
  thinking?: boolean | null;
  reasoningEffort?:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | null;
  hfReferenceUrl?: string | null;
  notes?: string | null;
};

export type ApiMcpServer = {
  id: string;
  name: string;
  slug: string;
  transport: "streamable_http" | "sse";
  url: string;
  authKind: "bearer" | "oauth" | "none";
  hasAuthHeader: boolean;
  oauthConnected: boolean;
  oauthExpiresAt: string | null;
  oauthScopes: string[] | null;
  enabled: boolean;
  toolsCount: number;
  toolsCacheAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ApiMcpServerInput = {
  name: string;
  slug?: string;
  transport: "streamable_http" | "sse";
  url: string;
  authKind?: "bearer" | "oauth" | "none";
  authHeader?: string | null;
  enabled?: boolean;
};

export type ApiMcpToolSpec = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type ApiSkill = {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  body: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type ApiSkillInput = {
  name: string;
  description?: string | null;
  body: string;
  tags?: string[];
};

export type ApiInferenceStatus = {
  lastInteractionAt: string | null;
  serverTime: string;
  timezone: string;
};

export type ApiConversation = {
  id: string;
  userId: string;
  projectId: string | null;
  title: string;
  /** 'chat' (text/multimodal), 'talk' (Voice Live), or 'hermes'
   *  (direct Hermes Agent gateway conversation). */
  kind: "chat" | "talk" | "hermes";
  /** Optional repo binding (Hermes conversations). Path on the gateway host. */
  repoPath: string | null;
  model: string | null;
  pinned: boolean;
  /** Memory wiki injection toggle for this conversation. Inherited from
   *  the parent project at creation; user-flippable from the chat header. */
  memoryEnabled: boolean;
  /** When true, Companion injects the full agentic tool surface (fs_*,
   *  rag_search, web_*, MCP servers) into the upstream chat body. Default
   *  off — keeps the prompt small (~250 tok) and unblocks streaming on
   *  jaccl backends. User flips on per-conv when they want agentic
   *  capability. */
  agentMode?: boolean;
  lastMessage?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ApiProject = {
  id: string;
  userId: string;
  name: string;
  category: string;
  icon: string | null;
  systemPrompt: string | null;
  instructions: string | null;
  /** Master memory switch — when false, NO memory is injected for this
   *  project's conversations regardless of the two flags below. */
  memoryEnabled: boolean;
  /** When true, the project's own corpus (`project_memory_files`) is
   *  injected. Independent from the global user wiki. */
  dedicatedMemoryEnabled: boolean;
  /** When true, the global user wiki is included read-only. Per-turn
   *  triggerCompile is suppressed so this project doesn't write back. */
  globalMemoryReadOnly: boolean;
  /** Absolute path on the gateway host OR a `tcai://project/<uuid>`
   *  link to another project's vault. When set, the chat route reads
   *  this every turn (no copy) and merges with the DB-imported files. */
  externalVaultPath: string | null;
  /** Read-only flag for the linked path. Forced true server-side when
   *  the path is a tcai:// link. */
  externalVaultReadOnly: boolean;
  /** Sharing consent: must be true for other projects (same user) to be
   *  able to link to this one via tcai://project/<id>. Default false. */
  sharingEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ApiProjectMemoryFile = {
  path: string;
  mimeType: string;
  sizeBytes: number;
  updatedAt: string;
};

export type ApiProjectMemoryStats = {
  fileCount: number;
  bytesUsed: number;
  bytesQuota: number;
};

export type ApiAddon = {
  id: string;
  userId: string;
  name: string;
  kind: "core" | "plugin" | "mcp";
  description: string | null;
  version: string | null;
  enabled: boolean;
  config: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type ApiProjectCategory = {
  id: string;
  name: string;
  icon: string;
  systemPrompt: string;
};

export type ApiWorkspaceFile = {
  path: string;
  sizeBytes: number;
  mimeType: string;
  updatedAt: string;
};

export type ApiWorkspaceStats = {
  fileCount: number;
  bytesUsed: number;
  bytesQuota: number;
};

export type ApiMessage = {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning: string | null;
  stats: Record<string, unknown> | null;
  createdAt: string;
};

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = "";
    let code: string | undefined;
    try {
      const body = await res.json();
      // zValidator (Hono) returns errors as
      //   { success: false, error: { issues: [{ path, message }, ...] } }
      // Plain handlers return { error: 'code', detail: 'human reason' }.
      if (body && typeof body.error === "object" && body.error !== null) {
        const issues = (body.error.issues ?? []) as Array<{
          path?: Array<string | number>;
          message?: string;
        }>;
        if (issues.length > 0) {
          detail = issues
            .map((i) => `${(i.path ?? []).join(".") || "?"}: ${i.message ?? "invalid"}`)
            .join("; ");
        } else {
          detail = JSON.stringify(body.error);
        }
        code = "validation_error";
      } else {
        detail = body.detail ?? body.error ?? JSON.stringify(body);
        code = typeof body.error === "string" ? body.error : undefined;
      }
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new ApiError(res.status, `${res.status} ${res.statusText}: ${detail}`, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type AuthRole = "admin" | "organiser" | "user" | "guest";

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  role?: AuthRole;
  active?: boolean;
};

// ── Admin Extended types ────────────────────────────────────────────────

export type ApiAdminUser = {
  id: string;
  email: string;
  name: string | null;
  role: AuthRole;
  active: boolean;
  createdAt: string;
  lastInteractionAt: string | null;
};

export type ApiAdminGroup = {
  id: string;
  name: string;
  createdAt: string;
  nodeCount: number;
};

export type ApiAdminNode = {
  id: string;
  name: string;
  ip: string;
  sshUser: string;
  sshKeySetup: boolean;
  modelPath: string;
  status: string;
  lastSeenAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  groups: Array<{ id: string; name: string }>;
};

export type ApiSyncJob = {
  id: string;
  userId: string;
  sourceNodeId: string;
  targetNodeIds: string[];
  groupId: string | null;
  modelPath: string;
  status: "queued" | "running" | "done" | "failed" | "canceled";
  progress: number;
  log: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  liveProgress?: number;
  liveLog?: string;
  currentTarget?: string | null;
};

export type ApiSyncMatrixEntry = {
  nodeId: string;
  nodeName: string;
  freeBytes: number | null;
  models: Array<{ name: string; sizeBytes: number }>;
};

export type ApiGuestToken = {
  id: string;
  label: string | null;
  tokenBudget: number;
  tokensUsed: number;
  scope: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type SyncStreamEvent =
  | { type: "snapshot"; status: ApiSyncJob["status"]; progress: number; currentTarget: string | null }
  | { type: "progress"; progress: number; currentTarget?: string | null }
  | { type: "log"; line: string }
  | { type: "status"; status: ApiSyncJob["status"]; error?: string }
  | { type: string; [k: string]: unknown };

export const api = {
  // Models — proxied from LiteLLM /v1/models
  listAllModels: () =>
    request<{ models: ApiGlobalModel[] }>("/api/models"),

  // Inference settings (LiteLLM URL, default model, timezone, …)
  inferenceSettings: () =>
    request<ApiInferenceSettings>("/api/inference/settings"),
  updateInferenceSettings: (
    body: Partial<{
      defaultModel: string | null;
      litellmUrl: string | null;
      litellmApiKey: string | null;
      timezone: string;
      inferenceMode: ApiInferenceMode;
      easyModel: string | null;
      namedModels: ApiNamedModels | null;
      engineUrl: string | null;
      engineToken: string | null;
      engineMode: "gateway" | "hybrid" | "legacy";
      litellmDisabled: boolean;
      showMetrics: boolean;
      debugVerbose: boolean;
    }>,
  ) =>
    request<{ ok: true }>("/api/inference/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  inferenceStatus: () =>
    request<ApiInferenceStatus>("/api/inference/status"),
  // ── Inference presets ────────────────────────────────────────────────
  listInferencePresets: () =>
    request<{ presets: ApiInferencePreset[] }>("/api/inference/presets"),
  createInferencePreset: (body: ApiInferencePresetInput) =>
    request<{ preset: ApiInferencePreset }>("/api/inference/presets", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateInferencePreset: (
    id: string,
    body: Partial<ApiInferencePresetInput>,
  ) =>
    request<{ preset: ApiInferencePreset }>(`/api/inference/presets/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteInferencePreset: (id: string) =>
    request<void>(`/api/inference/presets/${id}`, { method: "DELETE" }),

  // Skills — named system-prompt fragments stored server-side
  listSkills: () => request<{ skills: ApiSkill[] }>("/api/skills"),
  createSkill: (body: ApiSkillInput) =>
    request<{ skill: ApiSkill }>("/api/skills", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateSkill: (id: string, body: Partial<ApiSkillInput>) =>
    request<{ skill: ApiSkill }>(`/api/skills/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteSkill: (id: string) =>
    request<void>(`/api/skills/${id}`, { method: "DELETE" }),

  // MCP servers — Companion as a client of remote MCP endpoints
  listMcpServers: () =>
    request<{ servers: ApiMcpServer[] }>("/api/mcp-servers"),
  createMcpServer: (body: ApiMcpServerInput) =>
    request<{ server: ApiMcpServer }>("/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateMcpServer: (
    id: string,
    body: Partial<Omit<ApiMcpServerInput, "slug">>,
  ) =>
    request<{ server: ApiMcpServer }>(`/api/mcp-servers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteMcpServer: (id: string) =>
    request<void>(`/api/mcp-servers/${id}`, { method: "DELETE" }),
  startMcpOauth: (id: string) =>
    request<{ authorizationUrl: string; state: string }>(
      `/api/mcp-servers/${id}/oauth/start`,
      { method: "POST" },
    ),
  disconnectMcpOauth: (id: string) =>
    request<{ ok: true }>(`/api/mcp-servers/${id}/oauth/disconnect`, {
      method: "POST",
    }),

  refreshMcpServer: (id: string) =>
    request<{ ok: true; tools: ApiMcpToolSpec[] }>(
      `/api/mcp-servers/${id}/refresh`,
      { method: "POST" },
    ),
  testMcpServer: (body: ApiMcpServerInput) =>
    request<
      | { ok: true; toolsCount: number; tools: ApiMcpToolSpec[] }
      | { ok: false; error: string }
    >("/api/mcp-servers/test", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  probeInferenceEngine: (body: { url: string; token?: string }) =>
    request<ApiEngineProbeResult>("/api/inference/engine/probe", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // ── Join the Odyssai (Odysseus gateway pairing) ───────────────────────
  // Server-side LAN scan returns the engines reachable from the backend's
  // network. In dev this is rpi-dev's LAN — same as Sophie's home LAN —
  // so it finds Odysseus on .141. Multi-tenant cloud users on other
  // networks need the manual URL fallback (or the future Tauri desktop).
  searchOdyssai: (body?: { subnets?: string[]; timeoutMs?: number }) =>
    request<{
      engines: Array<{
        host: string;
        port: number;
        url: string;
        meta: {
          name?: string;
          vendor?: string;
          version?: string;
          features?: string[];
        };
      }>;
    }>("/api/providers/search-odyssai", {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  joinOdyssai: (body: {
    host: string;
    port: number;
    user_label?: string;
  }) =>
    request<{
      ok: true;
      summary: {
        version?: string;
        modelsCount: number;
        cloudAliasesCount: number;
        gateway: boolean;
        mode: "gateway" | "hybrid";
      };
    }>("/api/providers/join-odyssai", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  disconnectOdyssai: () =>
    request<{ ok: true }>("/api/providers/disconnect", { method: "POST" }),
  reloadOdyssai: () =>
    request<{
      ok: true;
      meta: Record<string, unknown>;
      supportsGateway: boolean;
    }>("/api/providers/reload", { method: "POST" }),

  listConversations: () =>
    request<{ conversations: ApiConversation[] }>("/api/conversations"),
  getConversation: (id: string) =>
    request<{
      conversation: ApiConversation;
      messages: ApiMessage[];
      /** Live in-flight buffer (server-side inference-state Map). When
       *  present and `active === true`, the client should render a
       *  streaming placeholder fed by polling /:id/inference until done. */
      inference?:
        | { active: false; done?: undefined }
        | {
            active: boolean;
            done: boolean;
            content: string;
            reasoning: string;
            error: string | null;
          };
    }>(`/api/conversations/${id}`),
  createConversation: (body: {
    title?: string;
    projectId?: string;
    model?: string;
    kind?: "chat" | "talk" | "hermes";
    repoPath?: string;
  }) =>
    request<{ conversation: ApiConversation }>("/api/conversations", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  renameConversation: (id: string, title: string) =>
    request<{ conversation: ApiConversation }>(`/api/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  pinConversation: (id: string, pinned: boolean) =>
    request<{ conversation: ApiConversation }>(`/api/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ pinned }),
    }),
  setConversationMemoryEnabled: (id: string, memoryEnabled: boolean) =>
    request<{ conversation: ApiConversation }>(`/api/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ memoryEnabled }),
    }),
  setConversationAgentMode: (id: string, agentMode: boolean) =>
    request<{ conversation: ApiConversation }>(`/api/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ agentMode }),
    }),
  setConversationRepoPath: (id: string, repoPath: string | null) =>
    request<{ conversation: ApiConversation }>(`/api/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ repoPath: repoPath ?? null }),
    }),

  /** Live in-flight inference buffer. Returns `{ active: false }` when
   *  there's nothing running. When active, `content` / `reasoning` /
   *  `done` / `error` reflect the server-side state. */
  getInference: (id: string) =>
    request<
      | { active: false; done?: undefined }
      | {
          active: boolean;
          done: boolean;
          content: string;
          reasoning: string;
          error: string | null;
        }
    >(`/api/conversations/${id}/inference`),
  clearInference: (id: string) =>
    request<{ ok: boolean }>(`/api/conversations/${id}/inference/clear`, {
      method: "POST",
    }),
  listActiveInferences: () =>
    request<{ active: string[] }>("/api/conversations/active"),

  // Hermes Bridge (auxiliary git ops over the bound repo) ─────────────
  hermesBridgeHealth: () =>
    request<{ ok: boolean; bin?: string }>("/api/hermes-bridge/health"),
  hermesBridgeGitStatus: (repoPath: string) =>
    request<{
      branch: string;
      upstream: string | null;
      ahead: number;
      behind: number;
      staged: string[];
      modified: string[];
      untracked: string[];
      deleted: string[];
      dirty: boolean;
    }>(
      `/api/hermes-bridge/git/status?repoPath=${encodeURIComponent(repoPath)}`,
    ),
  hermesBridgeGitDiff: (
    repoPath: string,
    opts: { staged?: boolean; path?: string } = {},
  ) => {
    const qs = new URLSearchParams({ repoPath });
    if (opts.staged) qs.set("staged", "true");
    if (opts.path) qs.set("path", opts.path);
    return request<{ diff: string }>(`/api/hermes-bridge/git/diff?${qs.toString()}`);
  },
  moveConversationToProject: (id: string, projectId: string | null) =>
    request<{ conversation: ApiConversation }>(`/api/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ projectId }),
    }),
  deleteConversation: (id: string) =>
    request<void>(`/api/conversations/${id}`, { method: "DELETE" }),
  deleteConversationsBatch: (ids: string[]) =>
    request<{ deleted: string[]; notFound: string[] }>(
      "/api/conversations/delete-many",
      { method: "POST", body: JSON.stringify({ ids }) },
    ),
  appendMessage: (
    conversationId: string,
    body: {
      role: "user" | "assistant" | "system";
      content: string;
      reasoning?: string;
      stats?: Record<string, unknown>;
      /** ISO-8601. Sent so the DB stores the frontend's notion of "when",
       *  matching the value used in the chat request — keeps prefix-cache
       *  bytes stable across page reloads. */
      createdAt?: string;
    },
  ) =>
    request<{ message: ApiMessage }>(
      `/api/conversations/${conversationId}/messages`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  truncateConversationFrom: (conversationId: string, messageId: string) =>
    request<void>(
      `/api/conversations/${conversationId}/messages/from/${messageId}`,
      { method: "DELETE" },
    ),
  refreshConversationMemory: (conversationId: string) =>
    request<{
      ok: boolean;
      memorySnapshot: string;
      memorySnapshotAt: string;
    }>(`/api/conversations/${conversationId}/refresh-memory`, {
      method: "POST",
    }),
  prewarmConversation: (
    conversationId: string,
    body: { model: string; system_prompt?: string },
  ) =>
    request<{ ok: boolean; reason?: string }>(
      `/api/conversations/${conversationId}/prewarm`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  // Persona — 5 reserved profile/*.md memory articles, manually authored
  // by the user; the wiki compiler honours edited_by_user and skips them.
  getPersona: () =>
    request<{
      persona: Array<{
        slug: string;
        title: string;
        body: string;
        editedByUser: boolean;
        updatedAt: string | null;
      }>;
    }>("/api/profile"),
  updatePersona: (slug: string, body: string, title?: string) =>
    request<{
      persona: {
        slug: string;
        title: string;
        body: string;
        editedByUser: boolean;
        updatedAt: string;
      };
    }>(`/api/profile/${slug}`, {
      method: "PUT",
      body: JSON.stringify(title ? { body, title } : { body }),
    }),
  importPersona: (text: string, opts?: { dryRun?: boolean; model?: string }) =>
    request<{
      ok: boolean;
      written: string[];
      proposed: Partial<Record<string, string>>;
      dryRun?: boolean;
      note?: string;
    }>("/api/profile/import", {
      method: "POST",
      body: JSON.stringify({ text, ...(opts ?? {}) }),
    }),
  onboardPersona: (
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    model?: string,
  ) =>
    request<{
      reply: string;
      written: string[];
      persona: Array<{
        slug: string;
        title: string;
        body: string;
        editedByUser: boolean;
        updatedAt: string | null;
      }>;
    }>("/api/profile/onboard", {
      method: "POST",
      body: JSON.stringify({ messages, ...(model ? { model } : {}) }),
    }),

  // (EXO Direct add-on removed in v0.2 — all inference goes through LiteLLM.)

  exportConversationUrl: (id: string) =>
    `/api/conversations/${id}/export.md`,
  exportConversationJsonUrl: (id: string) =>
    `/api/conversations/${id}/export.json`,
  exportProjectUrl: (id: string) => `/api/projects/${id}/export.md`,

  // Workspace files (agentic UX, fs_* tools)
  listFiles: (prefix?: string) =>
    request<{ entries: ApiWorkspaceFile[]; stats: ApiWorkspaceStats }>(
      `/api/files${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ""}`,
    ),
  readFile: (path: string) =>
    request<{ path: string; content: string; mimeType: string }>(
      `/api/files/content?path=${encodeURIComponent(path)}`,
    ),
  writeFile: (path: string, content: string) =>
    request<{ path: string; sizeBytes: number; created: boolean }>(
      `/api/files/content`,
      {
        method: "PUT",
        body: JSON.stringify({ path, content }),
      },
    ),
  deleteFile: (path: string) =>
    request<{ ok: true }>(
      `/api/files/content?path=${encodeURIComponent(path)}`,
      { method: "DELETE" },
    ),

  // Projects
  listProjects: () =>
    request<{ projects: ApiProject[] }>("/api/projects"),
  getProject: (id: string) =>
    request<{ project: ApiProject }>(`/api/projects/${id}`),
  listProjectCategories: () =>
    request<{ categories: ApiProjectCategory[] }>("/api/projects/categories"),
  createProject: (body: {
    name: string;
    category?: string;
    systemPrompt?: string;
    instructions?: string;
    memoryEnabled?: boolean;
    dedicatedMemoryEnabled?: boolean;
    globalMemoryReadOnly?: boolean;
    externalVaultPath?: string | null;
    externalVaultReadOnly?: boolean;
    sharingEnabled?: boolean;
  }) =>
    request<{ project: ApiProject }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateProject: (
    id: string,
    body: Partial<{
      name: string;
      category: string;
      systemPrompt: string | null;
      instructions: string | null;
      memoryEnabled: boolean;
      dedicatedMemoryEnabled: boolean;
      globalMemoryReadOnly: boolean;
      externalVaultPath: string | null;
      externalVaultReadOnly: boolean;
      sharingEnabled: boolean;
    }>,
  ) =>
    request<{ project: ApiProject }>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteProject: (id: string) =>
    request<void>(`/api/projects/${id}`, { method: "DELETE" }),

  // Project memory (per-project vault corpus) ──────────────────────────
  listProjectMemory: (id: string) =>
    request<{
      files: ApiProjectMemoryFile[];
      stats: ApiProjectMemoryStats;
    }>(`/api/projects/${id}/memory`),
  putProjectMemoryFile: (
    id: string,
    body: { path: string; content: string; mimeType?: string },
  ) =>
    request<{ ok: boolean; path: string }>(
      `/api/projects/${id}/memory/files`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  importProjectMemoryFromZip: async (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/projects/${id}/memory/import`, {
      method: "POST",
      body: form,
      credentials: "same-origin",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ApiError(res.status, `${res.status} ${detail}`);
    }
    return res.json() as Promise<{
      imported: Array<{ path: string; bytes: number }>;
      skipped: Array<{ path: string; reason: string }>;
      bytesUsed: number;
      bytesQuota: number;
    }>;
  },
  importProjectMemoryFromPath: (id: string, path: string) =>
    request<{
      imported: Array<{ path: string; bytes: number }>;
      skipped: Array<{ path: string; reason: string }>;
      bytesUsed: number;
      bytesQuota: number;
    }>(`/api/projects/${id}/memory/external`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  deleteProjectMemoryFile: (id: string, path: string) =>
    request<void>(
      `/api/projects/${id}/memory/file?path=${encodeURIComponent(path)}`,
      { method: "DELETE" },
    ),
  wipeProjectMemory: (id: string) =>
    request<void>(`/api/projects/${id}/memory`, { method: "DELETE" }),

  // Add-ons
  listAddons: () =>
    request<{ addons: ApiAddon[] }>("/api/addons"),
  createAddon: (body: {
    name: string;
    kind?: "core" | "plugin" | "mcp";
    description?: string;
    version?: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
  }) =>
    request<{ addon: ApiAddon }>("/api/addons", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAddon: (
    id: string,
    body: Partial<{
      name: string;
      description: string | null;
      version: string | null;
      enabled: boolean;
      config: Record<string, unknown> | null;
    }>,
  ) =>
    request<{ addon: ApiAddon }>(`/api/addons/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAddon: (id: string) =>
    request<void>(`/api/addons/${id}`, { method: "DELETE" }),

  // Obsidian add-on
  obsidianInfo: () =>
    request<{
      addonId: string;
      enabled: boolean;
      hasToken: boolean;
      lastSyncedAt: string | null;
      articleCount: number;
      vaultUrl: string;
    }>("/api/addons/obsidian/info"),
  obsidianRotateToken: () =>
    request<{ token: string }>("/api/addons/obsidian/token", {
      method: "POST",
    }),
  obsidianClearToken: () =>
    request<void>("/api/addons/obsidian/token", { method: "DELETE" }),

  // Web Search (Tavily) add-on
  tavilyInfo: () =>
    request<{ addonId: string; enabled: boolean; hasKey: boolean }>(
      "/api/addons/tavily/info",
    ),
  tavilySetKey: (key: string) =>
    request<{ ok: true }>("/api/addons/tavily/key", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
  tavilyClearKey: () =>
    request<void>("/api/addons/tavily/key", { method: "DELETE" }),

  // Hermes Agent add-on (native gateway, OpenAI-compatible)
  hermesInfo: () =>
    request<{
      addonId: string;
      enabled: boolean;
      apiUrl: string | null;
      gatewayUrl: string;
      gatewayOk: boolean;
      hasApiKey: boolean;
      defaultModel: string;
      availableModels: Array<{ id: string }>;
      lastError: string | null;
    }>("/api/addons/hermes/info"),
  hermesUpdateConfig: (
    body: Partial<{
      apiUrl: string | null;
      apiKey: string | null;
      defaultModel: string;
    }>,
  ) =>
    request<{ ok: true }>("/api/addons/hermes/config", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  // Voice (Gemini Live) add-on
  voiceLiveInfo: () =>
    request<{
      addonId: string;
      enabled: boolean;
      hasApiKey: boolean;
      model: string;
      voice: string;
      systemInstruction: string;
    }>("/api/addons/voice-live/info"),
  voiceLiveUpdateConfig: (
    body: Partial<{
      apiKey: string | null;
      model: string;
      voice: string;
      systemInstruction: string;
    }>,
  ) =>
    request<{ ok: true }>("/api/addons/voice-live/config", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  voiceLiveSession: (body?: { conversationId?: string }) =>
    request<{
      apiKey: string;
      model: string;
      voice: string;
      systemInstruction: string;
      wsUrl: string;
    }>("/api/addons/voice-live/session", {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),

  // Auth
  me: () => request<{ user: AuthUser | null }>("/api/auth/me"),
  login: (body: { email: string; password: string }) =>
    request<{ user: AuthUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  signup: (body: { email: string; password: string; name?: string }) =>
    request<{ user: AuthUser }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  logout: () =>
    request<void>("/api/auth/logout", { method: "POST" }),
  updateProfile: (body: { name?: string }) =>
    request<{ user: AuthUser }>("/api/auth/me", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  changePassword: (body: {
    currentPassword: string;
    newPassword: string;
  }) =>
    request<{ ok: true }>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // ── Admin Extended ──────────────────────────────────────────────────
  adminExtInfo: () =>
    request<{ addonId: string; enabled: boolean }>(
      "/api/addons/admin-ext/info",
    ),

  // Users
  listAdminUsers: () =>
    request<{ users: ApiAdminUser[] }>("/api/admin/users"),
  createAdminUser: (body: {
    email: string;
    name?: string;
    password: string;
    role: AuthRole;
  }) =>
    request<{ user: ApiAdminUser }>("/api/admin/users", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAdminUser: (
    id: string,
    body: Partial<{
      name: string;
      role: AuthRole;
      active: boolean;
      password: string;
    }>,
  ) =>
    request<{ user: ApiAdminUser }>(`/api/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAdminUser: (id: string) =>
    request<void>(`/api/admin/users/${id}`, { method: "DELETE" }),

  // Nodes
  listAdminNodes: () =>
    request<{ nodes: ApiAdminNode[] }>("/api/admin/nodes"),
  createAdminNode: (body: {
    name: string;
    ip: string;
    sshUser?: string;
    sshPassword?: string;
    modelPath: string;
    groupIds?: string[];
  }) =>
    request<{ node: ApiAdminNode }>("/api/admin/nodes", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAdminNode: (
    id: string,
    body: Partial<{
      name: string;
      ip: string;
      sshUser: string;
      sshPassword: string | null;
      modelPath: string;
      status: string;
      groupIds: string[];
    }>,
  ) =>
    request<{ node: ApiAdminNode }>(`/api/admin/nodes/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAdminNode: (id: string) =>
    request<void>(`/api/admin/nodes/${id}`, { method: "DELETE" }),
  sshSetupAdminNode: (id: string, password?: string) =>
    request<{ ok: true } | { error: string; detail?: string }>(
      `/api/admin/nodes/${id}/ssh-setup`,
      {
        method: "POST",
        body: password ? JSON.stringify({ password }) : JSON.stringify({}),
      },
    ),
  getOrchestratorPubkey: () =>
    request<{ pubkey: string }>("/api/admin/nodes/orchestrator/pubkey"),
  deleteNodeModels: (id: string, modelNames: string[]) =>
    request<{
      ok: boolean;
      results: Record<string, "deleted" | "missing" | "error">;
      stderr?: string;
    }>(`/api/admin/nodes/${id}/models/delete`, {
      method: "POST",
      body: JSON.stringify({ modelNames }),
    }),
  probeAdminNode: (id: string) =>
    request<{
      ok: boolean;
      output?: string;
      stderr?: string;
      code?: number;
      status: string;
      lastSeenAt: string | null;
      error?: string;
    }>(`/api/admin/nodes/${id}/probe`, { method: "POST" }),

  // Groups
  listAdminGroups: () =>
    request<{ groups: ApiAdminGroup[] }>("/api/admin/groups"),
  createAdminGroup: (name: string) =>
    request<{ group: ApiAdminGroup }>("/api/admin/groups", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  updateAdminGroup: (id: string, name: string) =>
    request<{ group: ApiAdminGroup }>(`/api/admin/groups/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  deleteAdminGroup: (id: string) =>
    request<void>(`/api/admin/groups/${id}`, { method: "DELETE" }),
  seedDefaultGroups: () =>
    request<{ seeded: boolean; groups: ApiAdminGroup[] }>(
      "/api/admin/groups/seed-defaults",
      { method: "POST" },
    ),

  // Sync
  listSyncJobs: (opts?: { status?: ApiSyncJob["status"]; limit?: number }) => {
    const q = new URLSearchParams();
    if (opts?.status) q.set("status", opts.status);
    if (opts?.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return request<{ jobs: ApiSyncJob[] }>(
      `/api/admin/sync${qs ? `?${qs}` : ""}`,
    );
  },
  getSyncJob: (id: string) =>
    request<{ job: ApiSyncJob }>(`/api/admin/sync/${id}`),
  startSync: (body: {
    sourceNodeId: string;
    targetNodeIds?: string[];
    groupId?: string;
    modelPath: string;
  }) =>
    request<{ jobId: string }>("/api/admin/sync", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  cancelSync: (id: string) =>
    request<{ ok: true }>(`/api/admin/sync/${id}/cancel`, { method: "POST" }),
  syncMatrix: () =>
    request<{ matrix: ApiSyncMatrixEntry[] }>("/api/admin/sync/matrix"),

  // Guest tokens
  listGuestTokens: () =>
    request<{ tokens: ApiGuestToken[] }>("/api/admin/guest-tokens"),
  mintGuestToken: (body: {
    label?: string;
    tokenBudget?: number;
    scope?: "chat";
    expiresInDays?: number;
  }) =>
    request<{ token: string; row: ApiGuestToken }>(
      "/api/admin/guest-tokens",
      { method: "POST", body: JSON.stringify(body) },
    ),
  revokeGuestToken: (id: string) =>
    request<{ ok: true }>(`/api/admin/guest-tokens/${id}`, {
      method: "DELETE",
    }),
  extendGuestToken: (id: string, days: number) =>
    request<{ row: ApiGuestToken }>(
      `/api/admin/guest-tokens/${id}/extend`,
      { method: "POST", body: JSON.stringify({ days }) },
    ),

  // External-agent tokens (MCP) — used by Cowork dispatch, Hermes Agent,
  // any MCP-capable client to call back into Companion as this user.
  listHermesTokens: () =>
    request<
      Array<{
        id: string;
        label: string | null;
        convId: string | null;
        source: "hermes" | "cowork";
        expiresAt: string | null;
        revokedAt: string | null;
        lastUsedAt: string | null;
        createdAt: string;
      }>
    >("/api/hermes-bridge/tokens"),
  mintHermesToken: (body: {
    label?: string;
    ttlMs?: number | null;
    source?: "hermes" | "cowork";
  }) =>
    request<{
      token: string;
      id: string;
      label: string | null;
      source: "hermes" | "cowork";
      expiresAt: string | null;
      createdAt: string;
    }>("/api/hermes-bridge/tokens", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revokeHermesToken: (id: string) =>
    request<{ ok: true }>(`/api/hermes-bridge/tokens/${id}`, {
      method: "DELETE",
    }),

  // Guest session (snapshot of current guest token's budget + expiry)
  guestSession: () =>
    request<{
      ok: true;
      scope: string;
      tokenBudget: number;
      tokensUsed: number;
      expiresAt: string | null;
    }>("/api/guest/session"),
};

/** Subscribe to live SSE events for a sync job. Returns a cleanup fn that
 *  closes the EventSource. The handler is called for every parsed event. */
export function streamSyncEvents(
  jobId: string,
  onEvent: (ev: SyncStreamEvent) => void,
): () => void {
  const es = new EventSource(`/api/admin/sync/${jobId}/events`);
  es.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data) as SyncStreamEvent;
      onEvent(data);
    } catch {
      /* ignore */
    }
  };
  es.onerror = () => {
    // Let the consumer decide when to give up; we just stop receiving.
    es.close();
  };
  return () => es.close();
}

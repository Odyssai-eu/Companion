export type ApiGlobalModel = {
  id: string;
  name: string;
  tags: string[];
  capabilities: { vision: boolean; tools: boolean };
};

export type ApiInferenceSettings = {
  defaultModel: string | null;
  litellmUrl: string | null;
  timezone: string;
  hasApiKey: boolean;
  envDefaultUrl: string;
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
  model: string | null;
  pinned: boolean;
  /** Memory wiki injection toggle for this conversation. Inherited from
   *  the parent project at creation; user-flippable from the chat header. */
  memoryEnabled: boolean;
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
  /** Default for new conversations under this project. */
  memoryEnabled: boolean;
  createdAt: string;
  updatedAt: string;
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

export type ApiMessage = {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning: string | null;
  stats: Record<string, unknown> | null;
  createdAt: string;
};

export type ApiCodePreflight = {
  repoPath: string;
  repoName: string;
  repoExists: boolean;
  allowed: boolean;
  gitRepo: boolean;
  dirtyTree: boolean | null;
  docsRead: Array<{ path: string; bytes: number; excerpt: string }>;
  manifests: string[];
  memorySources: string[];
  factsUsed: string[];
  forbiddenMoves: string[];
  blockers: string[];
  risk: "low" | "medium" | "high";
};

export type ApiCodeSession = {
  id: string;
  userId: string;
  repoPath: string;
  repoName: string;
  task: string;
  model: string | null;
  status: string;
  risk: "low" | "medium" | "high";
  preflight: ApiCodePreflight | null;
  blockers: string[] | null;
  hermesSessionId: string | null;
  hermesStatus: string | null;
  hermesOutput: string | null;
  hermesError: string | null;
  createdAt: string;
  updatedAt: string;
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
    }>,
  ) =>
    request<{ ok: true }>("/api/inference/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  inferenceStatus: () =>
    request<ApiInferenceStatus>("/api/inference/status"),

  listConversations: () =>
    request<{ conversations: ApiConversation[] }>("/api/conversations"),
  getConversation: (id: string) =>
    request<{ conversation: ApiConversation; messages: ApiMessage[] }>(
      `/api/conversations/${id}`,
    ),
  createConversation: (body: {
    title?: string;
    projectId?: string;
    model?: string;
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
  moveConversationToProject: (id: string, projectId: string | null) =>
    request<{ conversation: ApiConversation }>(`/api/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ projectId }),
    }),
  deleteConversation: (id: string) =>
    request<void>(`/api/conversations/${id}`, { method: "DELETE" }),
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

  // EXO Direct add-on
  exoInfo: () =>
    request<{
      addonId: string;
      enabled: boolean;
      endpoints: Array<{
        id: string;
        label: string;
        baseUrl: string;
        models: string[];
      }>;
    }>("/api/addons/exo/info"),
  exoAddEndpoint: (label: string, url: string) =>
    request<{ endpoint: { id: string; label: string; baseUrl: string } }>(
      "/api/addons/exo/endpoints",
      { method: "POST", body: JSON.stringify({ label, url }) },
    ),
  exoUpdateEndpoint: (
    id: string,
    patch: { label?: string; url?: string },
  ) =>
    request<{ endpoint: { id: string; label: string; baseUrl: string } }>(
      `/api/addons/exo/endpoints/${id}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    ),
  exoDeleteEndpoint: (id: string) =>
    request<void>(`/api/addons/exo/endpoints/${id}`, { method: "DELETE" }),
  exoRefreshEndpoint: (id: string) =>
    request<{
      endpoint: { id: string; label: string; baseUrl: string; models: string[] };
    }>(`/api/addons/exo/endpoints/${id}/refresh`, { method: "POST" }),
  exportConversationUrl: (id: string) =>
    `/api/conversations/${id}/export.md`,
  exportConversationJsonUrl: (id: string) =>
    `/api/conversations/${id}/export.json`,
  exportProjectUrl: (id: string) => `/api/projects/${id}/export.md`,

  // Code Sessions — read-only preflight for now
  codePreflight: (body: {
    repoPath: string;
    task: string;
    model?: string;
    project?: string;
  }) =>
    request<{ session: ApiCodeSession; preflight: ApiCodePreflight }>(
      "/api/code/preflight",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  listCodeSessions: (limit = 30) =>
    request<{ sessions: ApiCodeSession[] }>(`/api/code?limit=${limit}`),
  getCodeSession: (id: string) =>
    request<{ session: ApiCodeSession }>(`/api/code/${id}`),
  deleteCodeSession: (id: string) =>
    request<void>(`/api/code/${id}`, { method: "DELETE" }),
  clearCodeSessions: (scope: "terminal" | "all" = "terminal") =>
    request<{ deleted: number }>(`/api/code?scope=${scope}`, {
      method: "DELETE",
    }),
  codeHermesPreflight: (
    id: string,
    body?: { model?: string; skills?: string[] },
  ) =>
    request<{ session: ApiCodeSession; hermes?: unknown }>(
      `/api/code/${id}/hermes-preflight`,
      {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      },
    ),
  codeHermesWriteTests: (
    id: string,
    body?: { model?: string; skills?: string[] },
  ) =>
    request<{
      session: ApiCodeSession;
      hermes?: unknown;
      write?: {
        ok: boolean;
        filesWritten: string[];
        blockers: string[];
        diffStat: string;
        diff: string;
      };
    }>(`/api/code/${id}/hermes-write-tests`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  codeRunTests: (id: string, body?: { command?: string }) =>
    request<{
      session: ApiCodeSession;
      test?: {
        ok: boolean;
        command: string;
        exitCode: number | null;
        stdout: string;
        stderr: string;
        blockers: string[];
        elapsedMs: number;
      };
    }>(`/api/code/${id}/run-tests`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),

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
    }>,
  ) =>
    request<{ project: ApiProject }>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteProject: (id: string) =>
    request<void>(`/api/projects/${id}`, { method: "DELETE" }),

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

  // Hermes Agent add-on
  hermesInfo: () =>
    request<{
      addonId: string;
      enabled: boolean;
      apiUrl: string | null;
      bridgeUrl: string;
      bridgeOk: boolean;
      selectedSkills: string[];
      defaultModel: string;
      autonomous: boolean;
      availableSkills: Array<{
        name: string;
        description: string;
        kind: "file" | "bundle" | "collection";
      }>;
    }>("/api/addons/hermes/info"),
  hermesUpdateConfig: (
    body: Partial<{
      apiUrl: string | null;
      selectedSkills: string[];
      defaultModel: string;
      autonomous: boolean;
    }>,
  ) =>
    request<{ ok: true }>("/api/addons/hermes/config", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  hermesSession: (id: string) =>
    request<{
      id: string;
      mode: string;
      status: string;
      output: string;
      error: string;
      elapsed_ms: number | null;
    }>(`/api/addons/hermes/sessions/${id}`),

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

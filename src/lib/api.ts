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
      detail = body.detail ?? body.error ?? JSON.stringify(body);
      code = body.error;
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new ApiError(res.status, `${res.status} ${res.statusText}: ${detail}`, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
};

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

  // EXO Direct add-on
  exoInfo: () =>
    request<{
      addonId: string;
      enabled: boolean;
      baseUrl: string;
      models: string[];
    }>("/api/addons/exo/info"),
  exoSetUrl: (url: string) =>
    request<{ ok: true; baseUrl: string }>("/api/addons/exo/url", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  exoClearUrl: () =>
    request<void>("/api/addons/exo/url", { method: "DELETE" }),
  exoListModels: () =>
    request<{ models: string[]; reason?: string }>(
      "/api/addons/exo/models",
    ),
  exportConversationUrl: (id: string) =>
    `/api/conversations/${id}/export.md`,
  exportConversationJsonUrl: (id: string) =>
    `/api/conversations/${id}/export.json`,
  exportProjectUrl: (id: string) => `/api/projects/${id}/export.md`,

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
};

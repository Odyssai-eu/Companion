export type ApiServer = {
  id: string;
  userId: string;
  name: string;
  hint: string | null;
  url: string;
  description: string | null;
  engineKind: "openai-compat" | "anthropic";
  authBearer: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ApiModel = {
  id: string;
  name: string;
  loaded: boolean;
  endpoints: string[];
};

export type ApiConversation = {
  id: string;
  userId: string;
  serverId: string | null;
  projectId: string | null;
  title: string;
  model: string | null;
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

export type ApiEndpoint = {
  id: string;
  serverId: string;
  label: string;
  role: "primary" | "secondary";
  node: string | null;
  ip: string;
  port: number;
  healthy: boolean;
  latencyMs: number | null;
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
  listServers: () => request<{ servers: ApiServer[] }>("/api/servers"),
  getServer: (id: string) =>
    request<{ server: ApiServer; endpoints: ApiEndpoint[] }>(
      `/api/servers/${id}`,
    ),
  createServer: (body: {
    name: string;
    ip: string;
    port: number;
    hint?: string;
    description?: string;
  }) =>
    request<{ server: ApiServer; endpoint: ApiEndpoint }>("/api/servers", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteServer: (id: string) =>
    request<void>(`/api/servers/${id}`, { method: "DELETE" }),
  updateServer: (
    id: string,
    body: {
      name?: string;
      hint?: string | null;
      description?: string | null;
      authBearer?: string | null;
      engineKind?: "openai-compat" | "anthropic";
    },
  ) =>
    request<{ server: ApiServer }>(`/api/servers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  listModels: (serverId: string) =>
    request<{ models: ApiModel[]; error?: string }>(
      `/api/servers/${serverId}/models`,
    ),
  addEndpoint: (
    serverId: string,
    body: {
      label: string;
      role: "primary" | "secondary";
      node?: string;
      ip: string;
      port: number;
    },
  ) =>
    request<{ endpoint: ApiEndpoint }>(`/api/servers/${serverId}/endpoints`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateEndpoint: (
    serverId: string,
    endpointId: string,
    body: Partial<{
      label: string;
      role: "primary" | "secondary";
      node: string | null;
      ip: string;
      port: number;
    }>,
  ) =>
    request<{ endpoint: ApiEndpoint }>(
      `/api/servers/${serverId}/endpoints/${endpointId}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
  deleteEndpoint: (serverId: string, endpointId: string) =>
    request<void>(`/api/servers/${serverId}/endpoints/${endpointId}`, {
      method: "DELETE",
    }),
  testServer: (serverId: string) =>
    request<{ endpoints: ApiEndpoint[] }>(
      `/api/servers/${serverId}/test`,
      { method: "POST" },
    ),
  testEndpoint: (serverId: string, endpointId: string) =>
    request<{ endpoint: ApiEndpoint }>(
      `/api/servers/${serverId}/endpoints/${endpointId}/test`,
      { method: "POST" },
    ),

  listConversations: () =>
    request<{ conversations: ApiConversation[] }>("/api/conversations"),
  getConversation: (id: string) =>
    request<{ conversation: ApiConversation; messages: ApiMessage[] }>(
      `/api/conversations/${id}`,
    ),
  createConversation: (body: {
    title?: string;
    serverId?: string;
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
  deleteConversation: (id: string) =>
    request<void>(`/api/conversations/${id}`, { method: "DELETE" }),
  appendMessage: (
    conversationId: string,
    body: {
      role: "user" | "assistant" | "system";
      content: string;
      reasoning?: string;
      stats?: Record<string, unknown>;
    },
  ) =>
    request<{ message: ApiMessage }>(
      `/api/conversations/${conversationId}/messages`,
      { method: "POST", body: JSON.stringify(body) },
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

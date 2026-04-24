export type ApiServer = {
  id: string;
  userId: string;
  name: string;
  hint: string | null;
  url: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ApiConversation = {
  id: string;
  userId: string;
  serverId: string | null;
  title: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

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
};

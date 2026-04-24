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
    url: string;
    hint?: string;
    description?: string;
  }) =>
    request<{ server: ApiServer }>("/api/servers", {
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
};

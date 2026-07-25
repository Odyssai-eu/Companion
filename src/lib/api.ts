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
  /** Display name of the cluster this model belongs to (e.g. "Argo",
   *  "TeleCoder"). Set by OdyssAI-X >= 1.7.10 from the cluster def's
   *  `name` field. Used to render picker group headings without
   *  surfacing the cluster id ("main", "telemak-code-next"). */
  cluster_label?: string;
  /** Cluster kind ("mlx-distributed" | "telemak" | …). Lets the
   *  picker bucket entries without pattern-matching backend / pool. */
  kind?: string;
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

/**
 * Inference mode (migration 0058 — was easy | advanced | expert).
 *
 *  - `auto`   — no model picker in the chat. Every turn goes out on
 *               {@link AUTO_ROUTER_MODEL_ID} and the Auto Router add-on
 *               decides which model answers. Replaces the retired `easy`
 *               and `advanced` modes; the server read-maps both to `auto`.
 *  - `expert` — full catalog picker, user chooses per turn. Default.
 */
export type ApiInferenceMode = "auto" | "expert";

/**
 * The synthetic MODEL ID meaning "let the Auto Router decide".
 *
 * Careful: same word as the `auto` inference MODE, different thing. The
 * mode is the per-user UX setting above; this is the value that goes on
 * the wire in the chat request body. Auto mode always sends it, but an
 * expert-mode user can also pick "Auto" from the picker.
 * Server-side twin: AUTO_ROUTER_MODEL_ID in server/routes/chat.ts.
 */
export const AUTO_ROUTER_MODEL_ID = "auto";

/** @deprecated 0058 — the advanced mode's 4 named slots. Nothing writes
 *  these anymore; the column survives only so the migration is
 *  reversible. */
export type ApiNamedModels = {
  conversation?: string;
  analyse?: string;
  engineer?: string;
  expert?: string;
};

/**
 * The connection block as the user's OWN override — null everywhere they
 * inherit the instance value. Settings FORMS bind to this, never to the
 * effective values at the top level of ApiInferenceSettings: a form seeded
 * from the effective value re-saves it as a personal override on the next
 * click, quietly snapshotting the instance config and breaking inheritance.
 */
export type ApiConnectionOverrides = {
  defaultModel: string | null;
  litellmUrl: string | null;
  hasApiKey: boolean;
  litellmDisabled: boolean | null;
  engineUrl: string | null;
  hasEngineToken: boolean;
  engineMode: "gateway" | "hybrid" | "legacy" | null;
  /** 0060 — null means "inherit the instance timezone". */
  timezone: string | null;
};

/** The shared instance defaults. Used for placeholders and hints. */
export type ApiInstanceConnection = {
  defaultModel: string | null;
  litellmUrl: string | null;
  hasApiKey: boolean;
  litellmDisabled: boolean;
  engineUrl: string | null;
  hasEngineToken: boolean;
  engineMode: "gateway" | "hybrid" | "legacy";
  /** 0060 — the deployment's timezone. Always a real IANA zone. */
  timezone: string;
};

/**
 * Admin view of the instance connection block (`GET/PUT
 * /api/admin/instance-settings`). Secrets are exposed as booleans only.
 */
export type ApiInstanceSettings = {
  engineUrl: string | null;
  hasEngineToken: boolean;
  engineMode: "gateway" | "hybrid" | "legacy";
  engineMeta: Record<string, unknown> | null;
  litellmUrl: string | null;
  hasLitellmApiKey: boolean;
  litellmDisabled: boolean;
  defaultModel: string | null;
};

/** Per field: true when the effective value came from the instance. */
export type ApiInheritedFlags = {
  defaultModel: boolean;
  litellmUrl: boolean;
  litellmApiKey: boolean;
  litellmDisabled: boolean;
  engineUrl: boolean;
  engineToken: boolean;
  engineMode: boolean;
  engineMeta: boolean;
  timezone: boolean;
};

export type ApiInferenceSettings = {
  /** EFFECTIVE default model — the user's override, else the instance's. */
  defaultModel: string | null;
  /** EFFECTIVE LiteLLM URL (override ?? instance ?? env). */
  litellmUrl: string | null;
  timezone: string;
  /** True when a LiteLLM key resolves — the user's or the instance's. */
  hasApiKey: boolean;
  /** Deployment env fallback (LITELLM_URL), last link of the chain. */
  envDefaultUrl: string;
  inferenceMode: ApiInferenceMode;
  /** The caller's own values, null where inherited. Forms bind here. */
  overrides: ApiConnectionOverrides;
  /** Which effective values came from the instance. */
  inherited: ApiInheritedFlags;
  /** The shared defaults behind the inheritance. */
  instance: ApiInstanceConnection;
  /** @deprecated 0058 — the easy-mode single model. Its role moved to the
   *  Auto Router's `fallbackModel`; still returned by the API so the
   *  migration stays reversible, but no UI reads it. */
  easyModel: string | null;
  /** @deprecated 0058 — the advanced-mode slots. Nothing reads them. */
  namedModels: ApiNamedModels;
  /** EFFECTIVE URL of the Odyssai-compatible engine used for capability
   *  discovery and (in gateway mode) inference — the user's own if they
   *  paired one, otherwise the instance's. Distinct from litellmUrl. */
  engineUrl: string | null;
  /** True when an engine bearer token resolves (its value is never
   *  returned, only its presence). */
  hasEngineToken: boolean;
  /** Cached `.well-known/inference-engine.json` body from the last
   *  successful probe of whichever engine won. Lets the UI render
   *  version/features without an extra round-trip. */
  engineMeta: Record<string, unknown> | null;
  /** EFFECTIVE provider mode — auto-derived from features.cloud-passthrough
   *  at pair time. Drives chat routing + model listing. */
  engineMode: "gateway" | "hybrid" | "legacy";
  /** EFFECTIVE master switch for LiteLLM. When true, /api/models and
   *  /api/chat refuse to use litellmUrl even if set. */
  litellmDisabled: boolean;
  /** Per-user toggle for the per-assistant-message stats box. Off by
   *  default. Power users flip it on in Settings → Inference. */
  showMetrics: boolean;
  /** Per-user toggle for verbose debug logging on chat.ts (logs upstream
   *  request bodies to docker logs). Off by default. */
  debugVerbose: boolean;
  /** Model ids the user has hidden from the chat picker. `easy` mode
   *  filters them out entirely; advanced/expert gray them out so the
   *  user can un-hide via the eye toggle next to each row. */
  hiddenModels: string[];
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
  /** The caller's row if they have one, else the instance row's (0060). */
  id: string;
  /** Non-null only when the caller has a row of their own. */
  ownRowId: string | null;
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
  /** True when this card is the instance's, not the caller's own (0060). */
  inherited: boolean;
  /**
   * True when the caller's own row sits on TOP of an instance row of the
   * same slug. Deleting it goes back to the shared configuration instead
   * of removing the server.
   */
  overridesInstance: boolean;
  /**
   * True when THIS caller completed the OAuth dance. Distinct from
   * `inherited`: an instance row can declare an OAuth server nobody on this
   * account has authorized yet, and the UI must still offer Connect.
   */
  oauthConnectedByMe: boolean;
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
  source: "user" | "agent" | "imported";
  license: string | null;
  compatibility: string | null;
  files: Record<string, string>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ApiSkillSummary = {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  source: "user" | "agent" | "imported";
  license: string | null;
  compatibility: string | null;
  bodyLength: number;
  fileCount: number;
  updatedAt: string;
};

export type ApiSkillInput = {
  name: string;
  description?: string | null;
  body: string;
  tags?: string[];
  license?: string | null;
  compatibility?: string | null;
  files?: Record<string, string>;
  metadata?: Record<string, unknown>;
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
  /** 'chat' (text/multimodal) or 'talk' (Voice Live). The legacy 'hermes'
   *  kind is accepted in the type only for backwards-compat with old rows;
   *  the server normalises it to 'chat'. */
  kind: "chat" | "talk" | "hermes";
  /** Legacy field from the retired Hermes integration. Always null on
   *  new conversations. */
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
  /** Persistent agent mode — when set, the composer routes every
   *  message to this agent's bridge instead of the LLM chat path.
   *  /exit (or /<kind>_off) clears it. */
  activeAgent?: string | null;
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
  /** Working directory on the user's machine — companion-local runs bash/fs
   *  there. null → default ~/companion. */
  workingDir: string | null;
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

/** Global user-memory vault types — same shapes as the project equivalents
 *  (above) but scoped to the authenticated user. Backed by user_memory_files
 *  + users.external_vault_path. Lives under /api/profile/vault. */
export type ApiUserMemoryFile = ApiProjectMemoryFile;
export type ApiUserMemoryStats = ApiProjectMemoryStats;
export type ApiUserMemorySettings = {
  externalVaultPath: string | null;
  externalVaultReadOnly: boolean;
  autoMemoryEnabled: boolean;
  // #29: 'advanced' (default) = full RAG path; 'basic' = wiki/vault only.
  memoryMode: "basic" | "advanced";
};

/**
 * One add-on card as the caller sees it (0060). An EFFECTIVE view, not a
 * row: the values may come from the caller's own row, from the instance
 * row every account inherits, or — when neither exists yet — from the
 * build's catalogue, in which case `id` is null.
 *
 * Address writes by `name`, never by `id`: `id` can be the shared row's,
 * and `api.setAddonByName` is what performs the copy-on-write.
 */
export type ApiAddon = {
  /** The caller's row if they have one, else the instance row's, else null. */
  id: string | null;
  /** Non-null only when the caller has a row of their own. */
  ownRowId: string | null;
  userId: string | null;
  name: string;
  kind: "core" | "plugin" | "mcp";
  description: string | null;
  version: string | null;
  enabled: boolean;
  /** Secrets and the bulky router centroids are stripped — see configHas. */
  config: Record<string, unknown>;
  /** `true` for a stripped key that IS set, `false` when it is not. */
  configHas: Record<string, boolean>;
  /** True when the caller has no row: everything comes from the instance. */
  inherited: boolean;
  /** Config keys whose effective value came from the instance row. */
  inheritedConfigKeys: string[];
  /**
   * True when the caller's own row sits on TOP of an instance row of the
   * same name. The ONLY condition under which "Reset to instance settings"
   * is a reset: with no instance row behind it, dropping the override
   * deletes the only copy of the configuration.
   */
  overridesInstance: boolean;
};

export type ApiProjectCategory = {
  id: string;
  name: string;
  icon: string;
  systemPrompt: string;
};

export type ApiTeam = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
};

export type ApiTeamMember = {
  userId: string;
  role: "admin" | "member";
  email: string;
  name: string | null;
};

export type ApiDecision = {
  id: string;
  projectId: string;
  createdBy: string | null;
  title: string;
  context: string;
  alternatives: string;
  choice: string;
  rationale: string;
  revisitBy: string | null;
  createdAt: string;
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
  /** ComfyUI image references (post-refacto 2026-06-22). Mirrors
   *  server/db/schema.ts ComfyuiAttachment. */
  attachments: Array<{
    filename: string;
    mime: string;
    bridge_url: string;
    template_slug?: string;
  }> | null;
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

export type ApiAuditEntry = {
  id: string;
  userId: string | null;
  event: string;
  ip: string | null;
  projectId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
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
      /** null / "" = drop the override and inherit the instance zone. */
      timezone: string | null;
      inferenceMode: ApiInferenceMode;
      easyModel: string | null;
      namedModels: ApiNamedModels | null;
      engineUrl: string | null;
      engineToken: string | null;
      // null on these three = "clear my override, inherit the instance
      // value" (0059).
      engineMode: "gateway" | "hybrid" | "legacy" | null;
      litellmDisabled: boolean | null;
      showMetrics: boolean;
      debugVerbose: boolean;
      hiddenModels: string[] | null;
    }>,
  ) =>
    request<{ ok: true }>("/api/inference/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /**
   * Drop the caller's overrides for one group of settings and fall back to
   * the instance values. Prefer this over PATCHing nulls: it also clears
   * engine_meta, which the PATCH surface doesn't expose.
   */
  resetInferenceToInstance: (
    scope: "engine" | "litellm" | "defaultModel" | "timezone" | "all",
  ) =>
    request<{ ok: true; scope: string }>("/api/inference/reset-to-instance", {
      method: "POST",
      body: JSON.stringify({ scope }),
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

  // Agent skills (agentskills.io format) — used by Settings → Skills.
  listSkills: () => request<{ skills: ApiSkillSummary[] }>("/api/skills"),
  getSkill: (id: string) =>
    request<{ skill: ApiSkill }>(`/api/skills/${id}`),
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
  importSkillMd: (content: string) =>
    request<{ skill: ApiSkill }>("/api/skills/import/md", {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  importSkillZip: async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/skills/import/zip", {
      method: "POST",
      body: fd,
      credentials: "include",
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(t || `HTTP ${res.status}`);
    }
    return (await res.json()) as { skill: ApiSkill };
  },
  exportSkillUrl: (id: string) => `/api/skills/${id}/export`,

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

  // ── Join the Odyssai (OdyssAI-X gateway pairing) ───────────────────────
  // Server-side LAN scan returns the engines reachable from the backend's
  // network. In a typical deployment this is the Companion server's LAN — same as the deployment's LAN —
  // so it finds OdyssAI-X on .141. Multi-tenant cloud users on other
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
    kind?: "chat" | "talk";
    repoPath?: string;
    memoryEnabled?: boolean;
    agentMode?: boolean;
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
  setConversationModel: (id: string, model: string) =>
    request<{ conversation: ApiConversation }>(`/api/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ model }),
    }),
  setConversationActiveAgent: (id: string, activeAgent: string | null) =>
    request<{ conversation: ApiConversation }>(`/api/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ activeAgent }),
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

  // Hermes Bridge retired 2026-05-19 — no client methods remain.
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
      /** ComfyUI image references (post-refacto 2026-06-22). Bytes live
       *  on the compute host; we only persist the reference. */
      attachments?: Array<{
        filename: string;
        mime: string;
        bridge_url: string;
        template_slug?: string;
      }>;
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
      workingDir: string | null;
    }>,
  ) =>
    request<{ project: ApiProject }>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteProject: (id: string) =>
    request<void>(`/api/projects/${id}`, { method: "DELETE" }),

  // Local-agent folder picker (browses the user's machine via companion-local)
  browseLocal: (path: string) =>
    request<{ dir: string; files: { name: string; path: string; isDir: boolean }[] }>(
      "/api/local-agent/browse",
      { method: "POST", body: JSON.stringify({ path }) },
    ),
  mkdirLocal: (path: string) =>
    request<{ ok: boolean; path: string }>("/api/local-agent/mkdir", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

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

  // Decision log ──────────────────────────────────────────────────────────
  // Teams
  listTeams: () => request<{ teams: ApiTeam[] }>("/api/teams"),
  createTeam: (body: { name: string; description?: string }) =>
    request<{ team: ApiTeam }>("/api/teams", { method: "POST", body: JSON.stringify(body) }),
  getTeam: (id: string) =>
    request<{ team: ApiTeam; members: ApiTeamMember[] }>(`/api/teams/${id}`),
  updateTeam: (id: string, body: { name?: string; description?: string }) =>
    request<{ team: ApiTeam }>(`/api/teams/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteTeam: (id: string) => request<void>(`/api/teams/${id}`, { method: "DELETE" }),
  addTeamMember: (teamId: string, body: { userId: string; role?: string }) =>
    request<{ ok: boolean }>(`/api/teams/${teamId}/members`, {
      method: "POST", body: JSON.stringify(body),
    }),
  removeTeamMember: (teamId: string, userId: string) =>
    request<void>(`/api/teams/${teamId}/members/${userId}`, { method: "DELETE" }),
  nemoSyncTeam: (teamId: string) =>
    request<{ ok: boolean }>(`/api/admin/nemo-sync?scope=team&teamId=${teamId}`, { method: "POST" }),

  listDecisions: (projectId: string) =>
    request<{ decisions: ApiDecision[] }>(
      `/api/projects/${projectId}/decisions`,
    ),
  createDecision: (
    projectId: string,
    body: {
      title: string;
      context?: string;
      alternatives?: string;
      choice?: string;
      rationale?: string;
      revisitBy?: string | null;
    },
  ) =>
    request<{ decision: ApiDecision }>(
      `/api/projects/${projectId}/decisions`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  deleteDecision: (projectId: string, decisionId: string) =>
    request<void>(`/api/projects/${projectId}/decisions/${decisionId}`, {
      method: "DELETE",
    }),

  // User memory vault (global, per-account) ─────────────────────────────
  listUserMemory: () =>
    request<{
      files: ApiUserMemoryFile[];
      stats: ApiUserMemoryStats;
      settings: ApiUserMemorySettings;
    }>(`/api/profile/vault`),
  importUserMemoryFromZip: async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/profile/vault/import`, {
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
  importUserMemoryFromPath: (path: string) =>
    request<{
      imported: Array<{ path: string; bytes: number }>;
      skipped: Array<{ path: string; reason: string }>;
      bytesUsed: number;
      bytesQuota: number;
    }>(`/api/profile/vault/external`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  updateUserMemorySettings: (body: {
    externalVaultPath?: string | null;
    externalVaultReadOnly?: boolean;
    autoMemoryEnabled?: boolean;
    memoryMode?: "basic" | "advanced";
  }) =>
    request<{ ok: boolean; changed: boolean }>(`/api/profile/vault/settings`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteUserMemoryFile: (path: string) =>
    request<void>(
      `/api/profile/vault/file?path=${encodeURIComponent(path)}`,
      { method: "DELETE" },
    ),
  wipeUserMemory: () =>
    request<void>(`/api/profile/vault`, { method: "DELETE" }),

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
  /**
   * Edit an add-on BY IDENTITY (0060). This is the one to use: a card may
   * be inherited from the instance or exist only in the catalogue, so it
   * has no row id of the caller's to address. The server materialises
   * their own row if needed and applies the patch there — it never writes
   * the shared row.
   *
   * `enabled: null` drops the switch override and goes back to following
   * the instance.
   */
  setAddonByName: (
    name: string,
    body: Partial<{
      description: string | null;
      version: string | null;
      enabled: boolean | null;
      config: Record<string, unknown> | null;
    }>,
  ) =>
    request<{ addon: ApiAddon }>(
      `/api/addons/by-name/${encodeURIComponent(name)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
  /** "Reset to instance settings" — delete the caller's override row. */
  resetAddonToInstance: (name: string) =>
    request<{ ok: true; addon: ApiAddon }>(
      `/api/addons/by-name/${encodeURIComponent(name)}/override`,
      { method: "DELETE" },
    ),
  /** @deprecated 0060 — prefer setAddonByName; an inherited card's `id` is
   *  the instance row's and only resolves to a copy-on-write server-side. */
  updateAddon: (
    id: string,
    body: Partial<{
      description: string | null;
      version: string | null;
      enabled: boolean | null;
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
      addonId: string | null;
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
    request<{ addonId: string | null; enabled: boolean; hasKey: boolean }>(
      "/api/addons/tavily/info",
    ),
  tavilySetKey: (key: string) =>
    request<{ ok: true }>("/api/addons/tavily/key", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
  tavilyClearKey: () =>
    request<void>("/api/addons/tavily/key", { method: "DELETE" }),

  // Saved prompts — user-owned library of named system prompts
  listSavedPrompts: () =>
    request<{
      prompts: Array<{
        id: string;
        name: string;
        body: string;
        createdAt: string;
        updatedAt: string;
      }>;
    }>("/api/saved-prompts"),
  createSavedPrompt: (body: { name: string; body: string }) =>
    request<{
      prompt: {
        id: string;
        name: string;
        body: string;
        createdAt: string;
        updatedAt: string;
      };
    }>("/api/saved-prompts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateSavedPrompt: (id: string, body: { name?: string; body?: string }) =>
    request<{
      prompt: {
        id: string;
        name: string;
        body: string;
        createdAt: string;
        updatedAt: string;
      };
    }>(`/api/saved-prompts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteSavedPrompt: (id: string) =>
    request<void>(`/api/saved-prompts/${id}`, { method: "DELETE" }),

  // /help slash command — BM25 over the user-guide wiki, conv context
  // is stripped on the server side. Returns SSE stream of:
  //   event: sources   data: { articles: [{slug, title, score}, …] }
  //   event: chunk     (standard chat-completion delta stream)
  //   event: done      data: { chars, model }
  helpStatus: () =>
    request<{ indexed: number; loadedFrom: string | null }>(
      "/api/help/status",
    ),

  // Hermes Agent add-on retired 2026-05-19. Reinstated 2026-05-21 with a
  // new architecture: ACP bridge on the user's machine.
  hermesAddonInfo: () =>
    request<{
      addonId: string | null;
      enabled: boolean;
      configured: boolean;
      bridgeUrl: string;
      hasToken: boolean;
    }>("/api/addons/hermes/info"),
  hermesAddonSetConfig: (body: {
    enabled?: boolean;
    bridgeUrl?: string;
    bridgeToken?: string | null;
  }) =>
    request<{
      ok: true;
      enabled: boolean;
      configured: boolean;
      bridgeUrl: string;
      hasToken: boolean;
    }>("/api/addons/hermes/config", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  hermesAddonProbe: () =>
    request<{ ok: boolean; health?: unknown; error?: string; status?: number }>(
      "/api/addons/hermes/probe",
      { method: "POST" },
    ),
  hermesTranscript: (conversationId: string) =>
    request<{
      sessionId: string | null;
      messages: Array<{
        id: string;
        sessionId: string;
        role: "user" | "agent" | "tool";
        content: string;
        stats: Record<string, unknown> | null;
        createdAt: string;
      }>;
    }>(`/api/agents/hermes/transcript/${conversationId}`),
  hermesReset: (conversationId: string) =>
    request<{ ok: true }>(`/api/agents/hermes/reset/${conversationId}`, {
      method: "POST",
    }),

  // Pi Agent — see addon-pi.ts + agent-pi.ts on the server. The bridge
  // wraps the `pi` CLI on a backend host; transcript lives in the Pi
  // session jsonl on disk there, not in Companion's DB.
  piAddonInfo: () =>
    request<{
      addonId: string | null;
      enabled: boolean;
      configured: boolean;
      bridgeUrl: string;
      cwd: string;
      hasToken: boolean;
    }>("/api/addons/pi/info"),
  piAddonSetConfig: (body: {
    enabled?: boolean;
    bridgeUrl?: string;
    bridgeToken?: string | null;
    cwd?: string | null;
  }) =>
    request<{
      ok: true;
      enabled: boolean;
      configured: boolean;
      bridgeUrl: string;
      cwd: string;
      hasToken: boolean;
    }>("/api/addons/pi/config", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  piAddonProbe: () =>
    request<{ ok: boolean; health?: unknown; error?: string; status?: number }>(
      "/api/addons/pi/probe",
      { method: "POST" },
    ),
  piTranscript: (conversationId: string) =>
    request<{
      sessionId: string | null;
      entries: Array<Record<string, unknown>>;
    }>(`/api/agents/pi/transcript/${conversationId}`),
  piReset: (conversationId: string) =>
    request<{ ok: true }>(`/api/agents/pi/reset/${conversationId}`, {
      method: "POST",
    }),

  // ComfyUI Imager add-on. Backed by the OdyssAI-Imager FastAPI bridge
  // (port 8008 on .141). Generate returns an SSE stream of bridge events
  // (preflight, params, fp8_fallback, downloads_*, submitting, sampling,
  // done, error) — the panel UI subscribes per event name with a native
  // EventSource-style reader. Wait=true on the bridge is forced server-side
  // so a single call yields one image back.
  comfyuiAddonInfo: () =>
    request<{
      addonId: string | null;
      enabled: boolean;
      configured: boolean;
      bridgeUrl: string;
      hasToken: boolean;
    }>("/api/addons/comfyui/info"),
  comfyuiAddonSetConfig: (body: {
    enabled?: boolean;
    bridgeUrl?: string;
    bridgeToken?: string | null;
  }) =>
    request<{
      ok: true;
      enabled: boolean;
      configured: boolean;
      bridgeUrl: string;
      hasToken: boolean;
    }>("/api/addons/comfyui/config", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  comfyuiAddonProbe: () =>
    request<{ ok: boolean; health?: unknown; error?: string; status?: number }>(
      "/api/addons/comfyui/probe",
      { method: "POST" },
    ),
  comfyuiTemplates: () =>
    request<{
      templates: Array<{
        slug: string;
        description: string | null;
        model: string | null;
        inputs: string[];
        defaults?: Record<string, number>;
      }>;
      service?: string;
      version?: string;
      source?: "bridge" | "fallback";
    }>("/api/agents/comfyui/templates"),
  /**
   * Stream a generation. Yields parsed `{event, data}` pairs from the
   * bridge's SSE response. Throws on non-2xx (so the caller can show the
   * upstream error verbatim).
   */
  async *comfyuiGenerate(body: {
    template?: string;
    prompt: string;
    negative_prompt?: string;
    width?: number;
    height?: number;
    steps?: number;
    cfg?: number;
    seed?: number;
    filename_prefix?: string;
  }): AsyncGenerator<{ event: string; data: unknown }> {
    const r = await fetch("/api/agents/comfyui/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
    });
    if (!r.ok || !r.body) {
      let detail = `HTTP ${r.status}`;
      try {
        const j = await r.json();
        if (j?.detail) detail = JSON.stringify(j.detail);
      } catch {
        /* ignore */
      }
      throw new Error(`comfyui bridge: ${detail}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const blocks = buf.split("\n\n");
      buf = blocks.pop() ?? "";
      for (const block of blocks) {
        if (!block.trim()) continue;
        let ev = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        try {
          yield { event: ev, data: JSON.parse(data) };
        } catch {
          yield { event: ev, data };
        }
      }
    }
  },
  /**
   * Slash-command helper: POST /api/agents/comfyui/slash. Drains the SSE
   * server-side and returns base64-encoded images so the chat composer
   * can render them inline (the upstream image URLs point at a private
   * compute host the browser cannot reach).
   */
  comfyuiSlash: (body: {
    conversationId: string;
    prompt: string;
    template?: string;
    negative_prompt?: string;
    width?: number;
    height?: number;
    steps?: number;
    cfg?: number;
    seed?: number;
  }) =>
    request<{
      prompt_id: string | null;
      duration_s: number | null;
      bridge_url: string;
      template: string;
      images: Array<{ filename: string; mime: string; dataBase64: string }>;
      transcript_tail: Array<{ event: string; data: unknown }>;
    }>("/api/agents/comfyui/slash", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Parser add-on (Docling — parse documents to markdown before send)
  parserAddonInfo: () =>
    request<{
      addonId: string | null;
      enabled: boolean;
      url: string;
      pdfMode: "text" | "vision";
      maxUploadBytes: number;
      configured: boolean;
    }>("/api/addons/parser/info"),
  parserAddonSetConfig: (body: {
    enabled?: boolean;
    url?: string;
    pdfMode?: "text" | "vision";
    maxUploadBytes?: number;
  }) =>
    request<{
      ok: true;
      enabled: boolean;
      url: string;
      pdfMode: "text" | "vision";
      maxUploadBytes: number;
      configured: boolean;
    }>("/api/addons/parser/config", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  /** Upload a small file to the configured Docling endpoint to verify
   *  connectivity. Raw fetch (multipart) — `request` forces JSON. */
  async parserAddonTest(
    file: File,
  ): Promise<{
    ok: boolean;
    chars?: number;
    pages?: number;
    ms?: number;
    status?: number;
    error?: string;
  }> {
    const form = new FormData();
    form.append("file", file, file.name);
    const res = await fetch("/api/addons/parser/test", {
      method: "POST",
      body: form,
      credentials: "same-origin",
    });
    try {
      return (await res.json()) as {
        ok: boolean;
        chars?: number;
        pages?: number;
        ms?: number;
        status?: number;
        error?: string;
      };
    } catch {
      return { ok: false, error: `HTTP ${res.status}` };
    }
  },

  // Auto Router add-on (semantic routing via embeddings)
  routerInfo: () =>
    request<{
      addonId: string | null;
      enabled: boolean;
      configured: boolean;
      embeddingsUrl: string;
      embeddingsUrlDefault: string;
      embeddingsModel: string;
      policy: { chat: string; deep: string; code: string };
      policyDefault: { chat: string; deep: string; code: string };
      /** Model that answers when routing itself can't run (service down,
       *  add-on not configured). "" = none → the chat fails loud instead. */
      fallbackModel: string;
      anchorsBuiltAt: string | null;
    }>("/api/addons/router/info"),
  routerSetConfig: (body: {
    enabled?: boolean;
    embeddingsUrl?: string;
    embeddingsModel?: string | null;
    policy?: { chat: string; deep: string; code: string };
    /** "" / null clears the fallback (back to fail-loud). */
    fallbackModel?: string | null;
    rebuildAnchors?: boolean;
  }) =>
    request<{
      ok: true;
      enabled: boolean;
      configured: boolean;
      embeddingsUrl: string;
      embeddingsModel: string;
      policy: { chat: string; deep: string; code: string };
      fallbackModel: string;
      anchorsBuiltAt: string | null;
    }>("/api/addons/router/config", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  routerRebuild: () =>
    request<{ ok: true; anchorsBuiltAt: string }>(
      "/api/addons/router/rebuild",
      { method: "POST" },
    ),
  routerTest: (input: string) =>
    request<{
      label: "chat" | "deep" | "code";
      model: string;
      score: number;
      scores: { chat: number; deep: number; code: number };
      ms: number;
    }>("/api/addons/router/test", {
      method: "POST",
      body: JSON.stringify({ input }),
    }),

  // Voice add-on (local OpenAI-compatible TTS + ASR)
  voiceLiveInfo: () =>
    request<{
      addonId: string | null;
      enabled: boolean;
      provider: "local";
      ttsEndpoint: string;
      asrEndpoint: string;
      ttsModel: string;
      voice: string;
    }>("/api/addons/voice-live/info"),
  voiceLiveUpdateConfig: (
    body: Partial<{
      provider: "local";
      ttsEndpoint: string;
      asrEndpoint: string;
      ttsModel: string;
      voice: string;
    }>,
  ) =>
    request<{ ok: true }>("/api/addons/voice-live/config", {
      method: "PATCH",
      body: JSON.stringify(body),
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
    request<{ addonId: string | null; enabled: boolean }>(
      "/api/addons/admin-ext/info",
    ),

  // Users
  // Audit log
  listAuditLog: (params?: {
    limit?: number;
    offset?: number;
    userId?: string;
    event?: string;
    resourceType?: string;
    from?: string;
    to?: string;
  }) => {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    if (params?.userId) q.set("userId", params.userId);
    if (params?.event) q.set("event", params.event);
    if (params?.resourceType) q.set("resourceType", params.resourceType);
    if (params?.from) q.set("from", params.from);
    if (params?.to) q.set("to", params.to);
    const qs = q.toString();
    return request<{ entries: ApiAuditEntry[]; limit: number; offset: number }>(
      `/api/admin/audit${qs ? `?${qs}` : ""}`,
    );
  },
  auditExportUrl: (from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    const qs = q.toString();
    return `/api/admin/audit/export.csv${qs ? `?${qs}` : ""}` as const;
  },

  listAdminUsers: () =>
    request<{ users: ApiAdminUser[] }>("/api/admin/users"),

  getAdminSettings: () =>
    request<{ companyRagUrl: string; nemoDeployed: boolean }>(
      "/api/admin/settings",
    ),
  updateAdminSettings: (body: { companyRagUrl?: string }) =>
    request<{ ok: boolean; companyRagUrl: string }>("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  // ── Instance connection settings (0059, admin only) ────────────────────
  // The shared gateway / LiteLLM / default-model config every user inherits.
  getInstanceSettings: () =>
    request<ApiInstanceSettings>("/api/admin/instance-settings"),
  /**
   * Full replacement of the editable fields. Secrets are write-only: omit
   * `engineToken` / `litellmApiKey` to keep what's stored, pass null to
   * clear, pass a string to replace. (They're never returned, so there is
   * nothing to round-trip.)
   */
  updateInstanceSettings: (body: {
    engineUrl: string | null;
    engineMode: "gateway" | "hybrid" | "legacy";
    litellmUrl: string | null;
    litellmDisabled: boolean;
    defaultModel: string | null;
    engineToken?: string | null;
    litellmApiKey?: string | null;
  }) =>
    request<{ ok: true } & ApiInstanceSettings>(
      "/api/admin/instance-settings",
      { method: "PUT", body: JSON.stringify(body) },
    ),
  /** Lift the calling admin's own effective config onto the instance. */
  publishInstanceSettings: () =>
    request<{ ok: true } & ApiInstanceSettings>(
      "/api/admin/instance-settings/publish",
      { method: "POST" },
    ),
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
        token: string | null;
        label: string | null;
        convId: string | null;
        source: "hermes" | "cowork";
        expiresAt: string | null;
        revokedAt: string | null;
        lastUsedAt: string | null;
        createdAt: string;
      }>
    >("/api/agent-tokens"),
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
    }>("/api/agent-tokens", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revokeHermesToken: (id: string) =>
    request<{ ok: true }>(`/api/agent-tokens/${id}`, {
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

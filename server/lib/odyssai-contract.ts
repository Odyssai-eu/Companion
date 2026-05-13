/**
 * TypeScript types for the Odyssai capability contract.
 *
 * Spec: an engine that returns `vendor: "odyssai.eu"` from
 *   GET /.well-known/inference-engine.json
 * is considered Odyssai-compatible, and per-model capabilities are
 * exposed under `x_odyssai` in the OpenAI-shaped `GET /v1/models`.
 *
 * Companion uses these to replace heuristic capability detection
 * (regex on model id) with declared truth. When the field is absent
 * (provider doesn't speak the contract — Ollama, OpenAI direct, cloud
 * provider through LiteLLM), Companion falls back to the existing
 * heuristics.
 */

export type OdyssaiEngineMeta = {
  name: string;
  /** "odyssai.eu" marks the engine as contract-aware. */
  vendor: string;
  version: string;
  api_compat: string[];
  auth: {
    required: boolean;
    scheme: "bearer" | string;
    scope: string;
    public_routes: string[];
    eventsource_query_fallback?: boolean;
  };
  features: string[];
  limits?: {
    max_concurrent_requests?: number;
    max_prompt_chars?: number;
  };
  admin?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
};

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
  /** Set on entries where the id is a pool alias; points at the
   *  concrete model path that's currently loaded behind it. */
  alias_for?: string;
};

export type OdyssaiModelEntry = {
  id: string;
  object: "model";
  created?: number;
  owned_by?: string;
  /** Alias entries (e.g. id="argo") may carry x_concrete = full path. */
  x_concrete?: string;
  x_odyssai?: OdyssaiModelCapabilities;
};

export type OdyssaiModelList = {
  object: "list";
  data: OdyssaiModelEntry[];
};

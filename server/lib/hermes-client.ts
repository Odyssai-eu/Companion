import { and, eq } from "drizzle-orm";
import { db } from "../db/index";
import { addons } from "../db/schema";

const ADDON_NAME = "Hermes Agent";
const DEFAULT_BRIDGE = "http://192.168.86.44:8002";

type HermesConfig = {
  apiUrl?: string;
  selectedSkills?: string[];
  defaultModel?: string;
  autonomous?: boolean;
};

export type HermesBridgeSession = {
  id: string;
  mode: "quick" | "deep";
  prompt: string;
  model: string;
  skills: string[];
  yolo: boolean;
  status: "pending" | "running" | "done" | "failed" | string;
  output: string;
  error: string;
  exit_code: number | null;
  elapsed_ms: number | null;
};

export async function loadHermesConfig(userId: string): Promise<{
  bridgeUrl: string;
  defaultModel: string;
  selectedSkills: string[];
  autonomous: boolean;
} | null> {
  const [row] = await db
    .select({ enabled: addons.enabled, config: addons.config })
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (!row || !row.enabled) return null;
  const cfg = (row.config ?? {}) as HermesConfig;
  return {
    bridgeUrl: (cfg.apiUrl ?? process.env.HERMES_BRIDGE_URL ?? DEFAULT_BRIDGE).replace(
      /\/+$/,
      "",
    ),
    defaultModel: cfg.defaultModel ?? "claude-haiku",
    selectedSkills: cfg.selectedSkills ?? [],
    autonomous: cfg.autonomous ?? false,
  };
}

export async function startHermesSession({
  bridgeUrl,
  prompt,
  mode,
  model,
  skills,
  yolo,
  timeoutMs,
}: {
  bridgeUrl: string;
  prompt: string;
  mode: "quick" | "deep";
  model: string;
  skills: string[];
  yolo: boolean;
  timeoutMs: number;
}): Promise<HermesBridgeSession> {
  const r = await fetch(`${bridgeUrl}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, mode, model, skills, yolo }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`hermes_bridge_${r.status}: ${text.slice(0, 500)}`);
  }
  return (await r.json()) as HermesBridgeSession;
}


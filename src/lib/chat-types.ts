// Chat UI types that outlived the v1 rail. Formerly exported by
// stream-manager.ts (removed 2026-08-04 with the v1 streaming). Kept here
// because UIMessage still carries a Confidential Guard verdict (force-local
// banner) and a block verdict (switch-to-local prompt) — both surfaced by
// the v3 rail.

export type GuardWarning = {
  severity: "low" | "medium" | "high";
  findings: Array<{ category: string; severity: string; spans: string[] }>;
  forcedLocal: boolean;
  forcedModel: string | null;
  destinationLocal: boolean;
};

export type GuardBlock = {
  severity: "low" | "medium" | "high";
  findings: Array<{ category: string; severity: string; spans: string[] }>;
};

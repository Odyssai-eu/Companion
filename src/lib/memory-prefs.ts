// Per-device (per-workstation) preference: whether a NEW personal
// conversation starts with memory enabled.
//
// Stored in localStorage on purpose — it is LOCAL to the browser/machine,
// never synced to the account. Sophie can keep it ON on her MacBook and OFF
// on the workstation. The toggle lives in Settings → Profile.
//
// Scope: this only seeds the default for new *personal* conversations. Inside
// a project, memory is governed by the project settings and this toggle is
// ignored (see useChat.ts createConversation / toggleMemoryEnabled).
//
// Default = TRUE (memory ON by default for new chats — CodeOS parity,
// 2026-08-03). Only an explicit OFF in Settings → Profile disables it.

const KEY = "companion:memoryDefaultNewConv";

export function getMemoryDefaultNewConv(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(KEY) !== "false";
}

export function setMemoryDefaultNewConv(enabled: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, enabled ? "true" : "false");
}

// Same per-device pattern for agent mode (tools). Default = TRUE
// (CodeOS parity, 2026-08-05) — only an explicit OFF disables it.
const AGENT_KEY = "companion:agentDefaultNewConv";

export function getAgentDefaultNewConv(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(AGENT_KEY) !== "false";
}

export function setAgentDefaultNewConv(enabled: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AGENT_KEY, enabled ? "true" : "false");
}

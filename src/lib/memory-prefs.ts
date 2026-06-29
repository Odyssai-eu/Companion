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
// Default = false (memory off by default for new chats).

const KEY = "companion:memoryDefaultNewConv";

export function getMemoryDefaultNewConv(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(KEY) === "true";
}

export function setMemoryDefaultNewConv(enabled: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, enabled ? "true" : "false");
}

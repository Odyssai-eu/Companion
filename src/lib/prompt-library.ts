// Tiny localStorage-backed library for named system prompts.
// Mirrors ExoScopy's "exoscopy-system-prompts" feature so power users can
// switch between a handful of personas without retyping everything.

const KEY = "companion:systemPrompts";

export type StoredPrompt = {
  id: string;
  name: string;
  content: string;
  updatedAt: string;
};

function load(): StoredPrompt[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as StoredPrompt[];
  } catch {
    // ignore corruption
  }
  return [];
}

function save(prompts: StoredPrompt[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(prompts));
}

export const promptLibrary = {
  list: () => load(),

  add(name: string, content: string): StoredPrompt {
    const list = load();
    const item: StoredPrompt = {
      id: crypto.randomUUID(),
      name: name.trim() || "Untitled",
      content,
      updatedAt: new Date().toISOString(),
    };
    save([item, ...list]);
    return item;
  },

  update(id: string, patch: Partial<Pick<StoredPrompt, "name" | "content">>) {
    const list = load();
    const next = list.map((p) =>
      p.id === id
        ? { ...p, ...patch, updatedAt: new Date().toISOString() }
        : p,
    );
    save(next);
  },

  remove(id: string) {
    save(load().filter((p) => p.id !== id));
  },

  exportJson(): string {
    return JSON.stringify(load(), null, 2);
  },

  importJson(text: string): number {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return 0;
    }
    if (!Array.isArray(parsed)) return 0;
    const incoming = parsed.filter(
      (p): p is StoredPrompt =>
        !!p &&
        typeof p === "object" &&
        typeof (p as StoredPrompt).name === "string" &&
        typeof (p as StoredPrompt).content === "string",
    );
    if (incoming.length === 0) return 0;
    const existing = load();
    // Merge by content equality to avoid double imports
    const seen = new Set(existing.map((p) => `${p.name}::${p.content}`));
    const merged = [...existing];
    for (const p of incoming) {
      const key = `${p.name}::${p.content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.unshift({
        id: p.id || crypto.randomUUID(),
        name: p.name,
        content: p.content,
        updatedAt: p.updatedAt || new Date().toISOString(),
      });
    }
    save(merged);
    return incoming.length;
  },

  /**
   * Skills v1 (DB-backed) deprecates this client-only store. After the
   * one-shot migration (InferencePanel runs it on first mount) we wipe
   * the localStorage entry so the legacy library doesn't shadow the
   * server-side state if the user adds prompts on another device.
   */
  markMigrated() {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      // ignore — quota / private mode
    }
  },
};

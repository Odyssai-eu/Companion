/**
 * Lightweight pub-sub for `file_changed` events emitted by the chat SSE
 * layer when the LLM mutates a workspace file via fs_write / fs_edit.
 *
 * The chat stream parser (useChat) calls `emitFileChanged(path)` whenever
 * it sees the `_event: "file_changed"` SSE chunk. The FilesPage hook
 * (useWorkspaceFiles) subscribes via `onFileChanged()` to refresh.
 *
 * Pure in-memory channel — no cross-tab support in v1.
 */

type Listener = (path: string) => void;

const listeners = new Set<Listener>();

export function emitFileChanged(path: string): void {
  for (const fn of listeners) {
    try {
      fn(path);
    } catch {
      // ignore listener errors
    }
  }
}

export function onFileChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * useWorkspaceFiles — list + stats for the user's workspace.
 *
 * Auto-refresh on `file_changed` events broadcast by the chat SSE layer
 * (see src/lib/file-events.ts) so the UI stays in sync when the LLM
 * mutates a file via fs_write / fs_edit.
 */

import { useCallback, useEffect, useState } from "react";
import {
  api,
  type ApiWorkspaceFile,
  type ApiWorkspaceStats,
} from "~/lib/api";
import { onFileChanged } from "~/lib/file-events";

export function useWorkspaceFiles(prefix?: string) {
  const [entries, setEntries] = useState<ApiWorkspaceFile[]>([]);
  const [stats, setStats] = useState<ApiWorkspaceStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listFiles(prefix);
      setEntries(data.entries);
      setStats(data.stats);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [prefix]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Listen for file_changed events from the chat stream.
  useEffect(() => {
    const off = onFileChanged(() => {
      refresh();
    });
    return off;
  }, [refresh]);

  return { entries, stats, loading, error, refresh };
}

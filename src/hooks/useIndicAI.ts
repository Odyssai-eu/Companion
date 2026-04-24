import { useEffect, useState } from "react";
import { api } from "~/lib/api";

export type IndicAI = {
  level: number;
  label: string;
  progress: number;
  metrics: {
    conversations: number;
    userMessages: number;
    distinctModels: number;
    projects: number;
    projectsWithPrompt: number;
    activeAddons: number;
  };
};

export function useIndicAI() {
  const [data, setData] = useState<IndicAI | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const r = await api.getIndicAI();
        if (!cancelled) setData(r);
      } catch {
        // ignore
      }
    }
    refresh();
    const i = setInterval(refresh, 20_000);
    return () => {
      cancelled = true;
      clearInterval(i);
    };
  }, []);

  return data;
}

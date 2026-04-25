import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "thecompai:voiceMode";

export function useVoiceMode() {
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
    window.dispatchEvent(new CustomEvent("thecompai:voicemode-change"));
  }, [enabled]);

  // Cross-component sync (TopBar toggles, Messages reads)
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onChange() {
      setEnabled(window.localStorage.getItem(STORAGE_KEY) === "1");
    }
    window.addEventListener("thecompai:voicemode-change", onChange);
    return () =>
      window.removeEventListener("thecompai:voicemode-change", onChange);
  }, []);

  const toggle = useCallback(() => setEnabled((v) => !v), []);

  return { enabled, toggle, setEnabled };
}

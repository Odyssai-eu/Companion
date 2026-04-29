import { useEffect, useState } from "react";

/**
 * Responsive hook — detects mobile viewport (< 768px by default).
 *
 * Ported from ExoScopy's single-file `useIsMobile`. Listens to window resize
 * and updates whenever the viewport crosses the breakpoint. Safe in SSR (the
 * lazy initializer guards against missing `window`).
 */
export function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== "undefined" && window.innerWidth < breakpoint,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [breakpoint]);
  return isMobile;
}

export default useIsMobile;

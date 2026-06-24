import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * usePiSession — keeps the Pi (omp) terminal iframe ALIVE across navigation.
 *
 * The iframe is mounted ONCE, at the App level (see <PiTerminalHost> in
 * main.tsx), OUTSIDE the router. Switching conversations or pages therefore
 * never unmounts it — which previously dropped the ttyd connection and killed
 * the omp process, so returning to the Pi chat showed a fresh, blank terminal.
 *
 * - `mounted` flips true on first activation and stays true until an explicit
 *   exit, so the iframe — and the live omp session — survives hide/show cycles.
 * - `visible` mirrors "the conversation on screen is in /pi mode"; the host
 *   toggles `display` on it, never unmounts.
 * - `show` carries an `onExit` so the host's quit button can end the agent
 *   session on the right conversation (it's re-supplied every time we enter
 *   the Pi chat, so it never goes stale).
 */
type PiSessionState = {
  bridgeUrl: string;
  visible: boolean;
  mounted: boolean;
  /** Enter/return to /pi mode: mount (once) + show, with the ttyd URL and the
   *  current conversation's exit handler. */
  show: (url: string, onExit: () => void) => void;
  /** Leave the Pi chat (switch chat/page): hide but keep the session alive. */
  hide: () => void;
  /** Explicit quit: run the exit handler (clears activeAgent on the
   *  conversation) and tear the iframe down, ending the omp session. */
  requestExit: () => void;
};

const Ctx = createContext<PiSessionState | null>(null);

export function PiSessionProvider({ children }: { children: React.ReactNode }) {
  const [bridgeUrl, setBridgeUrl] = useState("");
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const onExitRef = useRef<(() => void) | null>(null);

  const show = useCallback((url: string, onExit: () => void) => {
    setBridgeUrl(url);
    onExitRef.current = onExit;
    setMounted(true);
    setVisible(true);
  }, []);

  const hide = useCallback(() => setVisible(false), []);

  const requestExit = useCallback(() => {
    onExitRef.current?.();
    onExitRef.current = null;
    setVisible(false);
    setMounted(false);
  }, []);

  const value = useMemo<PiSessionState>(
    () => ({ bridgeUrl, visible, mounted, show, hide, requestExit }),
    [bridgeUrl, visible, mounted, show, hide, requestExit],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePiSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePiSession must be used inside <PiSessionProvider>");
  return v;
}

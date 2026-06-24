import { usePiSession } from "~/hooks/usePiSession";

/**
 * PiTerminalHost — the single, persistent ttyd iframe for the Pi (omp)
 * terminal. Mounted ONCE at the App level (outside <Routes>, see main.tsx)
 * so route changes never unmount it: the ttyd connection — and the live omp
 * process — stay up while the user browses other chats, then the SAME session
 * is revealed on return instead of a fresh, blank omp.
 *
 * Shown as an overlay over the chat column, offset by the 280px sidebar on
 * desktop so the sidebar stays clickable for navigation. We toggle `display`
 * via `visible` rather than conditionally rendering, so the iframe DOM — and
 * its socket — is preserved while hidden. Full height gives omp the room the
 * old fixed `h-[70vh]` inline panel couldn't.
 */
export function PiTerminalHost() {
  const pi = usePiSession();
  // Don't connect ttyd until the user has actually entered /pi at least once.
  if (!pi.mounted || !pi.bridgeUrl) return null;

  return (
    <div
      className="fixed inset-y-0 right-0 left-0 z-30 flex flex-col bg-[#0d1117] font-mono text-gray-200 md:left-[280px]"
      style={{ display: pi.visible ? "flex" : "none" }}
      role="dialog"
      aria-label="Pi terminal"
    >
      <div className="flex items-center justify-between border-b border-gray-800 bg-[#161b22] px-4 py-2">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-400" />
          <span className="text-[11px] font-semibold tracking-wide text-gray-100">
            Pi
          </span>
          <span className="text-[10px] text-gray-500">
            terminal · tape directement · session vivante entre les chats
          </span>
        </span>
        <button
          type="button"
          onClick={pi.requestExit}
          className="text-[10px] text-gray-400 hover:text-gray-100"
          title="Quitter Pi (termine la session omp)"
        >
          × quitter
        </button>
      </div>
      <iframe
        title="Pi terminal"
        src={pi.bridgeUrl}
        className="min-h-0 w-full flex-1 border-0 bg-[#0d1117]"
      />
    </div>
  );
}

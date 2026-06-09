/**
 * HermesPanel — embeds the (shared, enterprise) Hermes Agent TUI in Companion
 * via an iframe pointed at the Hermes web dashboard. Same approach as PiPanel:
 * render Hermes' own web chat as-is rather than reinterpreting ACP events
 * client-side. The dashboard runs in embedded-chat mode (one shared session —
 * "le même pour tout le monde"), so every user sees the same enterprise Hermes.
 *
 * The iframe URL comes from the Hermes Agent add-on config (bridgeUrl),
 * typically `http://<hermes-host>:9119` where `hermes dashboard` is serving.
 */

type Props = {
  /** Hermes dashboard URL — usually http://<host>:9119 */
  url: string;
  /** Show a top-right close button that calls onExit */
  onExit?: () => void;
};

export function HermesPanel({ url, onExit }: Props) {
  return (
    <div className="mx-auto my-4 w-full max-w-5xl overflow-hidden rounded-lg border border-gray-800 bg-[#0d1117] font-mono text-[12.5px] text-gray-200 shadow-lg">
      <div className="flex items-center justify-between border-b border-gray-800 bg-[#161b22] px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <span className="text-[11px] font-semibold tracking-wide text-gray-100">
              Hermes
            </span>
          </span>
          <span className="text-[10px] text-gray-500">
            agent d'entreprise · tape directement dans la fenêtre
          </span>
        </div>
        {onExit && (
          <button
            type="button"
            onClick={onExit}
            className="text-[10px] text-gray-500 hover:text-gray-200"
            title="Sortir du mode Hermes (revient au chat normal)"
          >
            × exit
          </button>
        )}
      </div>
      <iframe
        title="Hermes agent"
        src={url}
        className="block h-[72vh] w-full border-0 bg-[#0d1117]"
        allow="clipboard-read; clipboard-write; microphone"
      />
    </div>
  );
}

/**
 * PiPanel — embeds the Pi coding-agent TUI in Companion via an iframe
 * pointed at a ttyd instance running on the Pi host. We render Pi's
 * native terminal experience as-is rather than reinterpreting its
 * events client-side.
 *
 * The iframe URL comes from the Pi Agent add-on config (bridgeUrl).
 * Typically `http://<pi-host>:7681` where ttyd is exposing
 * `tmux attach -t pi`.
 */

type Props = {
  /** ttyd URL — usually http://<host>:7681 */
  url: string;
  /** Show a top-right close button that calls onExit */
  onExit?: () => void;
};

export function PiPanel({ url, onExit }: Props) {
  return (
    <div className="mx-auto my-4 w-full max-w-5xl overflow-hidden rounded-lg border border-gray-800 bg-[#0d1117] font-mono text-[12.5px] text-gray-200 shadow-lg">
      <div className="flex items-center justify-between border-b border-gray-800 bg-[#161b22] px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <span className="text-[11px] font-semibold tracking-wide text-gray-100">
              Pi
            </span>
          </span>
          <span className="text-[10px] text-gray-500">
            terminal · tape directement dans la fenêtre
          </span>
        </div>
        {onExit && (
          <button
            type="button"
            onClick={onExit}
            className="text-[10px] text-gray-500 hover:text-gray-200"
            title="Sortir du mode Pi (revient au chat normal)"
          >
            × exit
          </button>
        )}
      </div>
      <iframe
        title="Pi terminal"
        src={url}
        className="block h-[70vh] w-full border-0 bg-[#0d1117]"
      />
    </div>
  );
}

import { api } from "~/lib/api";
import { BridgeAddonPanel } from "./BridgeAddonPanel";

export function HermesAddonPanel() {
  return (
    <BridgeAddonPanel
      urlPlaceholder="http://127.0.0.1:8013"
      load={() => api.hermesAddonInfo()}
      save={(body) => api.hermesAddonSetConfig(body)}
      probe={() => api.hermesAddonProbe()}
    >
      <details className="rounded-md border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-600">
        <summary className="cursor-pointer font-medium text-ink">
          How the Hermes bridge works
        </summary>
        <p className="mt-3 leading-relaxed">
          Type <code className="rounded bg-gray-100 px-1 font-mono">/hermes</code>{" "}
          in chat to open an agent sub-thread. Companion forwards your prompt
          to the bridge running on your machine, which drives the Hermes
          coding agent and streams its turns back.
        </p>
      </details>
    </BridgeAddonPanel>
  );
}

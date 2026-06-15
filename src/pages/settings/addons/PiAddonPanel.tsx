import { api } from "~/lib/api";
import { BridgeAddonPanel } from "./BridgeAddonPanel";

export function PiAddonPanel() {
  return (
    <BridgeAddonPanel
      urlPlaceholder="http://127.0.0.1:8014"
      withCwd
      load={() => api.piAddonInfo()}
      save={(body) => api.piAddonSetConfig(body)}
      probe={() => api.piAddonProbe()}
    >
      <details className="rounded-md border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-600">
        <summary className="cursor-pointer font-medium text-ink">
          How the Pi bridge works
        </summary>
        <p className="mt-3 leading-relaxed">
          Type <code className="rounded bg-gray-100 px-1 font-mono">/pi</code>{" "}
          in chat to open a Pi coding-agent sub-thread. The bridge wraps the{" "}
          <code className="rounded bg-gray-100 px-1 font-mono">pi</code> CLI on
          its host and can read, write, edit files and run shell commands in
          the working directory above.
        </p>
      </details>
    </BridgeAddonPanel>
  );
}

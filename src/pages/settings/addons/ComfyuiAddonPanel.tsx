import { api } from "~/lib/api";
import { BridgeAddonPanel } from "./BridgeAddonPanel";

/**
 * ComfyUI Imager add-on panel.
 *
 * Scope: setup only. Configures the bridge URL + token, exposes a probe
 * button. Generation happens elsewhere — the chat route is the natural
 * surface:
 *   - Slash command `/comfyui <prompt>` opens an agent sub-thread.
 *   - The LLM can call the `comfyui_generate` tool itself when it decides
 *     an image would materially help the answer (returns base64 PNGs
 *     that the chat renders inline).
 *
 * Anything more than setup here would muddle two very different flows:
 *   - Setup (admin, infrequent): URL, token, probe.
 *   - Generation (creative, daily): chat-driven, where the prompt +
 *     model context already live.
 */
export function ComfyuiAddonPanel() {
  return (
    <BridgeAddonPanel
      urlPlaceholder="http://192.168.86.141:8008"
      load={() => api.comfyuiAddonInfo()}
      save={(body) => api.comfyuiAddonSetConfig(body)}
      probe={() => api.comfyuiAddonProbe()}
    >
      <details className="rounded-md border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-600">
        <summary className="cursor-pointer font-medium text-ink">
          How the ComfyUI Imager bridge works
        </summary>
        <p className="mt-3 leading-relaxed">
          Companion forwards every generation to the{" "}
          <code className="rounded bg-gray-100 px-1 font-mono">
            OdyssAI-Imager
          </code>{" "}
          FastAPI bridge running on your Docker host. The bridge SSHes
          to the compute host (currently <code>.42</code>), talks to a
          running ComfyUI server, and streams progress back as SSE.
          Templates currently exposed:{" "}
          <code className="rounded bg-gray-100 px-1 font-mono">
            flux1-schnell-t2i-v1
          </code>{" "}
          (4 steps, fast) and{" "}
          <code className="rounded bg-gray-100 px-1 font-mono">
            flux1-dev-t2i-v1
          </code>{" "}
          (20 steps, full quality). More templates — including video —
          coming in later PRs.
        </p>
        <p className="mt-3 leading-relaxed">
          <strong className="text-ink">How to generate</strong>: type{" "}
          <code className="rounded bg-gray-100 px-1 font-mono">
            /comfyui &lt;your prompt&gt;
          </code>{" "}
          in any chat, or let the model call{" "}
          <code className="rounded bg-gray-100 px-1 font-mono">
            comfyui_generate
          </code>{" "}
          on its own when an image would help the answer.
        </p>
      </details>
    </BridgeAddonPanel>
  );
}

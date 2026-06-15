/**
 * Chat tool/caps/header resolution — extracted from chat.ts (issue #31).
 *
 * Owns the "model-caps + tool-routing + probe-routing + headers" phase of the
 * /completions handler: pull the model's Odyssai capability snapshot, gate tool
 * resolution on agent-mode / intent, run the §9.2 code-gen tool-strip, decide
 * probe routing (mutating baseBody.model), and assemble the upstream headers.
 *
 * No behaviour change — the body below is byte-identical to the span it
 * replaced in chat.ts; only the args destructure + the return wrap were added.
 */

import {
  modelSupportsTools,
  getModelCaps,
} from "./model-policy";
import {
  alwaysOnTools,
  selectToolsForIntent,
  getToolDefs,
  toolsForUser,
} from "./tools";
import { loadRouterConfigForUser } from "../routes/addon-router";
import { detectToolIntent } from "./semantic-router";
import { authHeaders } from "./litellm";
import type { ChatBody } from "../routes/chat";
import type { GuestTokenContext } from "./guest-token";
import type { OdyssaiModelCapabilities } from "./odyssai-contract";

// ── Code-generation gate (issue #9.2) ─────────────────────────────────────
// A code-GENERATION request ("écris un script X.py", "write a function", a
// ```fence```, or a source-file extension near a code verb) wants the code IN
// THE REPLY — not an fs_write/bash tool call. Eager tool-callers (MiniMax-M3,
// Qwen3) otherwise emit a tool call instead of the code, and the user gets a
// file-write invocation where they asked for a snippet. We strip the FS/exec
// tools for these prompts when agent-mode is OFF (explicit agent mode keeps
// them — the user opted in). This sits AFTER tool selection so it gates both
// the semantic router and the regex fallback. See OdyssAI-X integration report
// §9.2. NB: Unicode-aware boundaries (\p{L}) so the FR "Écris" matches — JS \b
// is ASCII-only and would miss accented verbs.
const CODE_GEN_EXT = /\.(py|js|ts|tsx|jsx|swift|c|cc|cpp|h|hpp|rs|go|java|rb|sh|bash|sql|kt|php|scala|lua|cs)\b/i;
const CODE_GEN_VERB =
  /(?<!\p{L})(write|create|generate|génère|genere|écris|ecris|implement|implémente|implemente|refactor|debug|coder?|fix)(?!\p{L})/giu;
const CODE_GEN_NOUN =
  /(?<!\p{L})(script|function|fonction|class|classe|program|programme|module|cli|snippet|code|method|méthode|endpoint|component|composant)(?!\p{L})/iu;

function isCodeGenRequest(text: string): boolean {
  if (!text) return false;
  if (text.includes("```")) return true;          // prompt ships/asks for code
  if (CODE_GEN_EXT.test(text)) return true;        // names a source file
  // code verb with a code noun within ~40 chars (avoids an incidental
  // "function" far from a "write" — e.g. the Bruit-Blanc JSON's key).
  CODE_GEN_VERB.lastIndex = 0;
  let mm: RegExpExecArray | null;
  while ((mm = CODE_GEN_VERB.exec(text))) {
    const w = text.slice(Math.max(0, mm.index - 40), mm.index + mm[0].length + 40);
    if (CODE_GEN_NOUN.test(w)) return true;
  }
  return false;
}

function toolFnName(t: unknown): string {
  return (t as { function?: { name?: string } })?.function?.name ?? "";
}

export async function resolveChatTools(args: {
  userRow: { engineUrl: string | null; engineToken: string | null };
  body: ChatBody;
  convAgentMode: boolean;
  guest: GuestTokenContext | undefined;
  userId: string;
  effectiveMode: string;
  baseBody: Record<string, unknown>;
  target: { baseUrl: string; apiKey: string | null };
}): Promise<{
  modelCaps: OdyssaiModelCapabilities | null;
  supportsTools: boolean;
  tools: unknown[];
  toolsEnabled: boolean;
  agentToolsEnabled: boolean;
  headers: Record<string, string>;
}> {
  const { userRow, body, convAgentMode, guest, userId, effectiveMode, baseBody, target } = args;

  // Tool add-ons: when enabled (and the model is tool-capable), the chat
  // route forwards tools so the model can decide when to call them. Each
  // add-on contributes its own tools — see toolsForUser.
  //
  // exo's MLX runner currently aborts (SIGABRT) when handed a `tools:`
  // param even for tool-trained models, so we whitelist by model name.
  // Tool gating: resolve tools whenever the model supports the OpenAI
  // tools field. toolsForUser() reads from every source (fs_*, RAG,
  // web search, MCP servers, …) and returns an empty array when
  // nothing is enabled — so the call is cheap when there's nothing
  // to expose.
  // Pull the model's Odyssai capability snapshot once — we need
  // supports_tools (gating tool resolution) AND backend/pool (gating
  // the stream vs. non-stream upstream decision below).
  const modelCaps = await getModelCaps(
    userRow.engineUrl,
    userRow.engineToken,
    body.model!,
  );
  const supportsTools = modelCaps
    ? modelCaps.supports_tools !== false
    : modelSupportsTools(body.model!);
  // Tools are gated on per-conv `agentMode`. Default is OFF — a normal
  // chat does NOT inject any FS/RAG/Web/MCP tool defs (~250 tok prompt
  // instead of 1000+). The "always-on" tools (skill_*) used to be
  // injected on every chat so the user could ask the assistant to
  // curate skills from any conversation, but in practice models like
  // MiniMax / Qwen3.5 see the tools on a bare "hello" and loop on
  // skill_list → skill_get → … until Companion bails out (chat.ts:910)
  // with the "kept asking to call tools" fallback. Gate them on
  // `agentMode` too unless the operator explicitly opts in via env.
  const isGuest = !!guest;
  // Guests are scoped to chat only — no tools regardless of agent-mode or
  // ALWAYS_ON_TOOLS. executeTool runs with userId = inviting admin, so
  // exposing tools would let a guest drive skill/fs/mcp ops as the admin.
  const alwaysOnEnabled = !isGuest && supportsTools &&
    (convAgentMode || process.env.ALWAYS_ON_TOOLS === "1");
  const alwaysOn = alwaysOnEnabled ? alwaysOnTools() : [];

  // ── Automatic tool routing ───────────────────────────────────────────
  // Detect which tools the user's last message needs WITHOUT requiring the
  // agent-mode toggle. selectToolsForIntent() pattern-matches the message
  // and returns only the relevant tool definitions (~50–100 tokens each)
  // instead of injecting ALL tools (~1000+ tokens). This runs in <1ms.
  //
  // Three tiers:
  //   1. convAgentMode ON → inject all tools (full agent mode, user explicit)
  //   2. intent detected → inject only the detected tools (auto, no toggle)
  //   3. neither         → no tools (pure chat, ~250 tok saving)
  //
  // Tier 2 detection is two-stage:
  //   a. Semantic — if the router add-on is configured, embed the message
  //      and compare against per-tool centroids (language-agnostic, robust).
  //   b. Pattern — regex fallback when the router isn't configured. English-
  //      biased, brittle on FR phrasing, but free (no embed call).
  const lastMsg = body.messages?.filter((m: {role:string}) => m.role === "user").at(-1);
  const lastMsgText = typeof lastMsg?.content === "string" ? lastMsg.content : "";

  let agentTools: unknown[];
  if (!isGuest && supportsTools) {
    if (convAgentMode) {
      // Full agent mode — all tools
      agentTools = await toolsForUser(userId);
    } else {
      // Auto-detect — semantic first, regex fallback.
      let detected: unknown[] | null = null;
      try {
        const routerCfg = await loadRouterConfigForUser(userId);
        if (routerCfg?.embeddingsUrl && lastMsgText.trim()) {
          const intent = await detectToolIntent(lastMsgText.slice(0, 2000), routerCfg);
          if (intent.tools.length > 0) {
            detected = getToolDefs(intent.tools);
            console.log(
              "[chat] semantic tool intent → %s (%dms)",
              intent.tools.join(","),
              intent.ms,
            );
          } else {
            detected = []; // semantic ran, found nothing → trust it, no tools
          }
        }
      } catch (e) {
        console.warn("[chat] semantic tool detection failed, regex fallback:", (e as Error).message);
        detected = null; // fall through to regex
      }
      agentTools = detected ?? selectToolsForIntent(lastMsgText) ?? [];
    }
  } else {
    agentTools = [];
  }

  // §9.2: a code-GENERATION request wants the code in the reply, not an
  // fs_write/bash tool call. Strip FS/exec tools for code-gen prompts when
  // agent-mode is OFF (gates both the semantic router and the regex fallback).
  if (!convAgentMode && agentTools.length > 0 && isCodeGenRequest(lastMsgText)) {
    const before = agentTools.length;
    agentTools = agentTools.filter((t) => {
      const n = toolFnName(t);
      return !n.startsWith("fs_") && n !== "bash";
    });
    if (agentTools.length !== before) {
      console.log(
        "[chat] code-gen request → stripped %d FS/exec tool(s)",
        before - agentTools.length,
      );
    }
  }

  const tools = [...alwaysOn, ...agentTools];
  const toolsEnabled = tools.length > 0;
  // `agentToolsEnabled` = real agent-mode tools (FS/RAG/Web/MCP) — the
  // ones that trigger the XML tool-call leak on Qwen3/Hy3 streaming.
  // Skill tools alone don't warrant forcing non-stream because the model
  // only calls them on explicit user request (rare, not mid-response).
  // Without this distinction, every chat would non-stream on jaccl,
  // which kills TTFT on slow models like GLM-5.1 4-node.
  const agentToolsEnabled = agentTools.length > 0;

  // Probe routing — gateway mode only. If this request looks like a
  // probe (small max_tokens, no tools), route it to OdyssAI-X' `probe`
  // alias (Qwen2.5-Coder-1.5B on the autocomplete host) instead of letting it hit
  // Argo / Hades 3-node MLX which is wildly overprovisioned for 1-20
  // tokens of output. ~4× faster, frees the heavy cluster for real
  // responses. See BRIEF-companion-prefix-cache-and-probes.md.
  //
  // Skipped for hybrid/legacy modes (the `probe` alias is published
  // by OdyssAI-X only — LiteLLM won't know it). Probe routing tolerates
  // the always-on skill tools in the request (the probe model just
  // ignores them); only real agent-mode tools disqualify probe routing.
  if (
    effectiveMode === "gateway" &&
    !agentToolsEnabled &&
    typeof baseBody.max_tokens === "number" &&
    baseBody.max_tokens <= 20 &&
    body.model !== "probe"
  ) {
    console.log(
      "[chat] routing probe → 'probe' (max_tokens=%d, original=%s)",
      baseBody.max_tokens,
      body.model,
    );
    baseBody.model = "probe";
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...authHeaders(target),
  };

  return { modelCaps, supportsTools, tools, toolsEnabled, agentToolsEnabled, headers };
}

import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import InferencePanel from "~/components/chat/InferencePanel";
import Input from "~/components/chat/Input";
import Messages from "~/components/chat/Messages";
import Sidebar from "~/components/chat/Sidebar";
import TopBar, { type ChatStyle } from "~/components/chat/TopBar";
import { STYLE_PRESETS, useChat } from "~/hooks/useChat";
import { useGlobalShortcuts } from "~/hooks/useGlobalShortcuts";
import { useVoiceMode } from "~/hooks/useVoiceMode";
import { voiceInput } from "~/lib/voice-input";

export default function ChatLayout() {
  const { id } = useParams<{ id?: string }>();
  const chat = useChat({ conversationId: id });
  const [style, setStyle] = useState<ChatStyle>("Normal");
  const [panelOpen, setPanelOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const navigate = useNavigate();
  const voiceMode = useVoiceMode();

  useGlobalShortcuts({
    onNewChat: () => navigate("/"),
    onFocusSearch: () => {
      // Focus the sidebar search input by selector — simpler than threading
      // a ref through props.
      const el = document.querySelector<HTMLInputElement>(
        'aside input[placeholder="Search conversations"]',
      );
      el?.focus();
      el?.select();
    },
    onStop: () => {
      if (chat.sending) chat.cancel();
    },
    onToggleVoiceMode: () => voiceMode.toggle(),
    onOpenSettings: () => navigate("/settings/servers"),
    onPushToTalkChange: (active) => {
      if (active) {
        voiceInput.start((text) => {
          if (text) chat.sendMessage(text, []);
        });
      } else {
        voiceInput.stop();
      }
    },
  });

  function onStyleChange(next: ChatStyle) {
    setStyle(next);
    // Creative / Normal / Code each have a preset; apply it.
    // Custom leaves the values alone — the user tweaks them directly.
    if (next !== "Custom" && STYLE_PRESETS[next]) {
      chat.setInference(STYLE_PRESETS[next]);
    }
    // Open the inference panel when the user lands on Custom so they can tune.
    if (next === "Custom") setPanelOpen(true);
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar
        activeConversationId={id ?? null}
        // ExoScopy parity: when chatting inside a conversation that belongs
        // to a project, the sidebar narrows to that project's conversations.
        // When at the root chat (no projectId on the loaded conversation), we
        // show only orphans.
        activeProjectId={chat.conversation?.projectId ?? null}
        streamingConversationId={chat.sending ? id ?? null : null}
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
      />
      <main className="flex flex-1 flex-col bg-gray-50">
        <TopBar
          activeServer={chat.activeServer}
          modelSelection={chat.modelSelection}
          onModelChange={chat.setModelSelection}
          activeStyle={style}
          onStyleChange={onStyleChange}
          onTogglePanel={() => setPanelOpen((v) => !v)}
          panelOpen={panelOpen}
          onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
        />
        {panelOpen && (
          <InferencePanel
            params={chat.inference}
            onChange={(patch) => {
              chat.setInference(patch);
              // Any manual tweak drops you out of a named preset into Custom
              setStyle("Custom");
            }}
            onClose={() => setPanelOpen(false)}
          />
        )}
        <Messages
          messages={chat.messages}
          error={chat.error}
          onRegenerate={chat.regenerate}
          onEdit={chat.editAndResend}
        />
        <Input
          onSend={chat.sendMessage}
          onCancel={chat.cancel}
          sending={chat.sending}
          disabled={!chat.activeServer}
          placeholder={
            chat.activeServer
              ? `Ask ${chat.activeServer.name}…`
              : "Add a server first"
          }
          modelHasVision={chat.activeModelCapabilities.vision}
        />
      </main>
    </div>
  );
}

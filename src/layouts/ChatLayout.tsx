import { useState } from "react";
import { useParams } from "react-router";
import InferencePanel from "~/components/chat/InferencePanel";
import Input from "~/components/chat/Input";
import Messages from "~/components/chat/Messages";
import Sidebar from "~/components/chat/Sidebar";
import TopBar, { type ChatStyle } from "~/components/chat/TopBar";
import { STYLE_PRESETS, useChat } from "~/hooks/useChat";

export default function ChatLayout() {
  const { id } = useParams<{ id?: string }>();
  const chat = useChat({ conversationId: id });
  const [style, setStyle] = useState<ChatStyle>("Normal");
  const [panelOpen, setPanelOpen] = useState(false);

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
      <Sidebar activeConversationId={id ?? null} />
      <main className="flex flex-1 flex-col bg-gray-50">
        <TopBar
          activeServer={chat.activeServer}
          modelSelection={chat.modelSelection}
          onModelChange={chat.setModelSelection}
          activeStyle={style}
          onStyleChange={onStyleChange}
          onTogglePanel={() => setPanelOpen((v) => !v)}
          panelOpen={panelOpen}
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
        <Messages messages={chat.messages} error={chat.error} />
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
        />
      </main>
    </div>
  );
}

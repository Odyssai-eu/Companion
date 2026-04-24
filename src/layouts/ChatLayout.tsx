import { useEffect, useState } from "react";
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

  function onStyleChange(next: ChatStyle) {
    setStyle(next);
    if (next !== "Inference" && STYLE_PRESETS[next]) {
      chat.setInference(STYLE_PRESETS[next]);
    }
  }

  useEffect(() => {
    // Close inference panel when style changes away
    if (style !== "Inference") return;
  }, [style]);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar activeConversationId={id ?? null} />
      <main className="flex flex-1 flex-col bg-gray-50">
        <TopBar
          activeServer={chat.activeServer}
          model={chat.model}
          onModelChange={chat.setModel}
          activeStyle={style}
          onStyleChange={onStyleChange}
        />
        {style === "Inference" && (
          <InferencePanel
            params={chat.inference}
            onChange={chat.setInference}
            onClose={() => setStyle("Normal")}
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

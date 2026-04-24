import { useParams } from "react-router";
import Input from "~/components/chat/Input";
import Messages from "~/components/chat/Messages";
import Sidebar from "~/components/chat/Sidebar";
import TopBar from "~/components/chat/TopBar";
import { useChat } from "~/hooks/useChat";

export default function ChatLayout() {
  const { id } = useParams<{ id?: string }>();
  const chat = useChat({ conversationId: id });
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar activeConversationId={id ?? null} />
      <main className="flex flex-1 flex-col bg-gray-50">
        <TopBar
          activeServer={chat.activeServer}
          model={chat.model}
          onModelChange={chat.setModel}
        />
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

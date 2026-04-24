import Input from "~/components/chat/Input";
import Messages from "~/components/chat/Messages";
import Sidebar from "~/components/chat/Sidebar";
import TopBar from "~/components/chat/TopBar";
import { useChat } from "~/hooks/useChat";

export default function ChatLayout() {
  const chat = useChat();
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />
      <main className="flex flex-1 flex-col bg-gray-50">
        <TopBar activeServer={chat.activeServer} />
        <Messages messages={chat.messages} error={chat.error} />
        <Input
          onSend={chat.sendMessage}
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

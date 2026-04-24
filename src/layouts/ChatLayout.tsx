import Input from "~/components/chat/Input";
import Messages from "~/components/chat/Messages";
import Sidebar from "~/components/chat/Sidebar";
import TopBar from "~/components/chat/TopBar";

export default function ChatLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />
      <main className="flex flex-1 flex-col bg-gray-50">
        <TopBar />
        <Messages />
        <Input />
      </main>
    </div>
  );
}

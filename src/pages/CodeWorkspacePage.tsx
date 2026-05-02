import Sidebar from "~/components/chat/Sidebar";
import CodePage from "~/pages/settings/CodePage";

export default function CodeWorkspacePage() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-50">
      <Sidebar activeConversationId={null} activeProjectId={null} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[960px] px-14 py-14">
          <CodePage />
        </div>
      </main>
    </div>
  );
}

import { Outlet } from "react-router";
import IconRail from "~/components/settings/IconRail";
import SettingsNav from "~/components/settings/SettingsNav";

export default function SettingsLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-50">
      <IconRail />
      <SettingsNav />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[960px] px-16 py-16">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

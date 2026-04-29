import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router";
import IconRail from "~/components/settings/IconRail";
import SettingsNav from "~/components/settings/SettingsNav";
import { useIsMobile } from "~/hooks/useIsMobile";

export default function SettingsLayout() {
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pathname } = useLocation();

  // Close the drawer whenever navigation lands on a new page (ExoScopy parity).
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!isMobile) setDrawerOpen(false);
  }, [isMobile]);

  if (isMobile) {
    return (
      <div className="flex h-dvh w-full flex-col overflow-hidden bg-gray-50">
        <header className="flex items-center justify-between gap-2 border-b border-gray-200 bg-white px-3 py-2">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open settings menu"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-ink hover:bg-gray-50"
          >
            <HamburgerIcon />
          </button>
          <span className="font-display text-[18px] font-light text-navy">
            Settings
          </span>
          <div className="h-11 w-11" />
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="px-5 py-6">
            <Outlet />
          </div>
        </main>
        {drawerOpen && (
          <div
            onClick={() => setDrawerOpen(false)}
            className="fixed inset-0 z-30 bg-black/30"
          />
        )}
        <div
          className={`fixed top-0 left-0 z-40 flex h-full w-[300px] transform bg-white transition-transform ${
            drawerOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <IconRail />
          <SettingsNav />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-gray-50">
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

function HamburgerIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

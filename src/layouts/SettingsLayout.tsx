import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import IconRail from "~/components/settings/IconRail";
import SettingsNav from "~/components/settings/SettingsNav";
import { useIsMobile } from "~/hooks/useIsMobile";

export default function SettingsLayout() {
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pathname } = useLocation();
  const navigate = useNavigate();

  // Close the drawer whenever navigation lands on a new page (ExoScopy parity).
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!isMobile) setDrawerOpen(false);
  }, [isMobile]);

  // Close-to-chat handler: try going back in history; if there's nothing to
  // go back to (fresh tab landed straight on /settings/...), navigate home.
  function closeSettings() {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/");
    }
  }

  // Esc anywhere in /settings/* exits settings. Same affordance as a modal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Don't fight an open drawer / modal that might want Esc itself.
        if (drawerOpen) {
          setDrawerOpen(false);
          return;
        }
        // Don't trigger when an input has focus and the user is editing text.
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName?.toLowerCase();
        if (tag === "input" || tag === "textarea" || t?.isContentEditable) return;
        closeSettings();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerOpen]);

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
          <button
            type="button"
            onClick={closeSettings}
            aria-label="Close settings"
            title="Close settings (Esc)"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-50 hover:text-ink"
          >
            <CloseIcon />
          </button>
        </header>
        <main
          className="flex-1 overflow-y-auto"
          // Force a GPU compositing layer — works around a Safari bug where
          // fast scroll on long flex children white-outs the viewport until
          // the next paint trigger (reload, resize). will-change keeps the
          // hint persistent across frames.
          style={{ transform: "translateZ(0)", willChange: "transform" }}
        >
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
      <div className="relative flex flex-shrink-0">
        <SettingsNav />
        {/* Close button — sits at the top-right of the SettingsNav column,
         *  above the section title. Esc shortcut also exits. */}
        <button
          type="button"
          onClick={closeSettings}
          aria-label="Close settings"
          title="Close settings (Esc)"
          className="absolute top-3 right-3 flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-ink"
        >
          <CloseIcon />
        </button>
      </div>
      <main
        className="flex-1 overflow-y-auto"
        // See comment on the mobile <main> above — same Safari fast-scroll
        // white-out fix.
        style={{ transform: "translateZ(0)", willChange: "transform" }}
      >
        <div className="mx-auto max-w-[960px] px-16 py-16">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
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

import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router";
import { USER_GUIDE_TOPICS } from "~/content/user-guide";
import { useAuth } from "~/hooks/useAuth";

type NavItem = { to: string; label: string; end?: boolean };
type NavSection = { title: string; items: NavItem[] };

// Settings nav — refactor 2026-05-19 per a UX refactor:
//   - dropped: Security / Devices & sync / Learning Center
//   - renamed: Inference → "Inference & gateway" (Provider section becomes
//              "Odysseus Gateway", LiteLLM moves out to Add-ons)
//   - renamed: External agents → "Agents tokens"
//   - kept:    MCP servers (the hub for Notion/Obsidian/Tavily/…)
// Guest tokens (previously surfaced under Devices) stay accessible via
// the Admin link (admin role only).
const baseSections: NavSection[] = [
  {
    title: "Account",
    items: [
      { to: "/settings/profile", label: "Profile" },
    ],
  },
  {
    title: "Infrastructure",
    items: [
      { to: "/settings/inference", label: "Inference" },
    ],
  },
  {
    title: "Preferences",
    items: [
      { to: "/settings/appearance", label: "Appearance" },
      { to: "/settings/accessibility", label: "Accessibility" },
      { to: "/settings/shortcuts", label: "Shortcuts" },
    ],
  },
  {
    title: "Extensions",
    items: [
      { to: "/settings/add-ons", label: "Add-ons" },
      { to: "/settings/mcp-servers", label: "MCP servers" },
      { to: "/settings/skills", label: "Skills" },
      { to: "/settings/external-agents", label: "Agents tokens" },
    ],
  },
];

export default function SettingsNav() {
  const { role } = useAuth();
  const { pathname } = useLocation();
  const isAdminish = role === "admin" || role === "organiser";
  const onUserGuide = pathname.startsWith("/settings/user-guide");

  // Auto-expand the User Guide section when entering it, auto-collapse
  // when navigating away. The chevron lets the user toggle manually
  // while staying on a guide page.
  const [guideOpen, setGuideOpen] = useState(onUserGuide);
  useEffect(() => {
    setGuideOpen(onUserGuide);
  }, [onUserGuide]);

  const sections: NavSection[] = isAdminish
    ? baseSections.map((s) =>
        s.title === "Preferences"
          ? {
              ...s,
              items: [...s.items, { to: "/settings/admin", label: "Admin" }],
            }
          : s,
      )
    : baseSections;

  return (
    <nav className="flex h-full w-[240px] flex-col gap-6 overflow-y-auto border-r border-gray-200 bg-white px-4 pt-8 pb-4">
      <h1 className="px-2 font-display text-[30px] font-light text-navy">
        Settings
      </h1>

      {sections.map((section) => (
        <div key={section.title} className="flex flex-col gap-1">
          <span className="px-2 font-sans text-[11px] font-medium tracking-[0.08em] text-gray-400 uppercase">
            {section.title}
          </span>
          {section.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `rounded-md px-2 py-1.5 text-[13px] transition-colors ${
                  isActive
                    ? "bg-[rgba(79,179,217,0.12)] font-medium text-navy"
                    : "text-gray-600 hover:bg-gray-50 hover:text-ink"
                }`
              }
              end={item.end ?? true}
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      ))}

      <div className="flex flex-col gap-1">
        <span className="px-2 font-sans text-[11px] font-medium tracking-[0.08em] text-gray-400 uppercase">
          Reference
        </span>
        <div className="flex items-stretch">
          <NavLink
            to={`/settings/user-guide/${USER_GUIDE_TOPICS[0]?.slug ?? ""}`}
            className={({ isActive }) =>
              `flex-1 rounded-md px-2 py-1.5 text-[13px] transition-colors ${
                isActive || onUserGuide
                  ? "bg-[rgba(79,179,217,0.12)] font-medium text-navy"
                  : "text-gray-600 hover:bg-gray-50 hover:text-ink"
              }`
            }
            end={false}
          >
            User Guide
          </NavLink>
          {onUserGuide && (
            <button
              type="button"
              onClick={() => setGuideOpen((v) => !v)}
              className="ml-1 rounded-md px-1.5 text-gray-400 hover:bg-gray-50 hover:text-ink"
              aria-label={guideOpen ? "Collapse topics" : "Expand topics"}
            >
              {guideOpen ? "▾" : "▸"}
            </button>
          )}
        </div>

        {guideOpen && (
          <div className="ml-2 mt-1 flex flex-col gap-0.5 border-l border-gray-200 pl-2">
            {USER_GUIDE_TOPICS.map((t) => (
              <NavLink
                key={t.slug}
                to={`/settings/user-guide/${t.slug}`}
                className={({ isActive }) =>
                  `rounded-md px-2 py-1 text-[12px] transition-colors ${
                    isActive
                      ? "font-medium text-navy"
                      : "text-gray-500 hover:text-ink"
                  }`
                }
                end
              >
                {t.title}
              </NavLink>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}

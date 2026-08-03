import { NavLink } from "react-router";
import { useAuth } from "~/hooks/useAuth";

type NavItem = { to: string; label: string; end?: boolean };
type NavSection = { title: string; items: NavItem[] };

// Settings nav — refactor 2026-05-19 per a UX refactor:
//   - dropped: Security / Devices & sync / Learning Center
//   - renamed: Inference → "Inference & gateway" (Provider section becomes
//              "OdyssAI-X Gateway", LiteLLM moves out to Add-ons)
//   - renamed: External agents → "API access"
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
      { to: "/settings/agents", label: "Agents" },
      { to: "/settings/mcp-servers", label: "MCP servers" },
      { to: "/settings/skills", label: "Skills" },
      { to: "/settings/api-access", label: "API access" },
    ],
  },
];

export default function SettingsNav() {
  const { role } = useAuth();
  const isAdminish = role === "admin" || role === "organiser";

  const sections: NavSection[] = isAdminish
    ? baseSections.map((s) =>
        s.title === "Preferences"
          ? {
              ...s,
              items: [
                ...s.items,
                { to: "/settings/admin", label: "Admin" },
                { to: "/settings/traces", label: "Traces" },
              ],
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
          Help & docs
        </span>
        <a
          href="https://odyssai.eu/docs/"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] text-gray-600 transition-colors hover:bg-gray-50 hover:text-ink"
        >
          <span>Open docs site</span>
          <span className="text-[11px] text-gray-400">↗</span>
        </a>
        <span className="px-2 text-[11px] text-gray-400">
          Or type <code className="rounded bg-gray-100 px-1 font-mono text-[10px]">/help &lt;question&gt;</code> in chat.
        </span>
      </div>
    </nav>
  );
}

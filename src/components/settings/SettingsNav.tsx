import { NavLink } from "react-router";
import { useAuth } from "~/hooks/useAuth";

type NavItem = { to: string; label: string };
type NavSection = { title: string; items: NavItem[] };

const baseSections: NavSection[] = [
  {
    title: "Account",
    items: [
      { to: "/settings/profile", label: "Profile" },
      { to: "/settings/security", label: "Security" },
    ],
  },
  {
    title: "Infrastructure",
    items: [
      { to: "/settings/inference", label: "Inference" },
      { to: "/settings/devices", label: "Devices & sync" },
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
    items: [{ to: "/settings/add-ons", label: "Add-ons" }],
  },
  {
    title: "Premium",
    items: [{ to: "/settings/learning", label: "Learning Center" }],
  },
  {
    title: "Reference",
    items: [{ to: "/settings/help", label: "Help" }],
  },
];

export default function SettingsNav() {
  const { role } = useAuth();
  const isAdminish = role === "admin" || role === "organiser";

  // Surface the Admin link to admin/organiser only. Slotted in the
  // Preferences section — same layout, no separate full-page chrome.
  // Compute fleet / file sync moved out to mlx-odyss.eu (D-18); we only
  // surface user lifecycle + guest tokens here now.
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
    <nav className="flex h-full w-[240px] flex-col gap-6 border-r border-gray-200 bg-white px-4 pt-8 pb-4">
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
              end
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

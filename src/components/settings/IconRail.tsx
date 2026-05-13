import { Link, useLocation } from "react-router";

export default function IconRail() {
  const { pathname } = useLocation();
  const items = [
    {
      to: "/",
      label: "Chat",
      active: pathname === "/" || pathname.startsWith("/c/"),
      icon: <ChatIcon />,
    },
    {
      to: "/library",
      label: "Library",
      active: pathname.startsWith("/library"),
      icon: <LibraryIcon />,
    },
    {
      to: "/settings/servers",
      label: "Settings",
      active: pathname.startsWith("/settings"),
      icon: <InfraIcon />,
    },
  ];

  return (
    <aside className="flex h-full w-[72px] flex-col items-center justify-between border-r border-gray-200 bg-white py-4">
      <div className="flex flex-col items-center gap-4">
        <img
          src="/logo/icon-192.png"
          alt="Companion"
          className="h-9 w-9 rounded-full"
        />
        <div className="flex flex-col items-center gap-1">
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              aria-label={item.label}
              className={`flex h-11 w-11 items-center justify-center rounded-lg transition-colors ${
                item.active
                  ? "bg-[rgba(79,179,217,0.14)] text-navy"
                  : "text-gray-400 hover:bg-gray-50 hover:text-ink"
              }`}
            >
              {item.icon}
            </Link>
          ))}
        </div>
      </div>
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-navy">
        <span className="font-mono text-xs font-medium text-white">S</span>
      </div>
    </aside>
  );
}

function ChatIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function LibraryIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

function InfraIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );
}

import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "companion:theme";

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const effective =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  root.dataset.theme = effective;
}

export default function AppearancePage() {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "light";
    return (window.localStorage.getItem(STORAGE_KEY) as Theme) ?? "light";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, theme);
    applyTheme(theme);
  }, [theme]);

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
          Preferences
        </span>
        <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
          Appearance.
        </h1>
        <p className="max-w-[560px] text-[15px] leading-[24px] text-gray-600">
          How the app should look on this device. Dark mode respects the brand
          palette — navy hero, cyan accents, ink-on-paper surfaces inverted.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="font-sans text-[11px] font-medium tracking-[0.08em] text-gray-400 uppercase">
          Theme
        </h2>
        <div className="grid grid-cols-3 gap-3">
          <ThemeCard
            current={theme}
            value="light"
            label="Light"
            description="Default — ivory surfaces, ink on paper."
            preview={{ bg: "#FAFAFA", fg: "#0F2F4F", accent: "#4FB3D9" }}
            onClick={() => setTheme("light")}
          />
          <ThemeCard
            current={theme}
            value="dark"
            label="Dark"
            description="Navy surfaces for late-night work."
            preview={{ bg: "#0F2F4F", fg: "#FFFFFF", accent: "#4FB3D9" }}
            onClick={() => setTheme("dark")}
          />
          <ThemeCard
            current={theme}
            value="system"
            label="System"
            description="Follow the OS preference."
            preview={{ bg: "linear-gradient(135deg,#FAFAFA 50%,#0F2F4F 50%)", fg: "#4FB3D9", accent: "#4FB3D9" }}
            onClick={() => setTheme("system")}
          />
        </div>
      </section>
    </div>
  );
}

function ThemeCard({
  current,
  value,
  label,
  description,
  preview,
  onClick,
}: {
  current: Theme;
  value: Theme;
  label: string;
  description: string;
  preview: { bg: string; fg: string; accent: string };
  onClick: () => void;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col gap-3 rounded-xl border bg-white p-4 text-left transition-all ${
        active
          ? "border-cyan shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
          : "border-gray-200 hover:border-gray-300"
      }`}
    >
      <div
        className="flex h-[90px] items-center justify-center rounded-lg"
        style={{ background: preview.bg }}
      >
        <span
          className="font-display text-[16px] font-light"
          style={{ color: preview.fg }}
        >
          Aa
        </span>
        <span
          className="ml-3 h-1.5 w-10 rounded-full"
          style={{ background: preview.accent }}
        />
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="text-[14px] font-medium text-ink">{label}</span>
        <span className="text-[12px] text-gray-500">{description}</span>
      </div>
    </button>
  );
}

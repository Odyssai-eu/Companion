import { useEffect, useState } from "react";
import { notifyA11yPrefsChange } from "~/hooks/useA11yPrefs";

type A11yPrefs = {
  accessibleFont: boolean;
  largerText: boolean;
  voiceModeDefault: boolean;
  reducedMotion: boolean;
  highContrast: boolean;
  dyslexiaFriendlyLineHeight: boolean;
  voiceUiVisible: boolean;
};

const DEFAULTS: A11yPrefs = {
  accessibleFont: false,
  largerText: false,
  voiceModeDefault: false,
  reducedMotion: false,
  highContrast: false,
  dyslexiaFriendlyLineHeight: false,
  voiceUiVisible: false,
};

const STORAGE_KEY = "thecompai:accessibility";

export default function AccessibilityPage() {
  const [prefs, setPrefs] = useState<A11yPrefs>(() => {
    if (typeof window === "undefined") return DEFAULTS;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      // ignore
    }
    return DEFAULTS;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    notifyA11yPrefsChange();
    // Apply live CSS hooks on <html> so the rest of the app can react
    const root = document.documentElement;
    root.classList.toggle("a11y-accessible-font", prefs.accessibleFont);
    root.classList.toggle("a11y-larger-text", prefs.largerText);
    root.classList.toggle("a11y-high-contrast", prefs.highContrast);
    root.classList.toggle("a11y-reduced-motion", prefs.reducedMotion);
    root.classList.toggle(
      "a11y-dyslexia-line",
      prefs.dyslexiaFriendlyLineHeight,
    );
  }, [prefs]);

  function toggle<K extends keyof A11yPrefs>(key: K) {
    setPrefs((p) => ({ ...p, [key]: !p[key] }));
  }

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
          Preferences
        </span>
        <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
          Accessibility.
        </h1>
        <p className="max-w-[560px] text-[15px] leading-[24px] text-gray-600">
          Turn on what makes the app work for you. Changes apply instantly and
          follow you to every device signed in.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <Group title="Reading">
          <Setting
            label="Accessible font"
            description="Replace Inter with a sans font tuned for low-vision readers (Atkinson Hyperlegible)."
            value={prefs.accessibleFont}
            onChange={() => toggle("accessibleFont")}
          />
          <Setting
            label="Larger text"
            description="Bumps UI and message text by one size."
            value={prefs.largerText}
            onChange={() => toggle("largerText")}
          />
          <Setting
            label="Dyslexia-friendly line height"
            description="Opens up line-height and letter-spacing for easier tracking."
            value={prefs.dyslexiaFriendlyLineHeight}
            onChange={() => toggle("dyslexiaFriendlyLineHeight")}
          />
          <Setting
            label="High contrast"
            description="Darker text, heavier borders, brighter focus rings."
            value={prefs.highContrast}
            onChange={() => toggle("highContrast")}
          />
        </Group>

        <Group title="Motion & sound">
          <Setting
            label="Reduced motion"
            description="Removes non-essential animation (typing dots, fades, transitions)."
            value={prefs.reducedMotion}
            onChange={() => toggle("reducedMotion")}
          />
          <Setting
            label="Voice mode by default"
            description="Opens every new chat in Voice mode. You can still switch to typing."
            value={prefs.voiceModeDefault}
            onChange={() => toggle("voiceModeDefault")}
          />
          <Setting
            label="Show voice controls in chat"
            description="Reveals the mic button in the chat input and the Voice toggle in the chat header. New Talk in the sidebar is always available regardless."
            value={prefs.voiceUiVisible}
            onChange={() => toggle("voiceUiVisible")}
          />
        </Group>
      </section>
    </div>
  );
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="mb-2 font-sans text-[11px] font-medium tracking-[0.08em] text-gray-400 uppercase">
        {title}
      </span>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function Setting({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: boolean;
  onChange: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-6 rounded-xl border border-gray-200 bg-white px-5 py-4">
      <div className="flex flex-col gap-1">
        <span className="text-[14px] font-medium text-ink">{label}</span>
        <span className="text-[13px] leading-[20px] text-gray-600">
          {description}
        </span>
      </div>
      <button
        type="button"
        onClick={onChange}
        aria-pressed={value}
        className={`mt-0.5 flex h-6 w-11 flex-shrink-0 items-center rounded-full px-0.5 transition-colors ${
          value ? "justify-end bg-navy" : "justify-start bg-gray-200"
        }`}
      >
        <div className="h-5 w-5 rounded-full bg-white shadow-sm" />
      </button>
    </div>
  );
}

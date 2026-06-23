/**
 * Reads accessibility preferences from localStorage with live reactivity
 * (storage events + a custom 'a11y-prefs-change' event we dispatch from
 * AccessibilityPage on toggle, since `storage` events only fire across
 * tabs).
 *
 * Single source of truth: localStorage["companion:accessibility"], same
 * shape as the AccessibilityPage state object.
 */

import { useEffect, useState } from "react";

export type A11yPrefs = {
  accessibleFont: boolean;
  largerText: boolean;
  voiceModeDefault: boolean;
  reducedMotion: boolean;
  highContrast: boolean;
  dyslexiaFriendlyLineHeight: boolean;
  /** Read every finished assistant reply aloud automatically. Off by
   *  default — auto-reading every answer is rarely useful (e.g. asking for
   *  code and hearing the whole block) and is decoupled from voice mode:
   *  voice mode gates the mic (ASR input), this gates TTS auto-speak. Most
   *  useful for low-vision users. The per-message "Listen" button is always
   *  available regardless. */
  autoSpeakReplies: boolean;
};

const DEFAULTS: A11yPrefs = {
  accessibleFont: false,
  largerText: false,
  voiceModeDefault: false,
  reducedMotion: false,
  highContrast: false,
  dyslexiaFriendlyLineHeight: false,
  autoSpeakReplies: false,
};

const STORAGE_KEY = "companion:accessibility";
const CHANGE_EVENT = "a11y-prefs-change";

function read(): A11yPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return DEFAULTS;
}

export function useA11yPrefs(): A11yPrefs {
  const [prefs, setPrefs] = useState<A11yPrefs>(read);

  useEffect(() => {
    const onStorage = () => setPrefs(read());
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGE_EVENT, onStorage);
    };
  }, []);

  return prefs;
}

/** Notify same-tab subscribers that prefs changed. AccessibilityPage calls
 *  this after writing to localStorage. */
export function notifyA11yPrefsChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

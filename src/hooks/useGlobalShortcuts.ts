import { useEffect } from "react";

export type ShortcutHandlers = {
  onNewChat?: () => void;
  onFocusSearch?: () => void;
  onStop?: () => void;
  onToggleVoiceMode?: () => void;
  onOpenSettings?: () => void;
  /** Space pressed once outside any text field — toggles our ASR recorder
   *  (start on first press, stop+transcribe on the next). One press = one
   *  toggle; auto-repeat is ignored. */
  onVoiceToggle?: () => void;
};

/**
 * Centralised global hotkeys, mirroring the Settings → Shortcuts reference
 * page. Listeners are attached once at the app root.
 *
 * Conventions:
 *   - Cmd/Ctrl is treated identically (Mac vs Windows)
 *   - We don't fire when the user is typing in an input/textarea/contenteditable
 *     (except for Esc, which is a global "stop")
 *   - Voice toggle: a single Space press outside any text field fires
 *     onVoiceToggle() once (auto-repeat filtered). It drives OUR WavRecorder +
 *     /api/tts/transcribe (see ChatLayout) — NOT the Web Speech API. The
 *     typing guard means Space never gets hijacked while the user is writing.
 */
export function useGlobalShortcuts(handlers: ShortcutHandlers) {
  useEffect(() => {
    function isTyping(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName?.toLowerCase();
      return (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        el.isContentEditable === true
      );
    }

    function onKeyDown(e: KeyboardEvent) {
      const cmd = e.metaKey || e.ctrlKey;
      const typing = isTyping(e.target);

      // Esc — global stop, even from inputs
      if (e.key === "Escape") {
        if (handlers.onStop) {
          handlers.onStop();
        }
        return;
      }

      // Voice toggle: a single Space press outside inputs. Guard against
      // hijacking Space while the user is typing in a field.
      if (
        e.code === "Space" &&
        !typing &&
        !cmd &&
        !e.shiftKey &&
        !e.altKey &&
        handlers.onVoiceToggle
      ) {
        e.preventDefault();
        if (e.repeat) return; // auto-repeat → ignore, one press = one toggle
        handlers.onVoiceToggle();
        return;
      }

      // Cmd/Ctrl combos
      if (!cmd) return;

      const k = e.key.toLowerCase();
      if (k === "k") {
        // Cmd+K — focus search (also new conversation if no search field)
        e.preventDefault();
        if (handlers.onFocusSearch) handlers.onFocusSearch();
        else if (handlers.onNewChat) handlers.onNewChat();
        return;
      }
      if (k === "n") {
        e.preventDefault();
        if (handlers.onNewChat) handlers.onNewChat();
        return;
      }
      if (k === ",") {
        e.preventDefault();
        if (handlers.onOpenSettings) handlers.onOpenSettings();
        return;
      }
      if (e.shiftKey && k === "v") {
        e.preventDefault();
        if (handlers.onToggleVoiceMode) handlers.onToggleVoiceMode();
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    handlers.onNewChat,
    handlers.onFocusSearch,
    handlers.onStop,
    handlers.onToggleVoiceMode,
    handlers.onOpenSettings,
    handlers.onVoiceToggle,
    handlers,
  ]);
}

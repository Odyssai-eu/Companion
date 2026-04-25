import { useEffect } from "react";

export type ShortcutHandlers = {
  onNewChat?: () => void;
  onFocusSearch?: () => void;
  onStop?: () => void;
  onToggleVoiceMode?: () => void;
  onOpenSettings?: () => void;
  /** True while the user is holding Space outside an input — for push-to-talk */
  onPushToTalkChange?: (active: boolean) => void;
};

/**
 * Centralised global hotkeys, mirroring the Settings → Shortcuts reference
 * page. Listeners are attached once at the app root.
 *
 * Conventions:
 *   - Cmd/Ctrl is treated identically (Mac vs Windows)
 *   - We don't fire when the user is typing in an input/textarea/contenteditable
 *     (except for Esc, which is a global "stop")
 *   - Push-to-talk: Space held outside any text field, with both onPushToTalkChange(true)
 *     on keydown and onPushToTalkChange(false) on keyup. Repeated keydown events
 *     (auto-repeat) are filtered.
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

    let pttActive = false;

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

      // Push-to-talk: Space held outside inputs
      if (
        e.code === "Space" &&
        !typing &&
        !cmd &&
        !e.shiftKey &&
        !e.altKey &&
        handlers.onPushToTalkChange
      ) {
        if (e.repeat) {
          e.preventDefault();
          return;
        }
        if (!pttActive) {
          pttActive = true;
          handlers.onPushToTalkChange(true);
        }
        e.preventDefault();
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

    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space" && pttActive && handlers.onPushToTalkChange) {
        pttActive = false;
        handlers.onPushToTalkChange(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [
    handlers.onNewChat,
    handlers.onFocusSearch,
    handlers.onStop,
    handlers.onToggleVoiceMode,
    handlers.onOpenSettings,
    handlers.onPushToTalkChange,
    handlers,
  ]);
}

import { useEffect } from 'react';

export interface KeyboardShortcutMap {
  [key: string]: () => void;
}

/**
 * Custom hook to manage global keyboard shortcuts.
 * Automatically ignores shortcuts when typing in input/textarea fields,
 * unless the field is explicitly excluded.
 */
export function useKeyboardShortcuts(
  shortcuts: KeyboardShortcutMap,
  enabled: boolean = true,
) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if user is typing in an input or textarea
      const target = e.target as HTMLElement;
      const isFormField =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.contentEditable === 'true';

      // For video/audio elements, only handle Space specially (allow play/pause)
      const isMediaElement = target.tagName === 'VIDEO' || target.tagName === 'AUDIO';

      if (isFormField) {
        // Allow form field shortcuts only for Escape
        if (e.key !== 'Escape') return;
      }

      // Construct shortcut key from modifiers + key
      const mods: string[] = [];
      if (e.ctrlKey || e.metaKey) mods.push('ctrl');
      if (e.shiftKey) mods.push('shift');
      if (e.altKey) mods.push('alt');

      const shortcutKey = [...mods, e.key.toLowerCase()].join('+');

      if (shortcutKey in shortcuts) {
        // For media elements, let Space through to browser default (play/pause)
        if (isMediaElement && e.key === ' ') {
          return;
        }
        e.preventDefault();
        shortcuts[shortcutKey]();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts, enabled]);
}

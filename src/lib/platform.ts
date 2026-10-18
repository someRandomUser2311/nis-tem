// Shortcut labels for the current platform: the source writes them Mac-style ("⌘⇧F"), and on
// Windows and Linux they read "Ctrl+Shift+F". The shortcuts themselves accept ⌘ or Ctrl everywhere.

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const NAMES: Record<string, string> = { "⌘": "Ctrl", "⌥": "Alt", "⇧": "Shift", "↵": "Enter" };

/** Turn a Mac-style label such as "⌘⌥C" into "Ctrl+Alt+C" on other platforms. */
export function shortcutLabel(mac: string, mac_ = isMac): string {
  if (mac_) return mac;
  return [...mac].map((ch) => NAMES[ch] ?? ch.toUpperCase()).join("+");
}

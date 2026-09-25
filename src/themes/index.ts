// Theme registry.
//
// A theme is a CSS file plus an entry in THEMES. The app sets two attributes on <html>:
//   data-theme="<theme id>"   which look (this registry)
//   data-mode="dark|light"    which colour mode
//
// The Postman theme is the base: its tokens live on plain :root, so any token a theme
// leaves out falls back to Postman's. To add a theme, see "Adding a theme" in ARCHITECTURE.md:
//   1. create src/themes/<id>.css, overriding tokens under
//        :root[data-theme="<id>"]:not([data-mode="light"])   (dark)
//        :root[data-theme="<id>"][data-mode="light"]         (light)
//      and scoping any structural rules to :root[data-theme="<id>"]
//   2. import it below and add an entry to THEMES.
import { api } from "../lib/api";
import { DEFAULT_SETTINGS } from "../types";
import "./postman.css";
import "./spotify.css";

export type ColorMode = "dark" | "light";

export interface ThemeDef {
  id: string;
  /** Loaded from the user's themes folder rather than bundled. */
  user?: boolean;
  name: string;
  description: string;
  /** Colours for the picker's preview card: frame, panel, accent, text. */
  preview: Record<ColorMode, { frame: string; panel: string; accent: string; text: string }>;
}

export const THEMES: ThemeDef[] = [
  {
    id: "postman",
    name: "Postman",
    description: "Flat panels, square tabs and an orange accent — the classic API-client look.",
    preview: {
      dark: { frame: "#161616", panel: "#1e1e1e", accent: "#ff6c37", text: "#e8e8e8" },
      light: { frame: "#f4f4f4", panel: "#ffffff", accent: "#eb5a28", text: "#212121" },
    },
  },
  {
    id: "spotify",
    name: "Spotify",
    description: "Black frame, rounded panels, pill buttons and a green accent.",
    preview: {
      dark: { frame: "#000000", panel: "#121212", accent: "#1ed760", text: "#ffffff" },
      light: { frame: "#e4e4e4", panel: "#ffffff", accent: "#1ed760", text: "#000000" },
    },
  },
];

export const DEFAULT_THEME_ID = DEFAULT_SETTINGS.theme;

/** Folder the user drops custom themes into (empty in the browser preview). */
export let userThemesDir = "";

/**
 * Load custom themes from `<app data>/themes`: each `<id>.css` (scoped to
 * `:root[data-theme="<id>"]`, like the bundled ones) plus an optional `<id>.json` with
 * `{ "name", "description", "preview": { "dark": {…}, "light": {…} } }`. Called once before the UI renders.
 */
export async function loadUserThemes() {
  try {
    const { dir, themes } = await api.listUserThemes();
    userThemesDir = dir;
    for (const t of themes) {
      if (THEMES.some((x) => x.id === t.id)) continue;
      let meta: Partial<ThemeDef> = {};
      try { meta = t.meta ? JSON.parse(t.meta) : {}; } catch { /* ignore bad metadata */ }
      const style = document.createElement("style");
      style.dataset.userTheme = t.id;
      style.textContent = t.css;
      document.head.appendChild(style);
      const base = THEMES[0].preview;
      THEMES.push({
        id: t.id,
        user: true,
        name: typeof meta.name === "string" ? meta.name : t.id,
        description: typeof meta.description === "string" ? meta.description : "Custom theme",
        preview: { dark: { ...base.dark, ...meta.preview?.dark }, light: { ...base.light, ...meta.preview?.light } },
      });
    }
  } catch (e) {
    console.error("failed to load user themes", e);
  }
}

/** The registered theme for an id, falling back to the default (e.g. a removed theme). */
export function resolveTheme(id: string | undefined): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME_ID)!;
}

export function applyTheme(themeId: string, mode: ColorMode) {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(themeId).id;
  root.dataset.mode = mode;
}

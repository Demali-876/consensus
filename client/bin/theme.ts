import { loadPrefs } from './lib/store.ts';

function detectDarkMode(): boolean {
  if (process.platform !== 'darwin') return true;
  try {
    const result = Bun.spawnSync([
      'osascript', '-e',
      'tell application "System Events" to tell appearance preferences to return dark mode',
    ]);
    return result.stdout.toString().trim() === 'true';
  } catch {
    return true;
  }
}

function resolveDarkMode(): boolean {
  try {
    const pref = loadPrefs().theme;
    if (pref === 'dark') return true;
    if (pref === 'light') return false;
  } catch {
    // Fall back to system detection when preferences are unavailable.
  }
  return detectDarkMode();
}

export const isDark = resolveDarkMode();

// ─── Design system ────────────────────────────────────────────────────────────
// Web fonts: Caveat, Kalam (handwritten — web UI only, not applicable here)
// Terminal font: JetBrains Mono (300/400/500/600)
//   Required for correct rendering of box-drawing chars, block elements,
//   sparkline glyphs (▁▂▃▄▅▆▇█), and nav icons (⇄ ⟳ ⚡ ⬡ ⚙ ▶ ■).
//   Set in your terminal emulator: Preferences → Font → JetBrains Mono
//   Download: https://www.jetbrains.com/lp/mono/

// ─── Dark — Terminal Notebook ─────────────────────────────────────────────────
const DARK = {
  paper:   '#171520',
  paper2:  '#201e2b',
  ink:     '#eeeaf4',
  ink2:    '#c9c3d8',
  ink3:    '#918aa4',
  ink4:    '#625d74',
  line:    '#ded8ee',
  line2:   '#464153',
  marker:  '#e87c70',
  accent2: '#a8d9e0',
  accent3: '#f0c979',
  hatch:   'rgba(238,234,244,0.06)',

  // Existing semantic aliases used by the TUI.
  white:   '#eeeaf4',
  slate:   '#c9c3d8',
  dim:     '#918aa4',
  dark:    '#171520',
  panel:   '#201e2b',
  accent:  '#c9afe8',
  emerald: '#a8d9e0',
  amber:   '#f0c979',
  red:     '#e87c70',
  cyan:    '#a8d9e0',
  sky:     '#6d9da8',
};

// ─── Light — Terminal Notebook ────────────────────────────────────────────────
const LIGHT = {
  paper:   '#faf4ee',
  paper2:  '#f1ebe5',
  ink:     '#5d5876',
  ink2:    '#746e8a',
  ink3:    '#9b95aa',
  ink4:    '#c8c1bd',
  line:    '#8f879d',
  line2:   '#ddd6cf',
  marker:  '#cf7368',
  accent2: '#659aa6',
  accent3: '#e0a246',
  hatch:   'rgba(93,88,118,0.05)',

  // Existing semantic aliases used by the TUI.
  white:   '#5d5876',
  slate:   '#746e8a',
  dim:     '#9b95aa',
  dark:    '#faf4ee',
  panel:   '#f1ebe5',
  accent:  '#8f7aad',
  emerald: '#659aa6',
  amber:   '#e0a246',
  red:     '#cf7368',
  cyan:    '#659aa6',
  sky:     '#6f9fa8',
};

export const C = isDark ? DARK : LIGHT;
export type Theme = typeof DARK;

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

export const isDark = detectDarkMode();

// ─── Dark — Rosé Pine ─────────────────────────────────────────────────────────
const DARK = {
  // structure
  white:   '#E0DEF4',   // text          — warm lavender-white
  slate:   '#908CAA',   // subtle        — mid lavender-gray
  dim:     '#6E6A86',   // muted         — borders, timestamps
  dark:    '#191724',   // base          — root background
  panel:   '#1F1D2E',   // surface       — card / box background
  accent:  '#C4A7E7',   // iris          — active nav, selected rows

  // status (semantic, fixed)
  emerald: '#9CCFD8',   // foam          — connected / ok / 2xx
  amber:   '#F6C177',   // gold          — degraded / warning
  red:     '#EB6F92',   // love          — offline / error / 4xx 5xx
  cyan:    '#9CCFD8',   // foam          — live stream / metadata
  sky:     '#31748F',   // pine          — charts / secondary highlights
} as const;

// ─── Light — Catppuccin Latte ─────────────────────────────────────────────────
const LIGHT = {
  // structure
  white:   '#4C4F69',   // text          — deep blue-gray
  slate:   '#6C6F85',   // subtext0      — secondary text
  dim:     '#9CA0B0',   // overlay1      — borders, timestamps
  dark:    '#EFF1F5',   // base          — root background
  panel:   '#E6E9EF',   // mantle        — card / box background
  accent:  '#209FB5',   // sapphire      — active nav, selected rows

  // status (semantic, fixed)
  emerald: '#40A02B',   // green         — connected / ok / 2xx
  amber:   '#DF8E1D',   // yellow        — degraded / warning
  red:     '#D20F39',   // red           — offline / error / 4xx 5xx
  cyan:    '#04A5E5',   // sky           — live stream / metadata
  sky:     '#1E66F5',   // blue          — charts / secondary highlights
} as const;

export const C = isDark ? DARK : LIGHT;
export type Theme = typeof DARK;

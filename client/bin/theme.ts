// ─── theme.ts — dark / light mode aware palette ──────────────────────────────
// Detects macOS appearance via osascript. Falls back to dark on other platforms
// or if detection fails.

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

// ─── Accent colours — same in both modes ─────────────────────────────────────
const ACCENT = {
  cyan:    '#06b6d4',
  sky:     '#0ea5e9',
  emerald: '#10b981',
  amber:   '#f59e0b',
  red:     '#ef4444',
} as const;

// ─── Dark palette ─────────────────────────────────────────────────────────────
const DARK = {
  ...ACCENT,
  white:  '#f8fafc',   // primary text
  slate:  '#94a3b8',   // secondary text
  dim:    '#475569',   // muted text / borders
  dark:   '#0f172a',   // root background
  panel:  '#1e293b',   // card / box background
} as const;

// ─── Light palette ────────────────────────────────────────────────────────────
const LIGHT = {
  ...ACCENT,
  white:  '#0f172a',   // primary text (inverted)
  slate:  '#475569',   // secondary text
  dim:    '#94a3b8',   // muted text / borders
  dark:   '#f8fafc',   // root background
  panel:  '#e2e8f0',   // card / box background
} as const;

export const C = isDark ? DARK : LIGHT;
export type Theme = typeof DARK;

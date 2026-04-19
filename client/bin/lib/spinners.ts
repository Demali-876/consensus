/**
 * Braille spinner sets — each tuned to a specific context.
 *
 *   checking   ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏   network status / health probes
 *   launching  ⣾⣽⣻⢿⡿⣟⣯⣷     worker / proxy starting up
 *   wave       ⣀⣄⣤⣦⣶⣷⣿⡿⠿⢟⠟⡛⠛⠫⢋⠋   graph placeholder / data streaming
 *   scan       ⢹⢺⢼⣸⣇⡧⡗⡏     port scanning
 */

export const SPINNER = {
  checking:  ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  launching: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'],
  wave:      ['⣀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿', '⡿', '⠿', '⢟', '⠟', '⡛', '⠛', '⠫', '⢋', '⠋'],
  scan:      ['⢹', '⢺', '⢼', '⣸', '⣇', '⡧', '⡗', '⡏'],
} as const;

export type SpinnerKind = keyof typeof SPINNER;

/**
 * Creates a self-advancing spinner tick function.
 * Call tick() to get the next frame character.
 *
 * Usage:
 *   const spin = makeSpin('scan');
 *   const timer = setInterval(() => { ref.content = `${spin()}  scanning…`; }, 120);
 */
export function makeSpin(kind: SpinnerKind): () => string {
  const frames = SPINNER[kind] as readonly string[];
  let i = 0;
  return () => frames[i++ % frames.length]!;
}

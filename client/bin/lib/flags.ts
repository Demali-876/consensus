/** Returns the value following a named flag, or undefined if not present.
 *  Supports both `--flag value` and `--flag=value` forms. */
export function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  const prefixed = args.find((a) => a.startsWith(`${flag}=`));
  if (prefixed) return prefixed.slice(flag.length + 1);
  return undefined;
}

/** Returns true if a boolean flag is present in the args array. */
export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

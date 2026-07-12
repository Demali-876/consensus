// Stability-trial configuration, parsed from CLI flags (not env vars). Prod runs
// with no flags → the feature is off and the duration is the hardcoded 24h. For
// testing, pass flags to the script, e.g.:
//
//   node --import tsx/esm server.js --trial-enabled --trial-duration-ms=300000 \
//        --trial-void-ms=60000
//
// Flags:
//   --trial-enabled[=true|false]   turn the trial on (default off — ships dark)
//   --trial-duration-ms=<n>        trial length (default 24h)
//   --trial-void-ms=<n>            continuous-disconnect void threshold (default 1h)
//   --trial-probe-urls=<a,b,c>     override the rotating public probe targets

const ARGS = process.argv.slice(2);

/** Returns the flag's value ('' if present with no `=value`), or undefined if absent. */
function flag(name: string): string | undefined {
  const prefix = `--${name}`;
  for (const arg of ARGS) {
    if (arg === prefix) return '';
    if (arg.startsWith(`${prefix}=`)) return arg.slice(prefix.length + 1);
  }
  return undefined;
}

function boolFlag(name: string): boolean {
  const value = flag(name);
  if (value === undefined) return false;
  return value === '' || value === 'true' || value === '1';
}

function intFlag(name: string, fallback: number): number {
  const value = flag(name);
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// Off unless explicitly enabled — prod (no flags) ships dark.
export const TRIAL_ENABLED = boolFlag('trial-enabled');
// 24h hardcoded for prod; override only for testing.
export const TRIAL_DURATION_MS = intFlag('trial-duration-ms', 24 * 60 * 60 * 1000);
export const TRIAL_DISCONNECT_VOID_MS = intFlag('trial-void-ms', 60 * 60 * 1000);

export const TRIAL_PROBE_URLS: string[] | null = (() => {
  const value = flag('trial-probe-urls');
  if (!value) return null;
  const urls = value.split(',').map((u) => u.trim()).filter(Boolean);
  return urls.length > 0 ? urls : null;
})();

// Admission gate (task #3): the minimum stable sustained 16KB req/s a node must
// hold to be admitted at eval. Tunable so the floor can be calibrated in
// production without a redeploy; the default stays permissive (welcomes Pis /
// small VPSes) until real reference-hardware readings tighten it.
export const ADMISSION_FLOOR_REQ_S = intFlag('admission-floor-req-s', 50);

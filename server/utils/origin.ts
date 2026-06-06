type CorsOriginCallback = (err: Error | null, allow?: boolean) => void;

interface CorsOptionsLike {
  origin: (origin: string | undefined, callback: CorsOriginCallback) => void;
  credentials: boolean;
}

const DEFAULT_PROD_ORIGINS = [
  'https://consensus.canister.software',
  'https://canister.software',
];

const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8080',
];

let cachedAllowed: Set<string> | null = null;

export function getAllowedOrigins(): Set<string> {
  if (cachedAllowed) return cachedAllowed;
  const fromEnv = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const origins = new Set<string>(fromEnv.length > 0 ? fromEnv : DEFAULT_PROD_ORIGINS);
  if (process.env.NODE_ENV !== 'production') {
    for (const dev of DEV_ORIGINS) origins.add(dev);
  }
  cachedAllowed = origins;
  return origins;
}

/**
 * True when the request has no Origin header (non-browser clients like the
 * Consensus CLI/SDK, curl, server-to-server, or node tunnel connections) or
 * when the Origin is explicitly allow-listed.  Browser-originated requests
 * from any other site are rejected.
 */
export function isOriginAllowed(origin: string | undefined | null): boolean {
  if (!origin) return true;
  return getAllowedOrigins().has(origin);
}

export function corsOptions(): CorsOptionsLike {
  return {
    origin(origin: string | undefined, callback: CorsOriginCallback) {
      callback(null, isOriginAllowed(origin));
    },
    credentials: false,
  };
}

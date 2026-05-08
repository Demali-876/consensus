const SERVER = 'https://consensus.canister.software';

let cached: boolean | null = null;

export async function isFreeMode(): Promise<boolean> {
  if (cached !== null) return cached;
  try {
    const res = await fetch(`${SERVER}/config`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return (cached = false);
    const data = await res.json() as { free_mode?: boolean };
    return (cached = data.free_mode === true);
  } catch {
    return (cached = false);
  }
}

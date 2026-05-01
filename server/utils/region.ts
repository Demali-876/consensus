export interface GeoRegion {
  region: string;
  source: 'ip-api';
  ip: string;
  country_code: string;
  subdivision?: string;
  city?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  network?: {
    isp?: string;
    org?: string;
    as?: string;
    hosting?: boolean;
    proxy?: boolean;
    mobile?: boolean;
  };
}

interface IpApiResponse {
  status: 'success' | 'fail';
  message?: string;
  query?: string;
  countryCode?: string;
  region?: string;
  regionName?: string;
  city?: string;
  lat?: number;
  lon?: number;
  timezone?: string;
  isp?: string;
  org?: string;
  as?: string;
  hosting?: boolean;
  proxy?: boolean;
  mobile?: boolean;
}

const AZURE_LIKE_REGIONS = [
  { name: 'west-us', lat: 37.7749, lon: -122.4194 },
  { name: 'west-us-2', lat: 47.6062, lon: -122.3321 },
  { name: 'west-us-3', lat: 33.4484, lon: -112.0740 },
  { name: 'central-us', lat: 41.2619, lon: -95.8608 },
  { name: 'north-central-us', lat: 41.8781, lon: -87.6298 },
  { name: 'south-central-us', lat: 29.4241, lon: -98.4936 },
  { name: 'east-us', lat: 37.4316, lon: -78.6569 },
  { name: 'east-us-2', lat: 36.6681, lon: -78.3889 },
  { name: 'canada-central', lat: 43.6532, lon: -79.3832 },
  { name: 'canada-east', lat: 46.8139, lon: -71.2080 },
  { name: 'brazil-south', lat: -23.5505, lon: -46.6333 },
  { name: 'uk-south', lat: 51.5072, lon: -0.1276 },
  { name: 'uk-west', lat: 51.4816, lon: -3.1791 },
  { name: 'west-europe', lat: 52.3676, lon: 4.9041 },
  { name: 'north-europe', lat: 53.3498, lon: -6.2603 },
  { name: 'france-central', lat: 48.8566, lon: 2.3522 },
  { name: 'germany-west-central', lat: 50.1109, lon: 8.6821 },
  { name: 'switzerland-north', lat: 47.3769, lon: 8.5417 },
  { name: 'norway-east', lat: 59.9139, lon: 10.7522 },
  { name: 'sweden-central', lat: 59.3293, lon: 18.0686 },
  { name: 'south-africa-north', lat: -25.7479, lon: 28.2293 },
  { name: 'uae-north', lat: 25.2048, lon: 55.2708 },
  { name: 'india-central', lat: 18.5204, lon: 73.8567 },
  { name: 'india-south', lat: 12.9716, lon: 77.5946 },
  { name: 'east-asia', lat: 22.3193, lon: 114.1694 },
  { name: 'southeast-asia', lat: 1.3521, lon: 103.8198 },
  { name: 'japan-east', lat: 35.6762, lon: 139.6503 },
  { name: 'japan-west', lat: 34.6937, lon: 135.5023 },
  { name: 'korea-central', lat: 37.5665, lon: 126.9780 },
  { name: 'australia-east', lat: -33.8688, lon: 151.2093 },
  { name: 'australia-southeast', lat: -37.8136, lon: 144.9631 },
] as const;

const REGION_COUNTRY_GROUPS: Record<string, readonly string[]> = {
  US: [
    'west-us',
    'west-us-2',
    'west-us-3',
    'central-us',
    'north-central-us',
    'south-central-us',
    'east-us',
    'east-us-2',
  ],
  CA: [
    'canada-central',
    'canada-east',
  ],
  BR: ['brazil-south'],
  GB: ['uk-south', 'uk-west'],
  IN: ['india-central', 'india-south'],
  JP: ['japan-east', 'japan-west'],
  KR: ['korea-central'],
  AU: ['australia-east', 'australia-southeast'],
  ZA: ['south-africa-north'],
  AE: ['uae-north'],
};

export async function classifyIpRegion(ip: string): Promise<GeoRegion> {
  const url = new URL(`http://ip-api.com/json/${encodeURIComponent(ip)}`);
  url.searchParams.set('fields', [
    'status',
    'message',
    'query',
    'countryCode',
    'region',
    'regionName',
    'city',
    'lat',
    'lon',
    'timezone',
    'isp',
    'org',
    'as',
    'hosting',
    'proxy',
    'mobile',
  ].join(','));

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`ip-api lookup failed: HTTP ${response.status}`);

  const body = await response.json() as IpApiResponse;
  if (body.status !== 'success') {
    throw new Error(`ip-api lookup failed: ${body.message ?? 'unknown error'}`);
  }
  if (typeof body.lat !== 'number' || typeof body.lon !== 'number' || !body.query || !body.countryCode) {
    throw new Error('ip-api lookup returned incomplete geolocation data');
  }

  return {
    region: nearestAzureLikeRegion(body.lat, body.lon, body.countryCode),
    source: 'ip-api',
    ip: body.query,
    country_code: body.countryCode,
    subdivision: body.regionName || body.region,
    city: body.city,
    latitude: body.lat,
    longitude: body.lon,
    timezone: body.timezone,
    network: {
      isp: body.isp,
      org: body.org,
      as: body.as,
      hosting: body.hosting,
      proxy: body.proxy,
      mobile: body.mobile,
    },
  };
}

function nearestAzureLikeRegion(lat: number, lon: number, countryCode: string): string {
  const countryCandidates = REGION_COUNTRY_GROUPS[countryCode.toUpperCase()];
  const candidates = countryCandidates
    ? AZURE_LIKE_REGIONS.filter((region) => countryCandidates.includes(region.name))
    : AZURE_LIKE_REGIONS;
  let best: typeof AZURE_LIKE_REGIONS[number] = candidates[0] ?? AZURE_LIKE_REGIONS[0];
  let bestKm = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const km = distanceKm(lat, lon, candidate.lat, candidate.lon);
    if (km < bestKm) {
      best = candidate;
      bestKm = km;
    }
  }
  return best.name;
}

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return radiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg: number): number {
  return deg * Math.PI / 180;
}

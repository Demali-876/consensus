import { execSync } from 'node:child_process';
import { reverse as reverseLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import os from 'node:os';

export type IpAssignmentKind = 'static' | 'dynamic';
export type LocalAssignment = 'manual' | 'dhcp' | 'bootp' | 'other' | 'unknown';
export type IpFamily = 4 | 6;
export type IpFamilyKey = 'ipv4' | 'ipv6';

export interface PublicIps {
  ipv4: string | null;
  ipv6: string | null;
}

export interface ReverseDnsByFamily {
  ipv4?: string[];
  ipv6?: string[];
}

export interface DeviceIpObservation {
  observedAt: number;
  publicIps: PublicIps;
  reverseDns?: ReverseDnsByFamily;
  localAssignment?: LocalAssignment;
  source?: string;
}

export interface DeviceIpClue {
  kind: IpAssignmentKind;
  confidence: number;
  staticConfidence: number;
  publicIps: PublicIps;
  localAssignment: LocalAssignment;
  reverseDns: ReverseDnsByFamily;
  reasons: string[];
  evidence: {
    observations: number;
    historyWindowHours: number;
    ipv4Changes: number;
    ipv6Changes: number;
    ipv6PrefixChanges: number;
    uniqueIpv4: number;
    uniqueIpv6: number;
    uniqueIpv6Prefixes: number;
  };
}

export interface ClassifyDeviceIpsInput {
  current: DeviceIpObservation;
  history?: DeviceIpObservation[];
}

export interface ResolveCurrentIpsOptions {
  reverseDns?: boolean;
}

const MAX_HISTORY_ENTRIES = 96;
const MIN_REOBSERVE_INTERVAL_MS = 30 * 60 * 1000;
const STATIC_PROMOTION_WINDOW_HOURS = 24 * 7;

const DYNAMIC_PTR_STRONG_PATTERN =
  /\b(dyn|pool|dhcp|pppoe|mobile|nat|cpe|revip|dial|cust|client)\b/i;
const DYNAMIC_PTR_WEAK_PATTERN =
  /\b(res\d*|residential|broadband|wireless|fiber|ftth|dsl|cable)\b/i;
const STATIC_PTR_PATTERN =
  /\b(static|business|colo|corp|dedicated|hosting|server|enterprise)\b/i;

const PUBLIC_IP_ENDPOINTS: Record<IpFamilyKey, string[]> = {
  ipv4: [
    'https://api4.ipify.org?format=json',
    'https://ipv4.icanhazip.com/',
    'https://v4.ident.me/',
  ],
  ipv6: [
    'https://api6.ipify.org?format=json',
    'https://ipv6.icanhazip.com/',
    'https://v6.ident.me/',
  ],
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function familyFromIp(ip: string | null | undefined): IpFamily | 0 {
  const family = ip ? isIP(ip) : 0;
  return family === 4 || family === 6 ? family : 0;
}

function isIpFamily(ip: string | null | undefined, family: IpFamily): boolean {
  return familyFromIp(ip) === family;
}

function normalizeIps(publicIps: Partial<PublicIps> | undefined): PublicIps {
  const ipv4 = isIpFamily(publicIps?.ipv4 ?? null, 4) ? publicIps?.ipv4 ?? null : null;
  const ipv6 = isIpFamily(publicIps?.ipv6 ?? null, 6) ? publicIps?.ipv6 ?? null : null;
  return { ipv4, ipv6 };
}

function normalizeReverseDns(reverseDns?: ReverseDnsByFamily): ReverseDnsByFamily {
  return {
    ipv4: [...new Set(reverseDns?.ipv4 ?? [])].filter(Boolean),
    ipv6: [...new Set(reverseDns?.ipv6 ?? [])].filter(Boolean),
  };
}

function normalizeObservation(observation: DeviceIpObservation): DeviceIpObservation | null {
  if (!Number.isFinite(observation.observedAt)) return null;
  const publicIps = normalizeIps(observation.publicIps);
  if (!publicIps.ipv4 && !publicIps.ipv6) return null;

  return {
    observedAt: observation.observedAt,
    publicIps,
    reverseDns: normalizeReverseDns(observation.reverseDns),
    localAssignment: observation.localAssignment ?? 'unknown',
    source: observation.source,
  };
}

function observationIdentity(observation: DeviceIpObservation): string {
  return `${observation.publicIps.ipv4 ?? '-'}|${observation.publicIps.ipv6 ?? '-'}`;
}

export function dedupeAndTrimHistory(history: DeviceIpObservation[]): DeviceIpObservation[] {
  const sorted = history
    .map(normalizeObservation)
    .filter((entry): entry is DeviceIpObservation => entry != null)
    .sort((a, b) => a.observedAt - b.observedAt);

  const compact: DeviceIpObservation[] = [];
  for (const entry of sorted) {
    const last = compact[compact.length - 1];
    if (
      last &&
      observationIdentity(last) === observationIdentity(entry) &&
      entry.observedAt - last.observedAt < MIN_REOBSERVE_INTERVAL_MS
    ) {
      continue;
    }
    compact.push(entry);
  }

  return compact.slice(-MAX_HISTORY_ENTRIES);
}

function extractIpCandidate(raw: string, family: IpFamily): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as { ip?: string };
    if (parsed?.ip && familyFromIp(parsed.ip) === family) return parsed.ip;
  } catch {
    // Some endpoints return plain text instead of JSON.
  }

  return familyFromIp(trimmed) === family ? trimmed : null;
}

function expandIpv6(ip: string): string[] {
  const [headRaw, tailRaw] = ip.toLowerCase().split('::');
  const head = headRaw ? headRaw.split(':').filter(Boolean) : [];
  const tail = tailRaw ? tailRaw.split(':').filter(Boolean) : [];

  if (tailRaw === undefined) {
    return ip.toLowerCase().split(':').map((part) => part.padStart(4, '0'));
  }

  const missing = Math.max(0, 8 - head.length - tail.length);
  return [
    ...head.map((part) => part.padStart(4, '0')),
    ...Array.from({ length: missing }, () => '0000'),
    ...tail.map((part) => part.padStart(4, '0')),
  ];
}

function ipv6Prefix64(ip: string): string {
  return expandIpv6(ip).slice(0, 4).join(':');
}

function countChanges(values: Array<string | null>): number {
  let changes = 0;
  let previous: string | null | undefined = undefined;

  for (const value of values) {
    if (!value) continue;
    if (previous != null && previous !== value) changes += 1;
    previous = value;
  }

  return changes;
}

function countUnique(values: Array<string | null>): number {
  return new Set(values.filter((value): value is string => !!value)).size;
}

function stableIpv4Window(history: DeviceIpObservation[], hours: number): boolean {
  const values = history.map((entry) => entry.publicIps.ipv4).filter((value): value is string => !!value);
  if (values.length < 3) return false;
  if (new Set(values).size !== 1) return false;
  const oldest = history.find((entry) => entry.publicIps.ipv4)?.observedAt;
  const newest = [...history].reverse().find((entry) => entry.publicIps.ipv4)?.observedAt;
  if (oldest == null || newest == null) return false;
  return newest - oldest >= hours * 60 * 60 * 1000;
}

function stableIpv6PrefixWindow(history: DeviceIpObservation[], hours: number): boolean {
  const values = history
    .map((entry) => entry.publicIps.ipv6)
    .filter((value): value is string => !!value);
  if (values.length < 3) return false;
  if (new Set(values.map(ipv6Prefix64)).size !== 1) return false;
  const oldest = history.find((entry) => entry.publicIps.ipv6)?.observedAt;
  const newest = [...history].reverse().find((entry) => entry.publicIps.ipv6)?.observedAt;
  if (oldest == null || newest == null) return false;
  return newest - oldest >= hours * 60 * 60 * 1000;
}

export function classifyDeviceIps(input: ClassifyDeviceIpsInput): DeviceIpClue {
  const current = normalizeObservation(input.current);
  if (!current) {
    return {
      kind: 'dynamic',
      confidence: 0.55,
      staticConfidence: 0.05,
      publicIps: { ipv4: null, ipv6: null },
      localAssignment: input.current.localAssignment ?? 'unknown',
      reverseDns: normalizeReverseDns(input.current.reverseDns),
      reasons: [
        'No valid public IPv4 or IPv6 address is available to prove a static assignment.',
        'Defaulting to dynamic because static evidence is missing.',
      ],
      evidence: {
        observations: 0,
        historyWindowHours: 0,
        ipv4Changes: 0,
        ipv6Changes: 0,
        ipv6PrefixChanges: 0,
        uniqueIpv4: 0,
        uniqueIpv6: 0,
        uniqueIpv6Prefixes: 0,
      },
    };
  }

  const history = dedupeAndTrimHistory([...(input.history ?? []), current]);
  const ipv4Values = history.map((entry) => entry.publicIps.ipv4);
  const ipv6Values = history.map((entry) => entry.publicIps.ipv6);
  const ipv6Prefixes = ipv6Values.filter((value): value is string => !!value).map(ipv6Prefix64);

  const ipv4Changes = countChanges(ipv4Values);
  const ipv6Changes = countChanges(ipv6Values);
  const ipv6PrefixChanges = countChanges(ipv6Prefixes);
  const uniqueIpv4 = countUnique(ipv4Values);
  const uniqueIpv6 = countUnique(ipv6Values);
  const uniqueIpv6Prefixes = new Set(ipv6Prefixes).size;

  const oldest = history[0]?.observedAt ?? current.observedAt;
  const newest = history[history.length - 1]?.observedAt ?? current.observedAt;
  const historyWindowHours = clamp((newest - oldest) / (60 * 60 * 1000), 0, 24 * 365);

  const reasons: string[] = [];
  const ipv4StableForPromotion = stableIpv4Window(history, STATIC_PROMOTION_WINDOW_HOURS);
  const ipv6PrefixStableForPromotion = stableIpv6PrefixWindow(history, STATIC_PROMOTION_WINDOW_HOURS);

  if (current.localAssignment === 'manual') {
    reasons.push('Primary interface appears manually configured.');
  } else if (current.localAssignment === 'dhcp') {
    reasons.push('Primary interface appears DHCP-managed.');
  } else if (current.localAssignment === 'bootp') {
    reasons.push('Primary interface appears BOOTP-managed.');
  }

  if (ipv4Changes > 0) {
    reasons.push('Observed public IPv4 changes across the saved history.');
  }

  if (ipv6PrefixChanges > 0) {
    reasons.push('Observed IPv6 prefix changes across the saved history.');
  } else if (ipv6Changes > 0) {
    reasons.push('IPv6 changed only inside the same /64 prefix, which looks more like privacy rotation than ISP reassignment.');
  }

  if (ipv4StableForPromotion) {
    reasons.push('The same public IPv4 has been observed repeatedly for at least 7 days.');
  }

  if (ipv6PrefixStableForPromotion) {
    reasons.push('The same IPv6 /64 prefix has been observed repeatedly for at least 7 days.');
  }

  const currentReverseDns = [
    ...(current.reverseDns?.ipv4 ?? []),
    ...(current.reverseDns?.ipv6 ?? []),
  ];

  if (currentReverseDns.some((name) => DYNAMIC_PTR_STRONG_PATTERN.test(name))) {
    reasons.push('Reverse DNS contains keywords often associated with dynamic or pooled addresses.');
  } else if (currentReverseDns.some((name) => DYNAMIC_PTR_WEAK_PATTERN.test(name))) {
    reasons.push('Reverse DNS looks residential or access-network oriented, which is only a weak dynamic signal.');
  } else if (currentReverseDns.some((name) => STATIC_PTR_PATTERN.test(name))) {
    reasons.push('Reverse DNS contains keywords sometimes associated with fixed infrastructure.');
  }

  if (history.length <= 1) {
    reasons.push('Only one device snapshot is available, so this is still a guess.');
  }

  const hardDynamicEvidence = ipv4Changes > 0 || ipv6PrefixChanges > 0;
  const hardStaticEvidence =
    ipv4StableForPromotion ||
    (!current.publicIps.ipv4 && ipv6PrefixStableForPromotion);

  const progressHours = Math.min(historyWindowHours, STATIC_PROMOTION_WINDOW_HOURS);
  const progressRatio = progressHours / STATIC_PROMOTION_WINDOW_HOURS;
  let staticConfidence = clamp(progressRatio * 0.74, 0.05, 0.74);

  if (current.localAssignment === 'manual') {
    staticConfidence = clamp(staticConfidence + 0.04, 0.05, 0.78);
  }
  if (currentReverseDns.some((name) => STATIC_PTR_PATTERN.test(name))) {
    staticConfidence = clamp(staticConfidence + 0.03, 0.05, 0.8);
  }
  if (
    currentReverseDns.some((name) => DYNAMIC_PTR_STRONG_PATTERN.test(name)) ||
    currentReverseDns.some((name) => DYNAMIC_PTR_WEAK_PATTERN.test(name))
  ) {
    staticConfidence = clamp(staticConfidence - 0.03, 0.02, 0.8);
  }
  if (hardDynamicEvidence) {
    staticConfidence = 0.02;
  }
  if (hardStaticEvidence) {
    staticConfidence = Math.max(staticConfidence, 0.9);
  }

  let kind: IpAssignmentKind = 'dynamic';
  let confidence = clamp(1 - staticConfidence, 0.51, 0.98);

  if (!hardDynamicEvidence && hardStaticEvidence && staticConfidence >= 0.9) {
    kind = 'static';
    confidence = staticConfidence;
    reasons.push('Static evidence cleared the promotion threshold.');
  } else {
    if (!hardStaticEvidence) {
      reasons.push('Defaulting to dynamic until the same identity has been observed for 7 days.');
    } else if (hardDynamicEvidence) {
      reasons.push('Defaulting to dynamic because hard dynamic evidence overrides static indicators.');
    } else {
      reasons.push('Defaulting to dynamic because static confidence did not clear the promotion threshold.');
    }
  }

  return {
    kind,
    confidence,
    staticConfidence,
    publicIps: current.publicIps,
    localAssignment: current.localAssignment ?? 'unknown',
    reverseDns: current.reverseDns ?? {},
    reasons,
    evidence: {
      observations: history.length,
      historyWindowHours,
      ipv4Changes,
      ipv6Changes,
      ipv6PrefixChanges,
      uniqueIpv4,
      uniqueIpv6,
      uniqueIpv6Prefixes,
    },
  };
}

export async function resolvePublicIp(family: IpFamily): Promise<string | null> {
  const endpoints = PUBLIC_IP_ENDPOINTS[family === 4 ? 'ipv4' : 'ipv6'];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: { 'user-agent': 'Consensus-IP-Detector/1.0' },
      });
      if (!response.ok) continue;
      const body = await response.text();
      const ip = extractIpCandidate(body, family);
      if (ip) return ip;
    } catch {
      // Try the next endpoint.
    }
  }
  return null;
}

export async function resolvePublicIps(): Promise<PublicIps> {
  const [ipv4, ipv6] = await Promise.all([
    resolvePublicIp(4),
    resolvePublicIp(6),
  ]);
  return { ipv4, ipv6 };
}

export async function reverseDnsForIp(ip: string): Promise<string[]> {
  try {
    return [...new Set(await reverseLookup(ip))].sort();
  } catch {
    return [];
  }
}

function detectMacLocalAssignment(): LocalAssignment {
  try {
    const routeInfo = execSync('route -n get default', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const device = routeInfo.match(/interface:\s+([^\s]+)/)?.[1];
    if (!device) return 'unknown';

    const ports = execSync('networksetup -listallhardwareports', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();

    const blocks = ports.split(/\n\s*\n/);
    let serviceName: string | undefined;
    for (const block of blocks) {
      const blockDevice = block.match(/Device:\s+([^\s]+)/)?.[1];
      if (blockDevice === device) {
        serviceName = block.match(/Hardware Port:\s+(.+)/)?.[1]?.trim();
        break;
      }
    }

    if (!serviceName) return 'unknown';

    const info = execSync(`networksetup -getinfo "${serviceName}"`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const firstLine = info.split(/\r?\n/, 1)[0]?.trim() ?? '';

    if (/^DHCP\b/i.test(firstLine)) return 'dhcp';
    if (/^Manual\b/i.test(firstLine)) return 'manual';
    if (/^BOOTP\b/i.test(firstLine)) return 'bootp';
    return firstLine ? 'other' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function detectLocalAssignment(): LocalAssignment {
  return os.platform() === 'darwin' ? detectMacLocalAssignment() : 'unknown';
}

export async function resolveCurrentObservation(
  options: ResolveCurrentIpsOptions = {},
): Promise<DeviceIpObservation> {
  const publicIps = await resolvePublicIps();
  const reverseDns: ReverseDnsByFamily = {};

  if (options.reverseDns !== false) {
    if (publicIps.ipv4) reverseDns.ipv4 = await reverseDnsForIp(publicIps.ipv4);
    if (publicIps.ipv6) reverseDns.ipv6 = await reverseDnsForIp(publicIps.ipv6);
  }

  return {
    observedAt: Date.now(),
    publicIps,
    reverseDns,
    localAssignment: detectLocalAssignment(),
    source: 'detector',
  };
}

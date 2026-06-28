export const CONSENSUS_DOMAIN = 'consensus.canister.software';

export function canonicalDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
}

export function publicNodeDomain(nodeId: string): string {
  return `${nodeId}.${CONSENSUS_DOMAIN}`;
}

export function nodeGatewayConnectUrl(nodeId: string): string {
  return `wss://${publicNodeDomain(nodeId)}/connect`;
}

export function hostnameFromHostHeader(host: string | undefined): string | null {
  const raw = host?.split(',')[0]?.trim();
  if (!raw || /[/#?@]/.test(raw)) return null;

  try {
    const hostname = new URL(`http://${raw}`).hostname;
    return canonicalDomain(hostname);
  } catch {
    return null;
  }
}

export function nodeIdFromGatewayHost(host: string | undefined): string | null {
  const hostname = hostnameFromHostHeader(host);
  if (!hostname) return null;

  const suffix = `.${CONSENSUS_DOMAIN}`;
  if (!hostname.endsWith(suffix)) return null;

  const nodeId = hostname.slice(0, -suffix.length);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(nodeId)) return null;
  return nodeId;
}

export function isNodeGatewayDomain(domain?: string | null): boolean {
  if (!domain) return false;
  return canonicalDomain(domain).endsWith(`.${CONSENSUS_DOMAIN}`);
}

import https from 'https';

const ZONE_NAME = 'canister.software';
const CF_API_BASE = 'api.cloudflare.com';
const CF_MAX_ATTEMPTS = 3;
const CF_REQUEST_TIMEOUT_MS = 15_000;
const CF_RETRY_BASE_DELAY_MS = 500;

// Silent mode flag - set by caller
let silentMode = false;

export function setSilentMode(silent) {
  silentMode = silent;
}

function log(...args) {
  if (!silentMode) console.log(...args);
}

function cfCredentials() {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  if (!apiToken || !zoneId) {
    throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID must be set');
  }
  return { apiToken, zoneId };
}

function isRetryableStatus(statusCode) {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

function responseSummary(data) {
  const compact = data.replace(/\s+/g, ' ').trim();
  return compact ? `: ${compact.slice(0, 300)}` : '';
}

function retryDelay(attempt, retryAfter) {
  const retryAfterSeconds = Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1_000;
  }
  return CF_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function cfRequest(method, pathname, body = null) {
  const { apiToken } = cfCredentials();
  const payload = body ? JSON.stringify(body) : null;

  for (let attempt = 1; attempt <= CF_MAX_ATTEMPTS; attempt += 1) {
    const response = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: CF_API_BASE,
          path: pathname,
          method,
          headers: {
            Authorization: `Bearer ${apiToken}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () =>
            resolve({ statusCode: res.statusCode || 0, headers: res.headers, data }),
          );
        },
      );
      req.setTimeout(CF_REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error(`Cloudflare request timed out after ${CF_REQUEST_TIMEOUT_MS}ms`));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    }).catch((error) => ({ networkError: error }));

    if ('networkError' in response) {
      if (attempt < CF_MAX_ATTEMPTS) {
        await sleep(retryDelay(attempt));
        continue;
      }
      throw new Error(
        `Cloudflare API request failed after ${CF_MAX_ATTEMPTS} attempts: ${response.networkError.message}`,
      );
    }

    const { statusCode, headers, data } = response;
    if (isRetryableStatus(statusCode) && attempt < CF_MAX_ATTEMPTS) {
      await sleep(retryDelay(attempt, headers['retry-after']));
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new Error(`Cloudflare API returned HTTP ${statusCode}${responseSummary(data)}`);
    }

    if (statusCode < 200 || statusCode >= 300 || !parsed.success) {
      const errorMsg = (parsed.errors || [])
        .map((error) => error.message || String(error))
        .join(', ') || `HTTP ${statusCode}${responseSummary(data)}`;
      throw new Error(`Cloudflare API error: ${errorMsg}`);
    }

    return parsed.result;
  }
}

async function findDnsRecords(name, type = null) {
  const { zoneId } = cfCredentials();
  const params = new URLSearchParams({ name, per_page: '100' });
  if (type) params.set('type', type);

  const result = await cfRequest('GET', `/client/v4/zones/${zoneId}/dns_records?${params.toString()}`);
  return (result || []).map((record) => ({
    id:      record.id,
    hostname: record.name,
    type:    record.type,
    address: record.content,
    ttl:     record.ttl,
  }));
}

async function upsertDnsRecord({ name, type, address, ttl = 300 }) {
  const { zoneId } = cfCredentials();
  const existing = await findDnsRecords(name, type);
  const body = { type, name, content: address, ttl, proxied: false };

  if (existing.length > 0) {
    await cfRequest('PUT', `/client/v4/zones/${zoneId}/dns_records/${existing[0].id}`, body);
    for (const stale of existing.slice(1)) {
      await cfRequest('DELETE', `/client/v4/zones/${zoneId}/dns_records/${stale.id}`);
    }
  } else {
    await cfRequest('POST', `/client/v4/zones/${zoneId}/dns_records`, body);
  }
}

async function deleteDnsRecords(name, type = null) {
  const { zoneId } = cfCredentials();
  const existing = await findDnsRecords(name, type);
  for (const record of existing) {
    await cfRequest('DELETE', `/client/v4/zones/${zoneId}/dns_records/${record.id}`);
  }
  return existing.length;
}

export async function provisionNodeDNS(subdomain, ipv6, ipv4 = null) {
  const nodeSubdomain = subdomain.split('.')[0];
  const fqdn = `${nodeSubdomain}.consensus.${ZONE_NAME}`;

  log(`Provisioning DNS for ${subdomain}`);
  if (ipv6) log(`   IPv6: ${ipv6}`);
  if (ipv4) log(`   IPv4: ${ipv4}`);

  try {
    if (ipv6) await upsertDnsRecord({ name: fqdn, type: 'AAAA', address: ipv6 });
    if (ipv4) await upsertDnsRecord({ name: fqdn, type: 'A', address: ipv4 });
    log(`   ✓ DNS provisioned successfully\n`);
    return true;
  } catch (error) {
    console.error(`   ✗ DNS provisioning failed: ${error.message}`);
    throw new Error(`DNS provisioning failed: ${error.message}`);
  }
}

export async function updateNodeDNS(subdomain, ipv6, ipv4 = null) {
  log(`🔄 Updating DNS for ${subdomain}`);

  const nodeSubdomain = subdomain.split('.')[0];
  const fqdn = `${nodeSubdomain}.consensus.${ZONE_NAME}`;

  try {
    if (ipv6) await upsertDnsRecord({ name: fqdn, type: 'AAAA', address: ipv6 });
    else await deleteDnsRecords(fqdn, 'AAAA');

    if (ipv4) await upsertDnsRecord({ name: fqdn, type: 'A', address: ipv4 });
    else await deleteDnsRecords(fqdn, 'A');

    log(`   ✓ DNS updated successfully\n`);
    return true;
  } catch (error) {
    console.error(`   ✗ DNS update failed: ${error.message}`);
    throw new Error(`DNS update failed: ${error.message}`);
  }
}

export async function removeNodeDNS(subdomain) {
  log(`🗑️  Removing DNS for ${subdomain}`);

  const nodeSubdomain = subdomain.split('.')[0];
  const fqdn = `${nodeSubdomain}.consensus.${ZONE_NAME}`;

  try {
    const removed = await deleteDnsRecords(fqdn);
    log(`   Removed ${removed} record(s)`);
    return true;
  } catch (error) {
    console.error(`   ✗ DNS removal failed: ${error.message}`);
    throw new Error(`DNS removal failed: ${error.message}`);
  }
}

export async function updateServerDDNS() {
  log('🌍 Updating DDNS for Consensus servers...\n');

  try {
    const currentIP = await getCurrentIP();
    if (!currentIP) {
      throw new Error('Could not determine current IP');
    }

    log(`📡 Current Public IP: ${currentIP}\n`);

    const mainHost = `consensus.${ZONE_NAME}`;
    const proxyHost = `consensus.proxy.${ZONE_NAME}`;

    log('📋 Fetching current DNS records...');
    const [mainRecords, proxyRecords] = await Promise.all([
      findDnsRecords(mainHost, 'A'),
      findDnsRecords(proxyHost, 'A'),
    ]);
    const mainRecord = mainRecords[0] ?? null;
    const proxyRecord = proxyRecords[0] ?? null;
    log(`   ✓ Found ${mainRecords.length + proxyRecords.length} existing record(s)\n`);

    let needsUpdate = false;

    if (!mainRecord || mainRecord.address !== currentIP) {
      log(`🔄 Main server IP needs update: ${mainRecord?.address || 'none'} → ${currentIP}`);
      needsUpdate = true;
    } else {
      log(`✓ Main server IP is current: ${currentIP}`);
    }

    if (!proxyRecord || proxyRecord.address !== currentIP) {
      log(`🔄 Proxy server IP needs update: ${proxyRecord?.address || 'none'} → ${currentIP}`);
      needsUpdate = true;
    } else {
      log(`✓ Proxy server IP is current: ${currentIP}`);
    }

    if (!needsUpdate) {
      log('\n✅ All DNS records are up to date!\n');
      return { updated: false, ip: currentIP };
    }

    log('\n🔄 Updating DNS records...');

    await Promise.all([
      upsertDnsRecord({ name: mainHost, type: 'A', address: currentIP }),
      upsertDnsRecord({ name: proxyHost, type: 'A', address: currentIP }),
    ]);

    log('   ✓ DNS updated successfully\n');
    log('✅ DDNS update complete!\n');
    log(`Main Server:  https://${mainHost} → ${currentIP}`);
    log(`Proxy Server: https://${proxyHost} → ${currentIP}`);
    log('\n');

    return { updated: true, ip: currentIP };
  } catch (error) {
    console.error('❌ DDNS update failed:', error.message);
    throw error;
  }
}

async function getCurrentIP() {
  try {
    const response = await fetch('https://api.ipify.org', {
      signal: AbortSignal.timeout(50000),
    });
    return (await response.text()).trim();
  } catch (error) {
    console.error('Failed to get current IP:', error.message);
    return null;
  }
}

import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function setupNetworkAccess(localPort) {
  console.log('Setting up network access...\n');

  console.log('1️⃣  Checking IPv6 connectivity...');
  const ipv6 = await getPublicIPv6();
  
  if (!ipv6) {
    console.error('   ❌ IPv6 not available');
    console.error('\n📋 IPv6 is required for Consensus nodes.');
    console.error('   Please enable IPv6 with your ISP or network.\n');
    throw new Error('IPv6 not available');
  }
  
  console.log(`   ✓ IPv6 address: ${ipv6}\n`);

  console.log('2️⃣  Checking IPv4 (fallback)...');
  const ipv4 = await getPublicIPv4();
  if (ipv4) {
    console.log(`   ✓ IPv4 address: ${ipv4}\n`);
  } else {
    console.log(`   ⚠️  IPv4 not available (IPv6 only)\n`);
  }
  
  // Step 3: Test connectivity
  console.log('3️⃣  Testing connectivity...');
  const reachable = await testConnectivity(ipv6, localPort);
  
  if (!reachable) {
    console.warn('   ⚠️  Port may not be reachable from internet');
    console.warn('   Make sure firewall allows inbound connections\n');
  } else {
    console.log(`   ✓ Port ${localPort} is reachable\n`);
  }
  
  return {
    ipv6,
    ipv4: ipv4 || null,
    port: localPort,
    endpoint: `http://[${ipv6}]:${localPort}`,
    reachable
  };
}

export async function setupDDNS(nodeId, ipv6, ipv4 = null) {
  console.log('🌍 Setting up Dynamic DNS...\n');
  
  const subdomain = `${nodeId}.consensus.canister.software`;
  
  console.log(`   Domain: ${subdomain}`);
  console.log(`   IPv6: ${ipv6}`);
  if (ipv4) console.log(`   IPv4: ${ipv4}`);
  // This will be called by the main server after node registration
  // For now, return the config that will be sent to main server
  return {
    subdomain,
    ipv6,
    ipv4,
    needs_dns_setup: true
  };
}

function getLocalIPv6() {
  const interfaces = os.networkInterfaces();
  
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (
        addr.family === 'IPv6' && 
        !addr.internal && 
        !addr.address.startsWith('fe80') &&
        !addr.address.startsWith('fd')
      ) {
        return addr.address;
      }
    }
  }
  
  return null;
}

async function getPublicIPv6() {
  try {
    const services = [
      'https://api64.ipify.org',
      'https://v6.ident.me',
      'https://ipv6.icanhazip.com'
    ];
    
    for (const service of services) {
      try {
        const response = await fetch(service, { 
          signal: AbortSignal.timeout(5000)
        });
        const ip = (await response.text()).trim();
        if (ip.includes(':')) {
          return ip;
        }
      } catch {
        continue;
      }
    }
    return getLocalIPv6();
    } catch (error) {
      return null;
    }
}

async function getPublicIPv4() {
  try {
    const response = await fetch('https://api.ipify.org', {
      signal: AbortSignal.timeout(5000)
    });
    return (await response.text()).trim();
  } catch {
    return null;
  }
}

async function testConnectivity(ip, port) {
  try {
    const url = `http://[${ip}]:${port}/health`;
    
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000)
    });
    
    return response.ok;
  } catch {
    return false;
  }
}

export async function startIPMonitor(currentIPs, onIPChange) {
  console.log('Starting IP address monitor...\n');
  setInterval(async () => {
    const newIPv6 = await getPublicIPv6();
    const newIPv4 = await getPublicIPv4();
    
    if (newIPv6 !== currentIPs.ipv6 || newIPv4 !== currentIPs.ipv4) {
      console.log('⚠️  IP address changed!');
      console.log(`   Old IPv6: ${currentIPs.ipv6}`);
      console.log(`   New IPv6: ${newIPv6}`);
      
      if (newIPv4 !== currentIPs.ipv4) {
        console.log(`   Old IPv4: ${currentIPs.ipv4 || 'none'}`);
        console.log(`   New IPv4: ${newIPv4 || 'none'}`);
      }
      
      currentIPs.ipv6 = newIPv6;
      currentIPs.ipv4 = newIPv4;
      if (onIPChange) {
        await onIPChange(newIPv6, newIPv4);
      }
    }
  }, 5 * 60 * 1000); // Check every 5 minutes
}
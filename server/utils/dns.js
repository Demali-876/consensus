import https from 'https';
import { XMLParser } from 'fast-xml-parser';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ''
});

export async function provisionNodeDNS(subdomain, ipv6, ipv4 = null) {
  const username = process.env.NAMECHEAP_USERNAME;
  const apiKey = process.env.NAMECHEAP_API_KEY;
  const sourceIp = process.env.NAMECHEAP_SOURCEIP;

  const nodeSubdomain = subdomain.split('.')[0];
  
  console.log(`🌍 Provisioning DNS for ${subdomain}`);
  console.log(`   IPv6: ${ipv6}`);
  if (ipv4) console.log(`   IPv4: ${ipv4}`);
  
  try {
    // Get current DNS records
    const currentRecords = await getNamecheapDNS();
    
    // Add new records for this node
    const newRecords = [];
    
    // Add AAAA record (IPv6) - primary
    newRecords.push({
      hostname: `${nodeSubdomain}.consensus`,
      type: 'AAAA',
      address: ipv6,
      ttl: 300
    });
    
    // Add A record (IPv4) if available - fallback
    if (ipv4) {
      newRecords.push({
        hostname: `${nodeSubdomain}.consensus`,
        type: 'A',
        address: ipv4,
        ttl: 300
      });
    }
    
    // Combine with existing records
    const allRecords = [...currentRecords, ...newRecords];
    
    // Build the API call with all records
    const params = new URLSearchParams({
      ApiUser: username,
      ApiKey: apiKey,
      UserName: username,
      ClientIp: sourceIp,
      Command: 'namecheap.domains.dns.setHosts',
      SLD: 'canister',
      TLD: 'software'
    });
    
    // Add all records
    allRecords.forEach((record, idx) => {
      const num = idx + 1;
      params.append(`HostName${num}`, record.hostname);
      params.append(`RecordType${num}`, record.type);
      params.append(`Address${num}`, record.address);
      params.append(`TTL${num}`, record.ttl || 300);
    });
    
    const url = `https://api.namecheap.com/xml.response?${params.toString()}`;
    
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = xmlParser.parse(data);
            
            // Check for success
            const apiResponse = result.ApiResponse;
            if (apiResponse.Status === 'OK') {
              console.log(`   ✓ DNS updated successfully\n`);
              resolve(true);
            } else {
              const errors = apiResponse.Errors?.Error || [];
              const errorMsg = Array.isArray(errors) 
                ? errors.map(e => e['#text'] || e).join(', ')
                : errors['#text'] || errors;
              
              console.error(`   ✗ DNS update failed: ${errorMsg}`);
              reject(new Error(`DNS provisioning failed: ${errorMsg}`));
            }
          } catch (parseError) {
            console.error('   ✗ Failed to parse response');
            console.error(data);
            reject(parseError);
          }
        });
      }).on('error', reject);
    });
    
  } catch (error) {
    console.error(`   ✗ DNS error: ${error.message}`);
    throw error;
  }
}

export async function updateNodeDNS(subdomain, ipv6, ipv4 = null) {
  console.log(`🔄 Updating DNS for ${subdomain}`);
  
  // For updates, we need to remove old records for this subdomain first
  const nodeSubdomain = subdomain.split('.')[0];
  const currentRecords = await getNamecheapDNS();
  
  // Filter out old records for this node
  const filteredRecords = currentRecords.filter(record => {
    return record.hostname !== `${nodeSubdomain}.consensus`;
  });
  
  // Now add the updated records
  const newRecords = [];
  
  newRecords.push({
    hostname: `${nodeSubdomain}.consensus`,
    type: 'AAAA',
    address: ipv6,
    ttl: 300
  });
  
  if (ipv4) {
    newRecords.push({
      hostname: `${nodeSubdomain}.consensus`,
      type: 'A',
      address: ipv4,
      ttl: 300
    });
  }
  
  const allRecords = [...filteredRecords, ...newRecords];
  
  // Use same setHosts call
  return setNamecheapDNS(allRecords);
}

export async function removeNodeDNS(subdomain) {
  console.log(`🗑️  Removing DNS for ${subdomain}`);
  
  const nodeSubdomain = subdomain.split('.')[0];
  const currentRecords = await getNamecheapDNS();
  
  // Filter out records for this node
  const filteredRecords = currentRecords.filter(record => {
    return record.hostname !== `${nodeSubdomain}.consensus`;
  });
  
  console.log(`   Removing ${currentRecords.length - filteredRecords.length} record(s)`);
  
  return setNamecheapDNS(filteredRecords);
}

async function getNamecheapDNS() {
  const username = process.env.NAMECHEAP_USERNAME;
  const apiKey = process.env.NAMECHEAP_API_KEY;
  const sourceIp = process.env.NAMECHEAP_SOURCEIP;
  
  const url = `https://api.namecheap.com/xml.response?ApiUser=${username}&ApiKey=${apiKey}&UserName=${username}&ClientIp=${sourceIp}&Command=namecheap.domains.dns.getHosts&SLD=canister&TLD=software`;
  
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = xmlParser.parse(data);
          const apiResponse = result.ApiResponse;
          if (apiResponse.Status !== 'OK') {
            const errors = apiResponse.Errors?.Error || [];
            const errorMsg = Array.isArray(errors) 
              ? errors.map(e => e['#text'] || e).join(', ')
              : errors['#text'] || errors;
            throw new Error(`Failed to get DNS records: ${errorMsg}`);
          }

          const commandResponse = apiResponse.CommandResponse;
          const domainDNS = commandResponse?.DomainDNSGetHostsResult;
          
          if (!domainDNS || !domainDNS.host) {
            resolve([]);
            return;
          }
          
          // Handle single host or array of hosts
          let hosts = domainDNS.host;
          if (!Array.isArray(hosts)) {
            hosts = [hosts];
          }
          
          const records = hosts.map(host => ({
            hostname: host.Name,
            type: host.Type,
            address: host.Address,
            ttl: parseInt(host.TTL) || 300
          }));
          
          resolve(records);
        } catch (error) {
          console.error('Failed to parse DNS response:', error.message);
          reject(error);
        }
      });
    }).on('error', reject);
  });
}
// Add to server/utils/dns.js

export async function updateServerDDNS() {
  console.log('🌍 Updating DDNS for Consensus servers...\n');
  
  try {
    // Get current public IP
    const currentIP = await getCurrentIP();
    if (!currentIP) {
      throw new Error('Could not determine current IP');
    }
    
    console.log(`📡 Current Public IP: ${currentIP}\n`);
    
    // Get current DNS records
    console.log('📋 Fetching current DNS records...');
    const records = await getNamecheapDNS();
    console.log(`   ✓ Found ${records.length} existing records\n`);
    
    // Check if update is needed
    const mainRecord = records.find(r => r.hostname === 'consensus' && r.type === 'A');
    const proxyRecord = records.find(r => r.hostname === 'consensus.proxy' && r.type === 'A');
    
    let needsUpdate = false;
    
    if (!mainRecord || mainRecord.address !== currentIP) {
      console.log(`🔄 Main server IP needs update: ${mainRecord?.address || 'none'} → ${currentIP}`);
      needsUpdate = true;
    } else {
      console.log(`✓ Main server IP is current: ${currentIP}`);
    }
    
    if (!proxyRecord || proxyRecord.address !== currentIP) {
      console.log(`🔄 Proxy server IP needs update: ${proxyRecord?.address || 'none'} → ${currentIP}`);
      needsUpdate = true;
    } else {
      console.log(`✓ Proxy server IP is current: ${currentIP}`);
    }
    
    if (!needsUpdate) {
      console.log('\n✅ All DNS records are up to date!\n');
      return { updated: false, ip: currentIP };
    }
    
    console.log('\n🔄 Updating DNS records...');
    
    // Update or add records
    const updatedRecords = records.filter(r => 
      !(r.hostname === 'consensus' && r.type === 'A') &&
      !(r.hostname === 'consensus.proxy' && r.type === 'A')
    );
    
    // Add updated A records
    updatedRecords.push({
      hostname: 'consensus',
      type: 'A',
      address: currentIP,
      ttl: 300
    });
    
    updatedRecords.push({
      hostname: 'consensus.proxy',
      type: 'A',
      address: currentIP,
      ttl: 300
    });
    
    await setNamecheapDNS(updatedRecords);
    
    console.log('   ✓ DNS updated successfully\n');
    console.log('✅ DDNS update complete!\n');
    console.log(`Main Server:  https://consensus.canister.software → ${currentIP}`);
    console.log(`Proxy Server: https://consensus.proxy.canister.software → ${currentIP}`);
    console.log('\n');
    
    return { updated: true, ip: currentIP };
    
  } catch (error) {
    console.error('❌ DDNS update failed:', error.message);
    throw error;
  }
}

async function getCurrentIP() {
  try {
    // Try IPv4
    const response = await fetch('https://api.ipify.org', {
      signal: AbortSignal.timeout(5000)
    });
    return (await response.text()).trim();
  } catch (error) {
    console.error('Failed to get current IP:', error.message);
    return null;
  }
}

async function setNamecheapDNS(records) {
  const username = process.env.NAMECHEAP_USERNAME;
  const apiKey = process.env.NAMECHEAP_API_KEY;
  const sourceIp = process.env.NAMECHEAP_SOURCEIP;
  
  const params = new URLSearchParams({
    ApiUser: username,
    ApiKey: apiKey,
    UserName: username,
    ClientIp: sourceIp,
    Command: 'namecheap.domains.dns.setHosts',
    SLD: 'canister',
    TLD: 'software'
  });
  
  // Add all records
  records.forEach((record, idx) => {
    const num = idx + 1;
    params.append(`HostName${num}`, record.hostname);
    params.append(`RecordType${num}`, record.type);
    params.append(`Address${num}`, record.address);
    params.append(`TTL${num}`, record.ttl || 300);
  });
  
  const url = `https://api.namecheap.com/xml.response?${params.toString()}`;
  
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = xmlParser.parse(data);

          const apiResponse = result.ApiResponse;
          if (apiResponse.Status === 'OK') {
            console.log(`   ✓ DNS updated successfully\n`);
            resolve(true);
          } else {
            const errors = apiResponse.Errors?.Error || [];
            const errorMsg = Array.isArray(errors) 
              ? errors.map(e => e['#text'] || e).join(', ')
              : errors['#text'] || errors;
            console.error(`   ✗ DNS update failed: ${errorMsg}`);
            reject(new Error(`DNS update failed: ${errorMsg}`));
          }
        } catch (parseError) {
          console.error('   ✗ Failed to parse response');
          reject(parseError);
        }
      });
    }).on('error', reject);
  });
}
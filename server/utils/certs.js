import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

export async function issueNodeCertificate(nodeId, domain, opts = { }) {
  const days = opts.validDays ?? 365;

  if (!Number.isFinite(days) || !Number.isInteger(days) || days < 1) {
    throw new Error(`validDays must be an integer >= 1. Got: ${days}`);
  }

  console.log(`🔐 Issuing mTLS certificate for node ${nodeId} valid ${days} day(s)...`);
  
  const certDir = path.resolve(`./node-certs/${nodeId}`);
  await fs.mkdir(certDir, { recursive: true });
  
  const caKey = './scripts/mtls-certs/ca.key';
  const caCert = './scripts/mtls-certs/ca.crt';
  
  try {
    // Generate node private key
    console.log('   Generating private key...');
    await execAsync(`openssl genrsa -out ${certDir}/node.key 2048`);
    
    // Create CSR (Certificate Signing Request)
    console.log('   Creating certificate signing request...');
    await execAsync(
      `openssl req -new -key ${certDir}/node.key -out ${certDir}/node.csr -subj "/CN=${domain}/O=Consensus Network/OU=Node"`
    );
    // Sign certificate with CA
    console.log('   Signing certificate with CA...');
    await execAsync(
      `openssl x509 -req -in ${certDir}/node.csr -CA ${caCert} -CAkey ${caKey} -CAcreateserial -out ${certDir}/node.crt -days ${days} -sha256`
    );
    
    // Read certificates
    const cert = await fs.readFile(`${certDir}/node.crt`, 'utf8');
    const key = await fs.readFile(`${certDir}/node.key`, 'utf8');
    const ca = await fs.readFile(caCert, 'utf8');
    
    console.log('   ✓ Certificate issued successfully\n');
    
    return { cert, key, ca };
    
  } catch (error) {
    console.error('   ✗ Certificate issuance failed:', error.message);
    throw error;
  }
}

export async function revokeNodeCertificate(nodeId) {
  console.log(`🗑️  Revoking certificate for node ${nodeId}...`);
  
  const certDir = path.resolve(`./node-certs/${nodeId}`);
  
  try {
    await fs.rm(certDir, { recursive: true, force: true });
    console.log('   ✓ Certificate revoked\n');
    return true;
  } catch (error) {
    console.error('   ✗ Certificate revocation failed:', error.message);
    throw error;
  }
}
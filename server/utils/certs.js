import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.resolve(__dirname, '../..');
const execAsync = promisify(exec);

function validateDomain(domain) {
  if (typeof domain !== 'string' || domain.length === 0) throw new Error('domain must be a non-empty string');
  if (domain.length > 253) throw new Error('domain exceeds maximum length of 253 characters');
  const VALID_DOMAIN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  if (!VALID_DOMAIN.test(domain)) throw new Error(`domain contains invalid characters: ${domain}`);
  return domain;
}

export async function issueNodeCertificate(nodeId, domain, opts = {}) {
  const days = opts.validDays ?? 365;
  if (!Number.isFinite(days) || !Number.isInteger(days) || days < 1) {
    throw new Error(`validDays must be an integer >= 1. Got: ${days}`);
  }
  validateDomain(domain);

  const certDir = path.resolve(__dirname, '..', 'node-certs', nodeId);
  await fs.mkdir(certDir, { recursive: true });

  const caKey  = path.resolve(root, 'scripts/mtls-certs/ca.key');
  const caCert = path.resolve(root, 'scripts/mtls-certs/ca.crt');

  try {
    await execAsync(`openssl genrsa -out ${certDir}/node.key 2048`);
    await execAsync(`openssl req -new -key ${certDir}/node.key -out ${certDir}/node.csr -subj "/CN=${domain}/O=Consensus Network/OU=Node"`);
    await execAsync(`openssl x509 -req -in ${certDir}/node.csr -CA ${caCert} -CAkey ${caKey} -CAcreateserial -out ${certDir}/node.crt -days ${days} -sha256`);

    const cert = await fs.readFile(`${certDir}/node.crt`, 'utf8');
    const key  = await fs.readFile(`${certDir}/node.key`, 'utf8');
    const ca   = await fs.readFile(caCert, 'utf8');

    return { cert, key, ca };
  } catch (error) {
    console.error(`Certificate issuance failed for ${nodeId}:`, error.message);
    throw error;
  }
}

export async function revokeNodeCertificate(nodeId) {
  const certDir = path.resolve(__dirname, '..', 'node-certs', nodeId);
  try {
    await fs.rm(certDir, { recursive: true, force: true });
    return true;
  } catch (error) {
    console.error(`Certificate revocation failed for ${nodeId}:`, error.message);
    throw error;
  }
}

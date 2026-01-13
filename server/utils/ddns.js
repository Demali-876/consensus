#!/usr/bin/env node
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ 
  path: path.join(__dirname, '../.env'),
  override: true,
  quiet: true
});

const { updateServerDDNS, setSilentMode } = await import('../utils/dns.js');

setSilentMode(true);

updateServerDDNS()
  .then((result) => {
    if (result.updated) {
      console.log(`[${new Date().toISOString()}] ✅ DNS updated to ${result.ip}`);
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error(`[${new Date().toISOString()}] ❌ DDNS failed: ${error.message}`);
    process.exit(1);
  });
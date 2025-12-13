#!/usr/bin/env node

import 'dotenv/config';
import { updateServerDDNS } from '../utils/dns.js';

updateServerDDNS()
  .then((result) => {
    if (result.updated) {
      console.log('✅ DNS records updated successfully');
      process.exit(0);
    } else {
      console.log('✅ DNS records already up to date');
      process.exit(0);
    }
  })
  .catch((error) => {
    console.error('❌ DDNS update failed:', error.message);
    process.exit(1);
  });
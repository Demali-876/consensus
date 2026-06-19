// Dev/ops helper: mint a fresh orchestrator signing key and print the env value.
// Run on the Pi for key rotation:  npm run gen:orchestrator-key
//
// Prints the line to put in server/.env plus the derived kid and public JWK.
// The private key only exists in this process's output — paste it, don't log it
// anywhere persistent.

import { generateOrchestratorKey, publicJwk, ORCHESTRATOR_SK_ENV } from './keys.ts';

const key = generateOrchestratorKey();

console.log('# Add to server/.env (secret — do not commit):');
console.log(`${ORCHESTRATOR_SK_ENV}=${key.secretEnvValue}`);
console.log('');
console.log(`# kid (derived): ${key.kid}`);
console.log(`# public JWK:    ${JSON.stringify(publicJwk(key.publicKey, key.kid))}`);

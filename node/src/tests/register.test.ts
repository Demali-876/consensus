import assert from "node:assert/strict";
import { buildJoinPayload, optionsFromEnv } from "../registration/join";

const options = optionsFromEnv({
  CONSENSUS_SERVER_URL: "https://consensus.canister.software/",
  CONSENSUS_NODE_IPV6: "2603:7081:7a3e:ba00::1",
  CONSENSUS_NODE_IPV4: "203.0.113.10",
  CONSENSUS_NODE_PORT: "9090",
  CONSENSUS_NODE_TEST_ENDPOINT: "https://node.example.com/health",
  CONSENSUS_NODE_REGION: "us-east-1",
  CONSENSUS_NODE_CONTACT: "ops@example.com",
  CONSENSUS_EVM_ADDRESS: "0x0000000000000000000000000000000000000000",
  CONSENSUS_SOLANA_ADDRESS: "11111111111111111111111111111111",
  CONSENSUS_ICP_ADDRESS: "aaaaa-aa",
});

assert.equal(options.port, 9090);
assert.equal(options.serverUrl, "https://consensus.canister.software/");

const payload = buildJoinPayload({
  options,
  publicKeyPem: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n",
  joinAuth: {
    join_id: "join-123",
    alg: "ed25519",
    nonce: "nonce",
    signature: "signature",
    expires_at: Math.floor(Date.now() / 1000) + 60,
    saved_at: new Date().toISOString(),
  },
});

assert.equal(payload.join_id, "join-123");
assert.equal(payload.join_signature, "signature");
assert.equal(payload.pubkey_ed25519_pem.includes("BEGIN PUBLIC KEY"), true);
assert.equal(payload.capabilities.forward_proxy, true);

console.log("register ok");

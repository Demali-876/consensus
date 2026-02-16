import crypto from "crypto";
import { paymentMiddleware } from "@x402/express";
import { benchmarkNode } from "./utils/benchmark.js";
import { provisionNodeDNS } from "./utils/dns.js";
import NodeStore from "./data/node_store.js";

const BASE_PRICE = 100;
const INCREMENT = 50;
const MAX_PRICE = 1000;

function calculateJoinPrice() {
  const nodeCount = NodeStore.listNodes().length;
  const price = BASE_PRICE + (nodeCount * INCREMENT);
  return Math.min(price, MAX_PRICE);
}

export function registerNodes(app, httpsServer, x402Server, config) {
  const { EVM_PAY_TO, SOLANA_PAY_TO, localMode } = config;

  const joinHandler = async (req, res) => {
      const startTime = Date.now();

      try {
        const {
          pubkey_pem,
          alg,
          ipv6,
          ipv4,
          port,
          test_endpoint,
          region,
          contact,
          evm_address,
         solana_address
        } = req.body;

        if (!pubkey_pem || !alg || !ipv6 || !port || !test_endpoint || !contact || !evm_address || !solana_address) {
        return res.status(400).json({
            error: "Missing required fields",
            required: ["pubkey_pem", "alg", "ipv6", "port", "test_endpoint", "contact", "evm_address", "solana_address"],
        });
        }

        if (!["secp256k1", "ed25519"].includes(alg)) {
          return res.status(400).json({
            error: "Invalid algorithm",
            supported: ["secp256k1", "ed25519"],
          });
        }

        if (!ipv6.includes(":")) {
          return res.status(400).json({
            error: "Invalid IPv6 address format",
          });
        }
        if (!evm_address.startsWith('0x') || evm_address.length !== 42) {
        return res.status(400).json({
            error: "Invalid EVM address format"
        });
        }

        if (solana_address.length < 32 || solana_address.length > 44) {
        return res.status(400).json({
            error: "Invalid Solana address format"
        });
        }

        console.log("\nPayment verified - processing node registration");
        console.log(`   IPv6: ${ipv6}:${port}`);
        console.log(`   Algorithm: ${alg}`);
        console.log(`   Test endpoint: ${test_endpoint}`);

        const existingNodes = NodeStore.listNodes();
        const duplicate = existingNodes.find(
          (node) => node.capabilities?.ipv6 === ipv6
        );

        if (duplicate) {
          return res.status(409).json({
            error: "IPv6 already registered",
            existing_node_id: duplicate.id,
          });
        }

        console.log("\nRunning benchmark tests...");
        const benchmarkResult = await benchmarkNode(test_endpoint);

        if (!benchmarkResult.passed) {
          console.log(`  Benchmark failed: ${benchmarkResult.score}/100\n`);
          return res.status(400).json({
            error: "Node performance below minimum requirements",
            score: benchmarkResult.score,
            required_score: 60,
            details: benchmarkResult.details,
          });
        }

        console.log(` Benchmark passed: ${benchmarkResult.score}/100`);

        const nodeId = crypto.randomBytes(6).toString("hex");
        let subdomain;

        if (localMode) {
          subdomain = `localhost`;
          console.log(`\nNode ID: ${nodeId}`);
          console.log(`   Domain: ${subdomain} (local mode, DNS skipped)`);
        } else {
          subdomain = `${nodeId}.consensus.canister.software`;
          console.log(`\nNode ID: ${nodeId}`);
          console.log(`   Subdomain: ${subdomain}`);

          console.log("\n🌍 Provisioning DNS...");
          try {
            await provisionNodeDNS(subdomain, ipv6, ipv4);
            console.log(" DNS provisioned");
          } catch (dnsError) {
            console.error(`DNS failed: ${dnsError.message}\n`);
            return res.status(500).json({
              error: "DNS provisioning failed",
              message: dnsError.message,
            });
          }
        }

        const pubkey = crypto.createPublicKey(pubkey_pem).export({
          format: "der",
          type: "spki",
        });

        console.log("\nStoring node...");
        const node = NodeStore.upsertNode({
          id: nodeId,
          pubkey,
          alg,
          region: region || null,
          evm_address,
          solana_address,
          capabilities: {
            benchmark_score: benchmarkResult.score,
            fetch_latency: benchmarkResult.details.fetch.avg_latency_ms,
            cpu_performance: benchmarkResult.details.cpu.hashes_per_second,
            ipv6,
            ipv4: ipv4 || null,
            port,
          },
          contact: contact || null,
          status: "active",
        });

        NodeStore.setDomain(nodeId, subdomain, "ipv6");

        console.log(" Node stored");

        const processingTime = Date.now() - startTime;
        const paidPrice = calculateJoinPrice();

        console.log(`\n✅ Node registered in ${processingTime}ms`);
        console.log(`   Price paid: $${paidPrice}\n`);

        res.json({
          success: true,
          node_id: nodeId,
          domain: subdomain,
          ipv6,
          ipv4: ipv4 || null,
          port,
          status: "active",
          benchmark_score: benchmarkResult.score,
          price_paid: paidPrice,
          processing_time_ms: processingTime,
          next_steps: [
            "DNS propagation may take up to 5 minutes",
            "Send heartbeat every 5 minutes to /node/heartbeat/" + nodeId,
            "Monitor status at /node/status/" + nodeId,
          ],
        });
      } catch (error) {
        console.error("Registration error:", error);
        res.status(500).json({
          error: "Registration failed",
          message: error.message,
        });
      }
  };

  if (localMode) {
    app.post("/node/join", joinHandler);
  } else {
    app.post(
      "/node/join",
      paymentMiddleware(
        {
          "POST /node/join": {
            accepts: [
              {
                scheme: "exact",
                price: () => {
                  const price = calculateJoinPrice();
                  return `$${price}`;
                },
                network: "eip155:84532",
                payTo: EVM_PAY_TO,
              },
              {
                scheme: "exact",
                price: () => {
                  const price = calculateJoinPrice();
                  return `$${price}`;
                },
                network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
                payTo: SOLANA_PAY_TO,
              },
            ],
            description: "Join the Consensus Network",
            mimeType: "application/json",
          },
        },
        x402Server
      ),
      joinHandler
    );
  }

  app.post("/node/heartbeat/:node_id", (req, res) => {
    try {
      const { node_id } = req.params;
      const { rps, p95_ms, version } = req.body;

      const node = NodeStore.getNode(node_id);
      if (!node) {
        return res.status(404).json({ error: "Node not found" });
      }

      NodeStore.heartbeat(node_id, { rps, p95_ms, version });

      // Check if node version matches the required version
      let update_available = null;
      try {
        const required = NodeStore.getRequiredManifest();
        if (required && version && version !== required.version) {
          NodeStore.clearNodeVerification(node_id);
          update_available = {
            version: required.version,
            github_release_url: required.github_release_url,
          };
        }
      } catch (e) {
        console.error("Version check error:", e.message);
      }

      res.json({
        success: true,
        node_id,
        message: "Heartbeat recorded",
        next_heartbeat_in: 300,
        update_available,
      });
    } catch (error) {
      console.error("Heartbeat error:", error);
      res.status(500).json({
        error: "Heartbeat failed",
        message: error.message,
      });
    }
  });

  app.get("/node/status/:node_id", (req, res) => {
    try {
      const { node_id } = req.params;

      const node = NodeStore.getNode(node_id);

      if (!node) {
        return res.status(404).json({ error: "Node not found" });
      }

      res.json({
        node_id: node.id,
        domain: node.domain,
        status: node.status,
        region: node.region,
        capabilities: node.capabilities,
        created_at: node.created_at,
        updated_at: node.updated_at,
        heartbeat: node.heartbeat,
        software_version: node.software_version,
        build_digest: node.build_digest,
        verified: node.verified,
        last_verified_at: node.last_verified_at,
      });
    } catch (error) {
      console.error("Status error:", error);
      res.status(500).json({
        error: "Failed to get status",
        message: error.message,
      });
    }
  });

  app.get("/nodes", (req, res) => {
    try {
      const nodes = NodeStore.listNodes();

      res.json({
        total: nodes.length,
        current_join_price: calculateJoinPrice(),
        nodes: nodes.map((node) => ({
          node_id: node.id,
          domain: node.domain,
          status: node.status,
          region: node.region,
          benchmark_score: node.capabilities?.benchmark_score,
          ipv6: node.capabilities?.ipv6,
          ipv4: node.capabilities?.ipv4,
          port: node.capabilities?.port,
          created_at: node.created_at,
          heartbeat: node.heartbeat,
        })),
      });
    } catch (error) {
      console.error("List nodes error:", error);
      res.status(500).json({
        error: "Failed to list nodes",
        message: error.message,
      });
    }
  });

  return {
    getStats: () => ({
      total_nodes: NodeStore.listNodes().length,
      current_join_price: calculateJoinPrice(),
    }),
  };
}
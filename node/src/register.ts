import { optionsFromEnv, registerNode } from "./registration/join";

async function main(): Promise<void> {
  const response = await registerNode(optionsFromEnv());
  console.log("Consensus node registered");
  console.log(`node_id=${response.node_id}`);
  console.log(`domain=${response.domain}`);
  console.log(`benchmark_score=${response.benchmark_score}`);
}

main().catch((error) => {
  console.error("Registration failed:", error);
  process.exit(1);
});

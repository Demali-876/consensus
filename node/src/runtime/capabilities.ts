import type { NodeCapability } from "../types";

export const NODE_CAPABILITIES: NodeCapability[] = [
  "forward_proxy",
  "reverse_proxy",
  "websockets",
  "tunnels",
  "ip_leasing"
];

export function capabilitiesRecord(): Record<NodeCapability, true> {
  return Object.fromEntries(NODE_CAPABILITIES.map((capability) => [capability, true])) as Record<NodeCapability, true>;
}

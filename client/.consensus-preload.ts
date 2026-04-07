import { ProxyClient, createPaymentFetch } from "@canister-software/consensus-cli";

const paymentFetch = await createPaymentFetch({
  preferNetwork: "icp:1:xafvr-biaaa-aaaai-aql5q-cai",
});

const client = ProxyClient(paymentFetch, {
  strategy: "auto",
  verbose:        true,
});

globalThis.fetch = client.fetch as typeof fetch;

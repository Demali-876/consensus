import { ProxyClient } from "../../src/proxy-client.js";
import { createPaymentFetch } from "../../src/payment-fetch.js";

const ICP_PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=internet-computer&vs_currencies=usd";

const somedata = "here's some data!";

// Patch globalThis.fetch so every outgoing fetch — HTTP or HTTPS — is routed
// through the consensus network with payment and caching. No proxy protocol
// required; the ProxyClient wraps the request at the application layer.
const paymentFetch = await createPaymentFetch({});
const client = ProxyClient(paymentFetch, { strategy: "manual", cache_ttl: 300 });
globalThis.fetch = client.fetch as typeof fetch;
console.log("Consensus fetch interceptor installed — all outgoing fetch calls routed through consensus");

const server = Bun.serve({
  port: 3012,
  routes: {
    "/": {
      async GET() {
        return Response.json({
          ok: true,
          service: "proxy-test-server",
          routes: ["/", "/dataplease", "/geticpprice"],
        });
      },
    },
    "/geticpprice": {
      async GET() {
        const upstreamResponse = await fetch(ICP_PRICE_URL);

        if (!upstreamResponse.ok) {
          return new Response("Failed to fetch ICP price", { status: 502 });
        }

        const data = await upstreamResponse.json();
        return Response.json(data);
      },
    },
    "/dataplease": {
      async GET() {
        return Response.json(somedata);
      },
    },
  },
  fetch() {
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Server listening on ${server.url}`);

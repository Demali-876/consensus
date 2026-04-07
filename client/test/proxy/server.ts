const ICP_PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=internet-computer&vs_currencies=usd";

const somedata = "here's some data!";

const server = Bun.serve({
  port: 3012,
  idleTimeout: 60,
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

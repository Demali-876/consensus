import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { registerExactEvmScheme } from '@x402/evm/exact/server';
import { registerExactSvmScheme } from '@x402/svm/exact/server';

export const evmPayTo = process.env.EVM_WALLET_ADDRESS || "0x32CfC8e7aCe9517523B8884b04e4B3Fb2e064B7f";
export const solanaPayTo = process.env.SOLANA_WALLET_ADDRESS || "58rV8fbThkHw33g7fLobo89cdt2ufF4Et3su7N7BLzLe";
export const facilitatorUrl = process.env.FACILITATOR_URL || "https://x402.org/facilitator";

const facilitatorClient = new HTTPFacilitatorClient({
  url: facilitatorUrl
});

export const resourceServer = new x402ResourceServer(facilitatorClient);
registerExactEvmScheme(resourceServer);
registerExactSvmScheme(resourceServer);

export const x402Version = 2;

export function createPaymentRequirements(price, resource, description) {
  return {
    accepts: [
      {
        scheme: "exact",
        price: price,
        network: "eip155:84532",
        payTo: evmPayTo,
      },
      {
        scheme: "exact",
        price: price,
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        payTo: solanaPayTo,
      }
    ],
    description: description,
    mimeType: "application/json",
    extensions: {
      bazaar: {
        discoverable: true,
        category: "api-proxy",
        tags: ["deduplication", "caching", "https-proxy","privacy", "ipv4", "ipv6"],
      },
    },
  };
}

export async function verifyPayment(req, res, routeConfig) {
  try {const paymentHeader = req.headers['x-payment'] || req.headers['X-PAYMENT'];
  
  if (!paymentHeader) {
    return res.status(402).json({
      error: "Payment required",
      message: "X-PAYMENT header is required for new API calls",
      x402Version,
      ...routeConfig
    });
  }

  const result = await resourceServer.verifyPayment(req, routeConfig);
  
  if (!result.isValid) {
    console.log(`Payment verification failed: ${result.message}`);
    return res.status(402)
      .set(result.headers || {})
      .json({
        error: "Payment required",
        message: result.message,
        x402Version,
        ...routeConfig
      });
  }
  
  console.log(`✅ Payment verified on network: ${result.network}`);
  return { isValid: true, paymentResult: result };
  } catch (error) {
  console.error('Payment verification error:', error);
    throw error
  }
}

export async function settle(paymentData) {
  try {
    const result = await resourceServer.settlePayment(paymentData);
  console.log('✅ Payment settled');
  return result;
  } catch (error) {
    console.error(`❌ Payment settlement failed: ${error.message}`);
    throw error;
  }
}
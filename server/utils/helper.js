import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { registerExactEvmScheme } from '@x402/evm/exact/server';
import { registerExactSvmScheme } from '@x402/svm/exact/server';

export const evmPayTo =
  process.env.EVM_WALLET_ADDRESS || '0x32CfC8e7aCe9517523B8884b04e4B3Fb2e064B7f';

export const solanaPayTo =
  process.env.SOLANA_WALLET_ADDRESS || '58rV8fbThkHw33g7fLobo89cdt2ufF4Et3su7N7BLzLe';

export const facilitatorUrl =
  process.env.FACILITATOR_URL || 'https://x402.org/facilitator';

export const x402Version = 2;

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

export const resourceServer = new x402ResourceServer(facilitatorClient);

registerExactEvmScheme(resourceServer);
registerExactSvmScheme(resourceServer);

export function createPaymentRequirements(price, resource, description) {
  return {
    accepts: [
      {
        scheme: 'exact',
        price,
        network: 'eip155:84532',
        payTo: evmPayTo,
      },
      {
        scheme: 'exact',
        price,
        network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        payTo: solanaPayTo,
      },
    ],
    description,
    mimeType: 'application/json',
    extensions: {
      bazaar: {
        discoverable: true,
        category: 'api-proxy',
        tags: ['deduplication', 'caching', 'http-proxy', 'privacy', 'ipv4', 'ipv6'],
      },
    },
  };
}

export async function verifyPayment(req, res, paymentRequirements) {
  try {
    const paymentHeader = req.get('x-payment');

    if (!paymentHeader) {
      res.status(402).json({
        x402Version,
        ...paymentRequirements,
      });
      return null;
    }

    const cleanReq = {
      method: req.method,
      url: req.originalUrl || req.url,
      headers: { 'x-payment': paymentHeader },
    };

    const result = await resourceServer.verifyPayment(cleanReq, paymentRequirements);

    if (!result?.isValid) {
      res
        .status(402)
        .set(result?.headers || {})
        .json({
          x402Version,
          ...paymentRequirements,
        });
      return null;
    }

    return { isValid: true, paymentResult: result };
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Payment verification failed',
        message: err?.message || String(err),
      });
    }
    return null;
  }
}

export async function settle(paymentData) {
  const result = await resourceServer.settlePayment(paymentData);
  return result;
}

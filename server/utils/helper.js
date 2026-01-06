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
    resource,
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

function encodePaymentRequired(paymentRequirements) {
  return Buffer.from(JSON.stringify(paymentRequirements), 'utf8').toString('base64');
}

function getPaymentHeader(req) {
  const h = req.headers || {};
  return (
    h['x-payment'] ||
    h['payment-signature'] ||
    h['x-payment-signature'] ||
    h['payment_signature'] ||
    h['PAYMENT-SIGNATURE']
  );
}

export async function verifyPayment(req, res, paymentRequirements) {
  const paymentHeader = getPaymentHeader(req);

  if (!paymentHeader) {
    const encoded = encodePaymentRequired(paymentRequirements);
    res.set('PAYMENT-REQUIRED', encoded);
    return res.status(402).json({
      error: 'Payment required',
      message: 'PAYMENT-REQUIRED header contains payment instructions',
      x402Version,
      ...paymentRequirements,
    });
  }

  const cleanReq = {
    method: req.method,
    url: req.originalUrl || req.url,
    headers: {
      'x-payment': paymentHeader,
      'payment-signature': paymentHeader,
    },
  };

  const result = await resourceServer.verifyPayment(cleanReq, paymentRequirements);

  if (!result?.isValid) {
    const encoded = encodePaymentRequired(paymentRequirements);
    res.set(result?.headers || {});
    if (!res.get('PAYMENT-REQUIRED')) res.set('PAYMENT-REQUIRED', encoded);

    return res.status(402).json({
      error: 'Payment required',
      message: result?.message || 'Payment verification failed',
      x402Version,
      ...paymentRequirements,
    });
  }

  return { isValid: true, paymentResult: result };
}

export async function settle(paymentData) {
  return await resourceServer.settlePayment(paymentData);
}

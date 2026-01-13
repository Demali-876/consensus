import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';

export const evmPayTo = '0x32CfC8e7aCe9517523B8884b04e4B3Fb2e064B7f';
export const solanaPayTo = '58rV8fbThkHw33g7fLobo89cdt2ufF4Et3su7N7BLzLe';
export const facilitatorUrl = 'https://facilitator.x402.rs';
export const x402Version = 2;

const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
export const resourceServer = new x402ResourceServer(facilitatorClient);

resourceServer.register('eip155:84532', new ExactEvmScheme());
resourceServer.register('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', new ExactSvmScheme());

export function createPaymentRequirements(resourceUrl, description) {
  return {
    resource: resourceUrl,  // ✅ Just the URL string
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:84532',
        amount: '1000',  // 0.001 USDC (6 decimals)
        asset: BASE_SEPOLIA_USDC,
        payTo: evmPayTo,
        maxTimeoutSeconds: 300,
        extra: {
          name: "USDC",
          version: "2",
          resourceUrl,
        },
      },
    ],
    description,
    mimeType: 'application/json',
  };
}

function encodePaymentRequired(paymentRequirements) {
  const payload = { x402Version, ...paymentRequirements };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function getPaymentHeader(req) {
  const h = req.headers || {};
  return h['payment-signature'] || h['PAYMENT-SIGNATURE'];
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

  // ✅ Add logging to see what we're verifying
  console.log('📋 Payment header received:', paymentHeader.substring(0, 100) + '...');
  console.log('📋 Payment requirements:', JSON.stringify(paymentRequirements, null, 2));

  const verificationReq = {
    method: req.method,
    url: req.originalUrl || req.url,
    headers: {
      'payment-signature': paymentHeader,
    },
  };

  console.log('📋 Verification request:', JSON.stringify(verificationReq, null, 2));
  console.log('🔍 Verifying payment with facilitator...');
  
  try {
    const verifyResult = await resourceServer.verifyPayment(verificationReq, paymentRequirements);

    if (!verifyResult?.isValid) {
      console.log('❌ Payment verification failed:', verifyResult);
      const encoded = encodePaymentRequired(paymentRequirements);
      res.set(verifyResult?.headers || {});
      if (!res.get('PAYMENT-REQUIRED')) res.set('PAYMENT-REQUIRED', encoded);

      return res.status(402).json({
        error: 'Payment verification failed',
        message: verifyResult?.message || 'Invalid payment',
        x402Version,
        ...paymentRequirements,
      });
    }

    console.log('✅ Payment verified successfully');
    return verifyResult;
  } catch (error) {
    console.error('❌ Verification error details:', {
      message: error.message,
      statusCode: error.statusCode,
      invalidReason: error.invalidReason,
      payer: error.payer,
    });
    throw error;
  }
}

export async function settle(verifyResult) {
  try {
    console.log('💰 Settling payment...');
    const result = await resourceServer.settlePayment(verifyResult);
    console.log('✅ Payment settled');
    return result;
  } catch (error) {
    console.error('⚠️  Settlement failed:', error.message);
    throw error;
  }
}
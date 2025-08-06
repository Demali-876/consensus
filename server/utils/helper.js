const { exact } = require('x402/schemes');
const { useFacilitator } = require('x402/verify');
const { processPriceToAtomicAmount } = require('x402/shared');
const payTo = process.env.WALLET_ADDRESS || "0x32CfC8e7aCe9517523B8884b04e4B3Fb2e064B7f";
const facilitatorUrl = process.env.FACILITATOR_URL || "https://facilitator.x402.rs/";


const facilitatorConfig = {
  url: facilitatorUrl,
  timeout: 30000,
  headers: {
    'User-Agent': 'consensus-server/1.0.1',
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }
};

const { verify, settle } = useFacilitator(facilitatorConfig);
const x402Version = 1;

function createPaymentRequirements(amount, resource, description) {
  try {
    const atomicAmountForAsset = processPriceToAtomicAmount(amount, "base-sepolia");
    if ("error" in atomicAmountForAsset) {
      throw new Error(atomicAmountForAsset.error);
    }
    const { maxAmountRequired, asset } = atomicAmountForAsset;

    return {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired,
      resource,
      description,
      mimeType: "application/json",
      payTo: payTo,
      maxTimeoutSeconds: 60,
      asset: asset.address,
      outputSchema: undefined,
      extra: {
        name: asset.eip712.name,
        version: asset.eip712.version,
      },
    };
  } catch (error) {
    console.error('Error creating payment requirements:', error);
    throw error;
  }
}
async function verifyPayment(req, res, paymentRequirements) {
  const payment = req.header("X-PAYMENT");
  if (!payment) {
    return res.status(402).json({
      x402Version,
      error: "Payment required",
      message: "X-PAYMENT header is required for new API calls",
      accepts: [paymentRequirements],
    });
  }

  let decodedPayment;
  try {
    decodedPayment = exact.evm.decodePayment(payment);
    decodedPayment.x402Version = x402Version;
  } catch (error) {
    console.error('Payment decoding error:', error);
    return res.status(402).json({
      x402Version,
      error: "Invalid payment format",
      message: error?.message || "Malformed payment header",
      accepts: [paymentRequirements],
    });
  }

  try {
    console.log(`Verifying payment with facilitator: ${facilitatorUrl}`);

    const response = await verify(decodedPayment, paymentRequirements);
    
    if (!response.isValid) {
      console.log('Payment verification failed:', response.invalidReason);
      return res.status(402).json({
        x402Version,
        error: "Payment verification failed",
        message: response.invalidReason,
        accepts: [paymentRequirements],
        payer: response.payer,
      });
    }
    
    return { isValid: true, decodedPayment };
  } catch (error) {
    console.error('Payment verification error:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      cause: error.cause?.message || 'No cause details',
      stack: error.stack?.split('\n').slice(0, 5).join('\n')
    });
    
    if (error.message.includes('RequestContentLengthMismatchError') ||
        error.message.includes('content-length') ||
        error.message.includes('Request body length does not match') ||
        error.code === 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH' ||
        error.cause?.code === 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH') {
      
      console.log('Content-length mismatch detected - this suggests an issue with the HTTP request to the facilitator');

      try {
        console.log('Attempting retry with fresh facilitator connection...');
        const retryFacilitator = useFacilitator({
          url: facilitatorUrl,
          timeout: 15000,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Connection': 'close'
          }
        });
        
        const retryResponse = await retryFacilitator.verify(decodedPayment, paymentRequirements);

        if (retryResponse.isValid) {
          console.log('Retry verification successful');
          return { isValid: true, decodedPayment };
        } else {
          console.log('Retry verification failed:', retryResponse.invalidReason);
          return res.status(402).json({
            x402Version,
            error: "Payment verification failed",
            message: retryResponse.invalidReason,
            accepts: [paymentRequirements],
            payer: retryResponse.payer,
          });
        }
      } catch (retryError) {
        console.error('Retry verification also failed:', retryError.message);
        
        return res.status(402).json({
          x402Version,
          error: "Facilitator connection error",
          message: "Unable to verify payment due to persistent facilitator communication issues.",
          accepts: [paymentRequirements],
          debug: {
            issue: "Content-length mismatch with facilitator",
            facilitator_url: facilitatorUrl,
            suggestion: "The facilitator service may be experiencing issues. Please try again."
          }
        });
      }
    }
    if (error.message.includes('fetch failed') || 
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ENOTFOUND') ||
        error.message.includes('network')) {
      return res.status(402).json({
        x402Version,
        error: "Payment network error",
        message: "Unable to connect to payment facilitator. Please check your internet connection and try again.",
        accepts: [paymentRequirements],
        debug: {
          facilitator_url: facilitatorUrl,
          error_type: "Network connection failure"
        }
      });
    }

    return res.status(402).json({
      x402Version,
      error: "Payment verification failed",
      message: "Unable to verify payment due to an unexpected error.",
      accepts: [paymentRequirements],
      debug: {
        error_message: error.message,
        error_code: error.code
      }
    });
  }
}
module.exports = {
  payTo,
  facilitatorUrl,
  x402Version,
  createPaymentRequirements,
  verifyPayment,
  settle
};
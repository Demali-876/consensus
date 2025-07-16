const NodeCache = require('node-cache');
const axios = require('axios');

class ConsensusProxy {
  constructor() {
    this.cache = new NodeCache({ stdTTL: 300 });
    this.pendingRequests = new Map();
    this.paidKeys = new Set();
    this.supportedMethods = ['GET', 'POST', 'HEAD'];
  }

  // Check if payment is required for this idempotency key
  requiresPayment(idempotencyKey) {
    // If cached or already paid, no payment needed
    if (this.cache.has(idempotencyKey) || this.paidKeys.has(idempotencyKey)) {
      return false;
    }
    return true;
  }

  // Mark an idempotency key as paid
  markAsPaid(idempotencyKey) {
    this.paidKeys.add(idempotencyKey);
    console.log('Payment recorded for: ${idempotencyKey}');
  }

  async handleRequest(target_url, method, headers, body) {
    if (!this.supportedMethods.includes(method.toUpperCase())) {
      throw new Error('Unsupported method: ${method}. ICP supports GET, HEAD, POST');
    }

    const idempotencyKey = headers['x-idempotency-key'] ||
                          headers['idempotency-key'] ||
                          headers['X-Idempotency-Key'];
    
    if (!idempotencyKey) {
      throw new Error('Missing idempotency key in headers');
    }

    // Check cache first
    const cached = this.cache.get(idempotencyKey);
    if (cached) {
      console.log('Cache HIT: ${idempotencyKey} (no payment required)');
      return { ...cached, cached: true, payment_required: false };
    }

    // Check if request is pending
    if (this.pendingRequests.has(idempotencyKey)) {
      console.log('Request PENDING: ${idempotencyKey} (no additional payment)');
      const response = await this.pendingRequests.get(idempotencyKey);
      return { ...response, cached: true, payment_required: false };
    }

    console.log('Cache MISS: ${idempotencyKey} -> ${target_url} (payment required)');

    // This is a new request - payment should have been verified by server
    this.markAsPaid(idempotencyKey);

    const requestPromise = this.makeRequest(target_url, method, headers, body);
 this.pendingRequests.set(idempotencyKey, requestPromise);

    try {
      const response = await requestPromise;
      this.cache.set(idempotencyKey, response);
      return { ...response, cached: false, payment_required: true };
    } finally {
      this.pendingRequests.delete(idempotencyKey);
    }
  }

  async makeRequest(url, method, headers, body) {
    const cleanHeaders = { ...headers };
    delete cleanHeaders['host'];
    delete cleanHeaders['content-length'];

    const config = {
      method: method.toLowerCase(),
      url,
      headers: cleanHeaders,
      timeout: 30000,
      validateStatus: () => true
    };

    if (body && method.toUpperCase() === 'POST') {
      config.data = body;
    }

    const response = await axios(config);
    return {
      status: response.status,
      headers: response.headers,
      data: response.data,
      timestamp: Date.now()
    };
  }

  getStats() {
    return {
      cache_size: this.cache.keys().length,
      pending_requests: this.pendingRequests.size,
      paid_keys: this.paidKeys.size,
      cache_stats: this.cache.getStats()
    };
  }

  // Get payment status for an idempotency key
  getPaymentStatus(idempotencyKey) {
    return {
      is_cached: this.cache.has(idempotencyKey),
      is_paid: this.paidKeys.has(idempotencyKey),
      requires_payment: this.requiresPayment(idempotencyKey)
    };
  }
}

module.exports = ConsensusProxy;
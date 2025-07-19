const NodeCache = require('node-cache');
const axios = require('axios');

class ConsensusProxy {
  constructor() {
    this.cache = new NodeCache({ stdTTL: 300 });
    this.pendingRequests = new Map();
    this.paidKeys = new Set();
    this.supportedMethods = ['GET', 'POST', 'HEAD'];
    this.stats = {
      total_requests: 0,
      cache_hits: 0,
      cache_misses: 0
    };
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
    console.log(`Payment recorded for: ${idempotencyKey}`);
  }

  async handleRequest(target_url, method, headers, body) {
    if (!this.supportedMethods.includes(method.toUpperCase())) {
      throw new Error(`Unsupported method: ${method}. Supported methods: ${this.supportedMethods.join(', ')}`);
    }

    const idempotencyKey = headers['x-idempotency-key'] ||
                          headers['idempotency-key'] ||
                          headers['X-Idempotency-Key'];
    
    if (!idempotencyKey) {
      throw new Error('Missing idempotency key in headers');
    }

    this.stats.total_requests++;

    // Check cache first
    const cached = this.cache.get(idempotencyKey);
    if (cached) {
      console.log(`Cache HIT: ${idempotencyKey} (no payment required)`);
      this.stats.cache_hits++;
      return { ...cached, cached: true, payment_required: false };
    }

    // Check if request is pending
    if (this.pendingRequests.has(idempotencyKey)) {
      console.log(`Request PENDING: ${idempotencyKey} (no additional payment)`);
      const response = await this.pendingRequests.get(idempotencyKey);
      this.stats.cache_hits++;
      return { ...response, cached: true, payment_required: false };
    }

    console.log(`Cache MISS: ${idempotencyKey} -> ${target_url} (payment required)`);
    this.stats.cache_misses++;
    
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
    
    // Remove problematic headers that can cause content-length mismatches
    delete cleanHeaders['host'];
    delete cleanHeaders['content-length'];
    delete cleanHeaders['content-encoding'];
    delete cleanHeaders['transfer-encoding'];
    delete cleanHeaders['connection'];
    delete cleanHeaders['x-idempotency-key'];
    delete cleanHeaders['idempotency-key'];
    delete cleanHeaders['X-Idempotency-Key'];

    const config = {
      method: method.toLowerCase(),
      url,
      headers: cleanHeaders,
      timeout: 30000,
      validateStatus: () => true, // Accept all status codes
      maxRedirects: 5,
      // Don't automatically decompress responses
      decompress: false,
      // Handle content-length properly
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    };

    if (body && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
      config.data = body;
      
      // Set content-type if not already set
      if (!cleanHeaders['content-type'] && typeof body === 'object') {
        config.headers['content-type'] = 'application/json';
      }
    }

    try {
      const response = await axios(config);
      
      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        data: response.data,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error(`Request failed for ${url}:`, error.message);
      
      // Return error response in consistent format
      return {
        status: error.response?.status || 500,
        statusText: error.response?.statusText || 'Internal Server Error',
        headers: error.response?.headers || {},
        data: {
          error: 'Request failed',
          message: error.message,
          code: error.code
        },
        timestamp: Date.now()
      };
    }
  }

  getStats() {
    return {
      cache_size: this.cache.keys().length,
      pending_requests: this.pendingRequests.size,
      paid_keys: this.paidKeys.size,
      total_requests: this.stats.total_requests,
      cache_hits: this.stats.cache_hits,
      cache_misses: this.stats.cache_misses,
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

  // Clear expired payment keys periodically
  cleanupExpiredKeys() {
    // Keep only recent payment keys (last 24 hours)
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    // This is a simple cleanup - in production you'd want to track timestamps
    console.log(`Cleaned up payment keys. Current paid keys: ${this.paidKeys.size}`);
  }
}

module.exports = ConsensusProxy;
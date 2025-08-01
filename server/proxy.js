const NodeCache = require('node-cache');
const axios = require('axios');
const zlib = require('zlib');

class ConsensusProxy {
  constructor() {
    this.cache = new NodeCache({ stdTTL: 300 });
    this.pendingRequests = new Map();
    this.paidKeys = new Map(); // CHANGED: Set to Map to store timestamps
    this.stats = {
      total_requests: 0,
      cache_hits: 0,
      cache_misses: 0
    };
    
    // ADDED: Clean up expired paid keys every minute
    setInterval(() => this.cleanupExpiredKeys(), 60000);
  }

  requiresPayment(idempotencyKey) {
    if (this.cache.has(idempotencyKey) || this.paidKeys.has(idempotencyKey)) {
      return false;
    }
    return true;
  }

  markAsPaid(idempotencyKey) {
    this.paidKeys.set(idempotencyKey, Date.now()); // CHANGED: Store with timestamp
    console.log(`Payment recorded for: ${idempotencyKey}`);
  }

  // ADDED: Method to remove paid status (for failed requests)
  removePaidStatus(idempotencyKey) {
    this.paidKeys.delete(idempotencyKey);
    console.log(`Removed paid status for: ${idempotencyKey}`);
  }

  async handleRequest(target_url, method, headers, body) {
    const idempotencyKey = headers['x-idempotency-key'] ||
                          headers['idempotency-key'] ||
                          headers['X-Idempotency-Key'];
    
    if (!idempotencyKey) {
      throw new Error('Missing idempotency key in headers');
    }

    this.stats.total_requests++;

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
    delete cleanHeaders['content-encoding'];
    delete cleanHeaders['transfer-encoding'];
    delete cleanHeaders['connection'];
    delete cleanHeaders['x-idempotency-key'];
    delete cleanHeaders['idempotency-key'];
    delete cleanHeaders['X-Idempotency-Key'];
    // ADDED: Remove payment headers
    delete cleanHeaders['x-payment'];
    delete cleanHeaders['X-Payment'];
    delete cleanHeaders['x-verbose'];
    delete cleanHeaders['X-Verbose'];

    const config = {
      method: method.toLowerCase(),
      url,
      headers: cleanHeaders,
      timeout: 30000,
      validateStatus: () => true,
      maxRedirects: 5,
      decompress: false,
      responseType: 'arraybuffer',
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    };

    if (body && ['post', 'put', 'patch'].includes(method.toLowerCase())) {
      config.data = body;

      if (!cleanHeaders['content-type'] && typeof body === 'object') {
        config.headers['content-type'] = 'application/json';
      }
    }

    try {
      const response = await axios(config);
      let rawData = response.data;
      let contentEncoding = (response.headers['content-encoding'] || '').toLowerCase();

      // IMPROVED: Better compression handling
      if (contentEncoding === 'gzip') {
        rawData = zlib.gunzipSync(rawData);
      } else if (contentEncoding === 'deflate') {
        rawData = zlib.inflateSync(rawData);
      } else if (contentEncoding === 'br') {
        rawData = zlib.brotliDecompressSync(rawData);
      }

      const textData = Buffer.from(rawData).toString('utf8');

      let parsed;
      try {
        parsed = JSON.parse(textData);
      } catch (e) {
        parsed = textData; // fallback for non-JSON
      }

      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        data: parsed,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error(`Request failed for ${url}:`, error.message);

      return {
        status: error.response?.status || 500,
        statusText: error.response?.statusText || 'Internal Server Error',
        headers: error.response?.headers || {},
        data: {
          error: 'Request failed',
          message: error.message,
          code: error.code,
          url: url // ADDED: Include URL in error
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

  getPaymentStatus(idempotencyKey) {
    return {
      is_cached: this.cache.has(idempotencyKey),
      is_paid: this.paidKeys.has(idempotencyKey),
      requires_payment: this.requiresPayment(idempotencyKey)
    };
  }

  // UPDATED: 5-minute cleanup instead of 24 hours
  cleanupExpiredKeys() {
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    let removedCount = 0;

    for (const [key, timestamp] of this.paidKeys.entries()) {
      if (timestamp < fiveMinutesAgo) {
        this.paidKeys.delete(key);
        removedCount++;
      }
    }
    
    if (removedCount > 0) {
      console.log(`Cleaned up ${removedCount} expired paid keys. Current paid keys: ${this.paidKeys.size}`);
    }
  }

  // ADDED: Clear specific key from all tracking
  clearKey(idempotencyKey) {
    this.cache.del(idempotencyKey);
    this.paidKeys.delete(idempotencyKey);
    this.pendingRequests.delete(idempotencyKey);
    console.log(`Cleared all tracking for: ${idempotencyKey}`);
  }
}

module.exports = ConsensusProxy;
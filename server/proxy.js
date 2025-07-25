const NodeCache = require('node-cache');

class ConsensusProxy {
  constructor() {
    this.cache = new NodeCache({ stdTTL: 300 }); // 5 minutes for responses
    this.paidKeys = new Map();
    this.stats = {
      total_requests: 0,
      cache_hits: 0,
      cache_misses: 0
    };
    setInterval(() => this.cleanupExpiredKeys(), 60000);
  }

  requiresPayment(idempotencyKey) {
    if (this.cache.has(idempotencyKey) || this.paidKeys.has(idempotencyKey)) {
      return false;
    }
    return true;
  }

  markAsPaid(idempotencyKey) {
    this.paidKeys.set(idempotencyKey, Date.now());
    console.log(`Payment recorded for: ${idempotencyKey}`);
  }

  removePaidStatus(idempotencyKey) {
    this.paidKeys.delete(idempotencyKey);
    console.log(`Removed paid status for: ${idempotencyKey}`);
  }

  checkCache(idempotencyKey) {
    this.stats.total_requests++;

    const cached = this.cache.get(idempotencyKey);
    if (cached) {
      console.log(`Cache HIT: ${idempotencyKey}`);
      this.stats.cache_hits++;
      return { ...cached, cached: true };
    }

    console.log(`Cache MISS: ${idempotencyKey}`);
    this.stats.cache_misses++;
    return null;
  }

  cacheResponse(idempotencyKey, response) {
    this.cache.set(idempotencyKey, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data: response.data,
      timestamp: Date.now()
    });
    console.log(`Cached response for: ${idempotencyKey}`);
  }

  getStats() {
    return {
      cache_size: this.cache.keys().length,
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

  clearKey(idempotencyKey) {
    this.cache.del(idempotencyKey);
    this.paidKeys.delete(idempotencyKey);
    console.log(`Cleared all tracking for: ${idempotencyKey}`);
  }
}

module.exports = ConsensusProxy;
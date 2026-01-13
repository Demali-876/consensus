import NodeCache from "node-cache";
import axios from "axios";
import zlib from "zlib";
import { promisify } from "util";
import crypto from "crypto";
import { URL } from "url";

const gunzipAsync = promisify(zlib.gunzip);
const inflateAsync = promisify(zlib.inflate);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function deepSort(value) {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([k, v]) => [k, deepSort(v)])
        .sort(([a], [b]) => a.localeCompare(b))
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(deepSort(value));
}

function canonicalizeUrl(raw) {
  const u = new URL(String(raw));
  u.hash = "";
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();

  if (
    (u.protocol === "https:" && u.port === "443") ||
    (u.protocol === "http:" && u.port === "80")
  ) {
    u.port = "";
  }

  const params = [...u.searchParams.entries()].sort((a, b) => {
    const k = a[0].localeCompare(b[0]);
    return k !== 0 ? k : a[1].localeCompare(b[1]);
  });

  u.search = "";
  for (const [k, v] of params) u.searchParams.append(k, v);

  u.pathname = u.pathname || "/";
  return u.toString();
}

function canonicalizeSemanticHeaders(headers = {}) {
  const allow = new Set(["accept", "content-type"]);
  const entries = Object.entries(headers)
    .map(([k, v]) => [
      k.toLowerCase().trim(),
      String(v).trim().replace(/\s+/g, " "),
    ])
    .filter(([k]) => allow.has(k))
    .sort(([a], [b]) => a.localeCompare(b));

  return Object.fromEntries(entries);
}

function computeBodyHash(body, contentType = "") {
  if (body === undefined || body === null) return "no-body";
  if (Buffer.isBuffer(body)) return sha256Hex(body);
  if (typeof body === "string") return sha256Hex(body);

  const ct = String(contentType).toLowerCase();

  if (ct.includes("application/json") && typeof body === "object") {
    return sha256Hex(stableStringify(body));
  }

  if (typeof body === "object") {
    return sha256Hex(stableStringify(body));
  }

  return sha256Hex(String(body));
}

function getScope(headers = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const apiKey = h["x-api-key"];
  return apiKey ? sha256Hex(String(apiKey)) : "global";
}

function generateDedupeKey({ target_url, method, headers = {}, body }) {
  const semanticHeaders = canonicalizeSemanticHeaders(headers);
  const contentType = semanticHeaders["content-type"] || "";

  const canonical = {
    v: 1,
    scope: getScope(headers),
    method: String(method).toUpperCase(),
    url: canonicalizeUrl(target_url),
    headers: semanticHeaders,
    body_hash: computeBodyHash(body, contentType),
  };

  return sha256Hex(stableStringify(canonical));
}

export default class ConsensusProxy {
  constructor() {
    this.cache = new NodeCache({ stdTTL: 300 });
    this.pendingRequests = new Map();
    this.paidKeys = new Map();
    this.stats = { total_requests: 0, cache_hits: 0, cache_misses: 0 };
    setInterval(() => this.cleanupExpiredKeys(), 60000);
  }

  requiresPayment(dedupeKey) {
    return !(this.cache.has(dedupeKey) || this.paidKeys.has(dedupeKey));
  }

  markAsPaid(dedupeKey) {
    this.paidKeys.set(dedupeKey, Date.now());
  }

  removePaidStatus(dedupeKey) {
    this.paidKeys.delete(dedupeKey);
  }

  async handleRequest(target_url, method, headers = {}, body) {
    const dedupeKey = generateDedupeKey({ target_url, method, headers, body });

    this.stats.total_requests++;

    const cached = this.cache.get(dedupeKey);
    if (cached) {
      this.stats.cache_hits++;
      return { ...cached, cached: true, payment_required: false, dedupe_key: dedupeKey };
    }

    if (this.pendingRequests.has(dedupeKey)) {
      try {
        const response = await this.pendingRequests.get(dedupeKey);
        this.stats.cache_hits++;
        return { ...response, cached: true, payment_required: false, dedupe_key: dedupeKey };
      } catch (error) {
        this.pendingRequests.delete(dedupeKey);
      }
    }

    this.stats.cache_misses++;

    const requestPromise = this.makeRequest(target_url, method, headers, body)
      .then((response) => {
        this.cache.set(dedupeKey, response);
        this.pendingRequests.delete(dedupeKey);
        return response;
      })
      .catch((error) => {
        this.pendingRequests.delete(dedupeKey);
        this.removePaidStatus(dedupeKey);
        throw error;
      });

    this.pendingRequests.set(dedupeKey, requestPromise);

    const response = await requestPromise;
    return { ...response, cached: false, payment_required: true, dedupe_key: dedupeKey };
  }

  async makeRequest(url, method, headers, body) {
    const cleanHeaders = { ...(headers || {}) };

    delete cleanHeaders["host"];
    delete cleanHeaders["content-length"];
    delete cleanHeaders["content-encoding"];
    delete cleanHeaders["transfer-encoding"];
    delete cleanHeaders["connection"];
    delete cleanHeaders["x-idempotency-key"];
    delete cleanHeaders["idempotency-key"];
    delete cleanHeaders["X-Idempotency-Key"];
    delete cleanHeaders["x-payment"];
    delete cleanHeaders["X-Payment"];
    delete cleanHeaders["x-verbose"];
    delete cleanHeaders["X-Verbose"];
    delete cleanHeaders["x-api-key"];
    delete cleanHeaders["X-Api-Key"];

    const config = {
      method: String(method).toLowerCase(),
      url,
      headers: cleanHeaders,
      timeout: 30000,
      validateStatus: () => true,
      maxRedirects: 5,
      decompress: false,
      responseType: "arraybuffer",
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    };

    if (body && ["post", "put", "patch"].includes(String(method).toLowerCase())) {
      config.data = body;
      if (!cleanHeaders["content-type"] && typeof body === "object") {
        config.headers["content-type"] = "application/json";
      }
    }

    try {
      const response = await axios(config);

      let rawData = response.data;
      const contentEncoding = String(response.headers?.["content-encoding"] || "").toLowerCase();

      if (contentEncoding === "gzip") rawData = await gunzipAsync(rawData);
      else if (contentEncoding === "deflate") rawData = await inflateAsync(rawData);
      else if (contentEncoding === "br") rawData = await brotliDecompressAsync(rawData);

      const textData = Buffer.from(rawData).toString("utf8");

      let parsed;
      try {
        parsed = JSON.parse(textData);
      } catch {
        parsed = textData;
      }

      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        data: parsed,
        timestamp: Date.now(),
      };
    } catch (error) {
      return {
        status: error.response?.status || 500,
        statusText: error.response?.statusText || "Internal Server Error",
        headers: error.response?.headers || {},
        data: {
          error: "Request failed",
          message: error.message,
          code: error.code,
          url,
        },
        timestamp: Date.now(),
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
      cache_stats: this.cache.getStats(),
    };
  }

  getPaymentStatus(dedupeKey) {
    return {
      is_cached: this.cache.has(dedupeKey),
      is_paid: this.paidKeys.has(dedupeKey),
      requires_payment: this.requiresPayment(dedupeKey),
    };
  }

  cleanupExpiredKeys() {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    for (const [key, timestamp] of this.paidKeys.entries()) {
      if (timestamp < fiveMinutesAgo) this.paidKeys.delete(key);
    }
  }

  clearKey(dedupeKey) {
    this.cache.del(dedupeKey);
    this.paidKeys.delete(dedupeKey);
    this.pendingRequests.delete(dedupeKey);
  }
}

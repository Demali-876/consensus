// x402-ws-session-types.js

export const METERING_UNITS = {
  TIME: 'seconds',
  DATA: 'bytes'
};

export const BILLING_UNITS = {
  TIME: 'minutes',
  DATA: 'megabytes'
};

export const CONVERSIONS = {
  SECONDS_PER_MINUTE: 60,
  BYTES_PER_KB: 1024,
  BYTES_PER_MB: 1024 * 1024,
  BYTES_PER_GB: 1024 * 1024 * 1024,
  MS_PER_SECOND: 1000
};

export function calculateSessionCost(pricing, minutes, megabytes) {
  let cost = 0;
  
  if (pricing.model === 'time' || pricing.model === 'hybrid') {
    cost += (minutes || 0) * pricing.pricePerMinute;
  }
  
  if (pricing.model === 'data' || pricing.model === 'hybrid') {
    cost += (megabytes || 0) * pricing.pricePerMB;
  }
  
  return cost;
}

export function calculateSessionLimits(pricing, paidMinutes, paidMegabytes) {
  let timeLimit;
  let dataLimit;
  
  if (pricing.model === 'time') {
    timeLimit = (paidMinutes || 0) * 60 * 1000;
    dataLimit = (paidMinutes || 0) * 100 * CONVERSIONS.BYTES_PER_MB;
  } else if (pricing.model === 'data') {
    dataLimit = (paidMegabytes || 0) * CONVERSIONS.BYTES_PER_MB;
    timeLimit = 60 * 60 * 1000;
  } else {
    timeLimit = (paidMinutes || 0) * 60 * 1000;
    dataLimit = (paidMegabytes || 0) * CONVERSIONS.BYTES_PER_MB;
  }
  
  return { timeLimit, dataLimit };
}

export function bytesToMB(bytes) {
  return bytes / CONVERSIONS.BYTES_PER_MB;
}

export function msToMinutes(ms) {
  return ms / (CONVERSIONS.MS_PER_SECOND * CONVERSIONS.SECONDS_PER_MINUTE);
}

export const PRICING_PRESETS = {
  TIME: {
    model: 'time',
    pricePerMinute: 0.0005,
    pricePerMB: 0,
    minTimeSeconds: 60,
    minDataMB: 0,
  },
  DATA: {
    model: 'data',
    pricePerMinute: 0,
    pricePerMB: 0.0001,
    minTimeSeconds: 0,
    minDataMB: 10,
  },
  HYBRID: {
    model: 'hybrid',
    pricePerMinute: 0.0005,
    pricePerMB: 0.0001,
    minTimeSeconds: 60,
    minDataMB: 10,
  }
};
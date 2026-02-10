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
    const cappedMinutes = Math.min(paidMinutes || 0, 1440);
    timeLimit = cappedMinutes * 60 * 1000;
    
    const timePremium = pricing.pricePerMinute - PRICING_PRESETS.HYBRID.pricePerMinute;
    const hybridDataPrice = PRICING_PRESETS.HYBRID.pricePerMB;
    const dataPerMinute = (timePremium / hybridDataPrice) * 0.5;
    const calculatedCapMB = cappedMinutes * dataPerMinute;
    
    const absoluteMaxMB = 500;
    dataLimit = Math.min(calculatedCapMB, absoluteMaxMB) * CONVERSIONS.BYTES_PER_MB;
    
  } else if (pricing.model === 'data') {
    const cappedMegabytes = Math.min(paidMegabytes || 0, 10240);
    dataLimit = cappedMegabytes * CONVERSIONS.BYTES_PER_MB;
    timeLimit = 24 * 60 * 60 * 1000;
    
  } else {
    const cappedMinutes = Math.min(paidMinutes || 0, 1440);
    timeLimit = cappedMinutes * 60 * 1000;
    
    const cappedMegabytes = Math.min(paidMegabytes || 0, 10240);
    dataLimit = cappedMegabytes * CONVERSIONS.BYTES_PER_MB;
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
    pricePerMinute: 0.001,
    pricePerMB: 0,
    minTimeSeconds: 60,
    minDataMB: 0,
    maxTimeHours: 24,
    maxDataMB: 500,
  },
  DATA: {
    model: 'data',
    pricePerMinute: 0,
    pricePerMB: 0.00012,
    minTimeSeconds: 0,
    minDataMB: 10,
    maxDataGB: 10,
    maxTimeHours: 24,
  },
  HYBRID: {
    model: 'hybrid',
    pricePerMinute: 0.0005,
    pricePerMB: 0.0001,
    minTimeSeconds: 60,
    minDataMB: 10,
    maxTimeHours: 24,
    maxDataGB: 10,
  }
};
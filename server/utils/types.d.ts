export interface PricingPreset {
  model: 'time' | 'data' | 'hybrid';
  pricePerMinute: number;
  pricePerMB: number;
  minTimeSeconds?: number;
  minDataMB?: number;
  maxTimeHours?: number;
  maxDataMB?: number;
  maxDataGB?: number;
}

export const METERING_UNITS: {
  TIME: 'seconds';
  DATA: 'bytes';
};

export const BILLING_UNITS: {
  TIME: 'minutes';
  DATA: 'megabytes';
};

export const CONVERSIONS: {
  SECONDS_PER_MINUTE: number;
  BYTES_PER_KB: number;
  BYTES_PER_MB: number;
  BYTES_PER_GB: number;
  MS_PER_SECOND: number;
};

export const PRICING_PRESETS: {
  TIME: PricingPreset;
  DATA: PricingPreset;
  HYBRID: PricingPreset;
};

export function calculateSessionCost(pricing: PricingPreset, minutes: number, megabytes: number): number;
export function calculateSessionLimits(pricing: PricingPreset, paidMinutes: number, paidMegabytes: number): {
  timeLimit: number;
  dataLimit: number;
};
export function bytesToMB(bytes: number): number;
export function msToMinutes(ms: number): number;

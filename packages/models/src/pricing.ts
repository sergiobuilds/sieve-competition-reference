export const PRICE_VERSION = "gemini-api-standard-2026-10-12";

export interface ModelPrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export const PRICES: Record<string, ModelPrice> = {
  "gemini-3.5-flash-lite": { inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5 },
  "gemini-3.8-flash": { inputPerMillionUsd: 0.75, outputPerMillionUsd: 3.75 },
  "gemini-3.1-pro-preview": { inputPerMillionUsd: 2, outputPerMillionUsd: 12 },
};

export const KRW_PER_USD = 1343.75;

export function priceKey(model: string): string {
  const base = model.split("/").pop() ?? model;
  return base;
}

export function costUsd(model: string, usage: Usage): number | null {
  const price = PRICES[priceKey(model)];
  if (!price) return null;
  const billedOutput = usage.outputTokens + usage.thinkingTokens;
  return (usage.inputTokens * price.inputPerMillionUsd + billedOutput * price.outputPerMillionUsd) / 1_000_000;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedTokens: number;
}


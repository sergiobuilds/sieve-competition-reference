import { costUsd, KRW_PER_USD, PRICE_VERSION, type Usage } from "../../models/src/index.js";

export type Stage = "extract" | "judge" | "recheck";

export interface UsageEvent {
  caseId: string;
  stage: Stage;
  model: string;
  provider: string;
  attempt: number;
  ok: boolean;
  usage: Usage;
  latencyMs: number;
  costUsd: number | null;
  priceVersion: string;
}

export function makeUsageEvent(e: Omit<UsageEvent, "costUsd" | "priceVersion">): UsageEvent {
  return { ...e, costUsd: costUsd(e.model, e.usage), priceVersion: PRICE_VERSION };
}

export function summarizeCostKrw(events: UsageEvent[]): number | null {
  if (events.some((e) => e.costUsd === null)) return null;
  return events.reduce((s, e) => s + (e.costUsd ?? 0), 0) * KRW_PER_USD;
}



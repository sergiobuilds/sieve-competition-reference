import type { Usage } from "./pricing.js";

export interface JsonSchema {
  [key: string]: unknown;
}

export interface GenerateRequest {
  model: string;
  system: string;
  user: string;
  schema: JsonSchema;
  pdfPaths?: string[];
  thinking?: "minimal" | "low";
}

export interface GenerateResult {
  json: unknown;
  rawText: string;
  usage: Usage;
  model: string;
  latencyMs: number;
}

export interface ModelProvider {
  name: string;
  generateJson(request: GenerateRequest): Promise<GenerateResult>;
}

export class ModelResponseError extends Error {
  constructor(
    message: string,
    readonly rawText: string,
    readonly usage: Usage,
  ) {
    super(message);
    this.name = "ModelResponseError";
  }
}

export function parseJsonText(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  return JSON.parse(trimmed);
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0 };


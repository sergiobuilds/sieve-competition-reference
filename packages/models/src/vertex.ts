import { readFileSync } from "node:fs";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { ModelResponseError, parseJsonText, type GenerateRequest, type GenerateResult, type ModelProvider } from "./provider.js";

export class VertexProvider implements ModelProvider {
  readonly name = "vertex";
  private readonly client: GoogleGenAI;

  constructor(project = process.env.GOOGLE_CLOUD_PROJECT, location = process.env.SIEVE_MODEL_LOCATION ?? "global") {
    if (!project) throw new Error("GOOGLE_CLOUD_PROJECT is not set");
    this.client = new GoogleGenAI({ vertexai: true, project, location, httpOptions: { timeout: 120_000 } });
  }

  async generateJson(request: GenerateRequest): Promise<GenerateResult> {
    const parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] = [{ text: request.user }];
    for (const path of request.pdfPaths ?? []) {
      const lower = path.toLowerCase();
      const mimeType = lower.endsWith(".pdf") ? "application/pdf" : lower.endsWith(".png") ? "image/png" : "image/jpeg";
      parts.push({ inlineData: { mimeType, data: readFileSync(path).toString("base64") } });
    }
    const started = Date.now();
    const response = await this.client.models.generateContent({
      model: request.model,
      contents: [{ role: "user", parts }],
      config: {
        systemInstruction: request.system,
        temperature: 0,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        responseJsonSchema: request.schema,
        thinkingConfig: { thinkingLevel: request.thinking === "minimal" && request.model.includes("flash-lite") ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW },
      },
    });
    const meta = response.usageMetadata;
    const usage = {
      inputTokens: meta?.promptTokenCount ?? 0,
      outputTokens: meta?.candidatesTokenCount ?? 0,
      thinkingTokens: meta?.thoughtsTokenCount ?? 0,
      cachedTokens: meta?.cachedContentTokenCount ?? 0,
    };
    const rawText = response.text ?? "";
    try {
      return { json: parseJsonText(rawText), rawText, usage, model: response.modelVersion ?? request.model, latencyMs: Date.now() - started };
    } catch {
      throw new ModelResponseError("response was not valid JSON", rawText, usage);
    }
  }
}


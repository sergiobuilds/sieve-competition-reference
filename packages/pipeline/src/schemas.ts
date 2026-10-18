import { z } from "zod";

const docTypes = [
  "quotation",
  "delivery_statement",
  "tax_invoice",
  "card_receipt",
  "meeting_minutes",
  "travel_report",
  "exception_approval",
  "other",
] as const;

export const extractionZod = z.object({
  docType: z.enum(docTypes),
  vendorId: z.string().nullable(),
  invoiceKey: z.string().nullable(),
  issueDate: z.string().nullable(),
  lineItems: z.array(z.object({ description: z.string(), qty: z.number().int(), unitPriceKrw: z.number().int() })),
  supplyKrw: z.number().int().nullable(),
  taxKrw: z.number().int().nullable(),
  totalKrw: z.number().int().nullable(),
  statesCancelledOrRevised: z.boolean().nullable(),
  quotes: z.array(z.object({ field: z.string(), quote: z.string() })),
  transcript: z.string(),
});

export const extractionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["docType", "vendorId", "invoiceKey", "issueDate", "lineItems", "supplyKrw", "taxKrw", "totalKrw", "statesCancelledOrRevised", "quotes", "transcript"],
  properties: {
    docType: { type: "string", enum: [...docTypes] },
    vendorId: { type: ["string", "null"] },
    invoiceKey: { type: ["string", "null"] },
    issueDate: { type: ["string", "null"] },
    lineItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "qty", "unitPriceKrw"],
        properties: { description: { type: "string" }, qty: { type: "integer" }, unitPriceKrw: { type: "integer" } },
      },
    },
    supplyKrw: { type: ["integer", "null"] },
    taxKrw: { type: ["integer", "null"] },
    totalKrw: { type: ["integer", "null"] },
    statesCancelledOrRevised: { type: ["boolean", "null"] },
    transcript: { type: "string" },
    quotes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "quote"],
        properties: { field: { type: "string" }, quote: { type: "string" } },
      },
    },
  },
};

const answers = ["YES", "NO", "UNKNOWN", "NA"] as const;

export const judgeZod = z.object({
  answers: z.array(
    z.object({
      questionId: z.string(),
      answer: z.enum(answers),
      evidence: z.array(z.object({ docId: z.string(), quote: z.string() })),
      ruleIds: z.array(z.string()).default([]),
    }),
  ),
});

export const judgeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answers"],
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["questionId", "answer", "evidence", "ruleIds"],
        properties: {
          questionId: { type: "string" },
          answer: { type: "string", enum: [...answers] },
          ruleIds: { type: "array", items: { type: "string" } },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["docId", "quote"],
              properties: { docId: { type: "string" }, quote: { type: "string" } },
            },
          },
        },
      },
    },
  },
};



import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CASES, POLICY } from "../../../data/synth/world.js";
import { ZERO_USAGE, type GenerateRequest, type ModelProvider } from "../../models/src/index.js";
import { QUESTIONNAIRE_V1 } from "../../questionnaire/src/index.js";
import { screenCase } from "../src/screen.js";
import { extractionJsonSchema } from "../src/schemas.js";

const base = CASES.find((c) => c.screening.id === "C001")!;
const knownTypes = new Set(["quotation", "delivery_statement", "tax_invoice", "card_receipt", "meeting_minutes", "travel_report", "exception_approval", "other"]);

interface InvoiceRead {
  totalKrw: number;
  cancelled: boolean;
}

function fakeProvider(invoices: Record<string, InvoiceRead>): ModelProvider {
  const docs = base.screening.documents;
  return {
    name: "fake",
    async generateJson(request: GenerateRequest) {
      let json: unknown;
      if (request.schema === extractionJsonSchema) {
        const id = /Document id: ([^.\n]+)/.exec(request.user)?.[1] ?? "";
        const doc = docs.find((d) => d.id === id);
        const invoice = invoices[id];
        json = {
          docType: invoice ? "tax_invoice" : knownTypes.has(doc?.type ?? "") ? doc?.type : "other",
          vendorId: base.screening.entry.vendorId,
          invoiceKey: base.screening.entry.invoiceKey,
          issueDate: "2026-05-12",
          lineItems: invoice ? [{ description: "item", qty: 1, unitPriceKrw: invoice.totalKrw - Math.round(invoice.totalKrw / 11) }] : [],
          supplyKrw: invoice ? invoice.totalKrw - Math.round(invoice.totalKrw / 11) : null,
          taxKrw: invoice ? Math.round(invoice.totalKrw / 11) : null,
          totalKrw: invoice ? invoice.totalKrw : null,
          statesCancelledOrRevised: invoice ? invoice.cancelled : null,
          quotes: [],
          transcript: doc?.text ?? "",
        };
      } else {
        const first = docs[0]!;
        json = {
          answers: QUESTIONNAIRE_V1.questions.map((q) => ({
            questionId: q.id,
            answer: q.role === "required_yes" ? "YES" : "NO",
            evidence: q.role === "required_yes" ? [{ docId: first.id, quote: first.text.split("\n")[0] }] : [],
            ruleIds: [],
          })),
        };
      }
      return { json, rawText: JSON.stringify(json), usage: ZERO_USAGE, model: "fake", latencyMs: 0 };
    },
  };
}

function screen(invoices: Record<string, InvoiceRead>, extraInvoiceDoc = false, extraAllocationKrw = 0) {
  const documents = extraInvoiceDoc
    ? [...base.screening.documents, { ...base.screening.documents[0]!, id: base.screening.id + "-D9" }]
    : base.screening.documents;
  const extra = { ...base.screening.entry, id: "C001-X", projectId: "SYN-PRJ-B", amountKrw: extraAllocationKrw };
  const scope = extraAllocationKrw > 0 ? { ...base.scope, entries: [...base.scope.entries, extra] } : base.scope;
  return screenCase(
    { ...base.screening, documents },
    {
      provider: fakeProvider(invoices),
      extractModel: "fake",
      judgeModel: "fake",
      recheckModel: "fake",
      cacheDir: mkdtempSync(join(tmpdir(), "sieve-screen-")),
      questionnaire: QUESTIONNAIRE_V1,
      policy: POLICY,
      scope,
      allocationProjectIds: base.allocationProjectIds,
      ruleApplicable: true,
    },
  );
}

describe("screenCase with unresolved payment totals", () => {
  it("clears a case whose single valid invoice covers the claim", async () => {
    const out = await screen({ "C001-D1": { totalKrw: 1_100_000, cancelled: false } });
    expect(out.decision.state).toBe("NO_FLAGS");
  });
  it("asks for evidence when only a cancelled invoice was read", async () => {
    const out = await screen({ "C001-D1": { totalKrw: 1_100_000, cancelled: true } });
    expect(out.decision.state).toBe("NEEDS_EVIDENCE");
    expect(out.decision.reasonCodes).toContain("check:ledger_total_unresolved");
  });
  it("leaves allocation open and asks for evidence when two valid invoices only together cover the claim", async () => {
    const out = await screen({ "C001-D1": { totalKrw: 660_000, cancelled: false }, "C001-D9": { totalKrw: 440_000, cancelled: false } }, true);
    expect(out.decision.checks.find((x) => x.id === "allocation_total")?.status).toBe("unknown");
    expect(out.decision.state).toBe("NEEDS_EVIDENCE");
  });
  it("asks for evidence when one of two valid invoices covers the claim and together they cover the allocations", async () => {
    const out = await screen({ "C001-D1": { totalKrw: 1_100_000, cancelled: false }, "C001-D9": { totalKrw: 440_000, cancelled: false } }, true);
    expect(out.decision.state).toBe("NEEDS_EVIDENCE");
    expect(out.decision.reasonCodes).toContain("check:allocation_unresolved");
  });
  it("flags allocations that exceed every valid invoice combined", async () => {
    const out = await screen({ "C001-D1": { totalKrw: 1_100_000, cancelled: false }, "C001-D9": { totalKrw: 440_000, cancelled: false } }, true, 1_100_000);
    expect(out.decision.state).toBe("FLAGGED");
    expect(out.decision.checks.find((x) => x.id === "allocation_total")?.amountKrw).toBe(660_000);
  });
});


import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Answer, DocType } from "../../core/src/index.js";
import { ZERO_USAGE, type ModelProvider } from "../../models/src/index.js";
import { judgeJsonSchema } from "../../pipeline/src/schemas.js";
import { retrieveRules } from "../../rules/src/library.js";
import { readSubsidyLibrary, scopedLibrary } from "../src/library.js";
import { CHECKLIST, demoInput, programFor, screenInputSchema, screenSubsidy } from "../src/screen.js";

const library = readSubsidyLibrary(resolve("data/subsidy/library.json"));
type Scenario = {
  readonly evidence?: "mixed" | "rule-only" | "empty" | "valid-mixed";
  readonly negative?: "fabricated" | "mixed" | "valid";
  readonly negativeId?: string;
  readonly risk?: Answer;
  readonly exception?: Answer;
  readonly total?: number | null;
  readonly vendor?: string | null;
  readonly ledgerVendor?: string;
  readonly docType?: DocType;
  readonly tax?: number;
  readonly items?: "empty" | "null";
};
async function run(scenario: Scenario = {}) {
  const input = screenInputSchema.parse(demoInput(library, "patent"));
  if (scenario.ledgerVendor !== undefined) input.entry.vendorId = scenario.ledgerVendor;
  input.documents = input.documents.map((d) => d.id === "SAMPLE-INVOICE" ? { ...d, type: scenario.docType ?? d.type } : d);
  const program = programFor(library, input.programId);
  const query = [input.entry.purpose, input.entry.budgetItem, input.entry.subItem, ...input.documents.map((d) => d.type), "증빙 불인정 집행 기준"].join(" ");
  const rule = retrieveRules(scopedLibrary(library, program), program, query, 8, 10).layer2[0];
  if (!rule) throw new Error("Fixture requires a retrieved rule");
  const valid = { docId: "SAMPLE-INVOICE", quote: "세금계산서 SAMPLE-INV-01" };
  const fabricated = { docId: valid.docId, quote: "This quotation was invented" };
  const citedRule = { docId: rule.id, quote: rule.text.slice(0, 70) };
  const provider: ModelProvider = { name: "scripted-malformed-model-boundary", async generateJson(req) {
    const json = req.schema === judgeJsonSchema ? {
      answers: CHECKLIST.questions.map((q) => {
        let answer: Answer = q.role === "required_yes" ? "YES" : "NO";
        let evidence = q.role === "required_yes" ? [valid] : [];
        if (q.role === "required_yes") {
          switch (scenario.evidence) {
            case "mixed": evidence = [fabricated, citedRule]; break;
            case "rule-only": evidence = [citedRule]; break;
            case "empty": evidence = []; break;
            case "valid-mixed": evidence = [valid, citedRule]; break;
          }
        }
        if (q.id === (scenario.negativeId ?? "program_disallowed")) {
          switch (scenario.negative) {
            case "fabricated": evidence = [fabricated]; break;
            case "mixed": evidence = [fabricated, citedRule]; break;
            case "valid": evidence = [valid]; break;
          }
        }
        if (q.id === "payment_method" && scenario.risk) answer = scenario.risk;
        if (q.role === "exception" && scenario.exception) answer = scenario.exception;
        return { questionId: q.id, answer, evidence, ruleIds: [rule.id] };
      }),
    } : {
      docType: req.user.startsWith("Document id: SAMPLE-INVOICE\n") ? scenario.docType ?? "tax_invoice" : "other",
      vendorId: scenario.vendor === undefined ? "SAMPLE-VENDOR" : scenario.vendor,
      invoiceKey: "SAMPLE-INV-01", issueDate: "2026-06-15",
      lineItems: scenario.items === "null" ? null : scenario.items === "empty" ? [] : [{ description: "service", qty: 1, unitPriceKrw: 1_000_000 }],
      supplyKrw: 1_000_000, taxKrw: scenario.tax ?? 100_000,
      totalKrw: scenario.total === undefined ? 1_100_000 : scenario.total,
      statesCancelledOrRevised: false, quotes: [], transcript: "",
    };
    return { json, rawText: JSON.stringify(json), usage: ZERO_USAGE, model: req.model, latencyMs: 0 };
  } };
  const cacheDir = mkdtempSync(join(tmpdir(), "sieve-decision-regressions-"));
  try {
    return await screenSubsidy(input, library, { provider, reader: "scripted", judge: "scripted", recheck: "scripted", cacheDir });
  } finally { rmSync(cacheDir, { recursive: true, force: true }); }
}

describe("adversarial decision boundary", () => {
  it.each(["mixed", "rule-only", "empty"] as const)("does not clear required YES with %s evidence", async (evidence) => {
    // Given required facts without a verified document quotation.
    // When the model response crosses the real judging boundary.
    const out = await run({ evidence });
    // Then no rule quotation can substitute for document evidence.
    expect(out.result.decision.state).not.toBe("NO_FLAGS");
  });
  it.each(["program_disallowed", "required_evidence_missing", "instruction_text"])("does not clear fabricated decisive NO for %s", async (negativeId) => {
    // Given an explicitly fabricated quotation supporting a decisive NO.
    // When the response is screened, including a genuine rule quotation.
    const out = await run({ negativeId, negative: "mixed" });
    // Then the invented quotation remains a review reason.
    expect(out.result.decision.state).toBe("FLAGGED");
    expect(out.result.decision.reasonCodes).toContain("evidence:quote_not_verified");
  });
  it.each(["tax_invoice", "card_receipt"] as const)("requires evidence when %s total is entirely unread", async (docType) => {
    // Given a payment document with no readable total.
    // When screening otherwise conclusive answers.
    const out = await run({ docType, total: null, items: "empty" });
    // Then the payment amount is unresolved.
    expect(out.result.decision.state).toBe("NEEDS_EVIDENCE");
    expect(out.result.decision.reasonCodes).toContain("check:ledger_total_unresolved");
  });
  it("requires evidence when material vendor is unread despite a valid total", async () => {
    // Given a named ledger vendor but no readable payment vendor.
    // When screening the payment.
    const out = await run({ vendor: null });
    // Then matching the total does not establish the counterparty.
    expect(out.result.decision.state).toBe("NEEDS_EVIDENCE");
    expect(out.result.decision.reasonCodes).toContain("check:vendor_unresolved");
  });
  it("keeps suspicion UNKNOWN unresolved after a successful recheck", async () => {
    // Given the same unanswered payment risk on both model calls.
    // When the recheck returns successfully.
    const out = await run({ risk: "UNKNOWN" });
    // Then call success does not imply decision resolution.
    expect(out.result.recheckStatus).toBe("succeeded");
    expect(out.result.decision.state).toBe("NEEDS_EVIDENCE");
    expect(out.result.decision.reasonCodes).toContain("question:unresolved:payment_method");
  });
  it("flags card receipt arithmetic contradictions", async () => {
    // Given 1,000,000 in items plus zero tax but a 1,100,000 total.
    // When the card receipt is screened.
    const out = await run({ docType: "card_receipt", tax: 0 });
    // Then the code reports the 100,000 discrepancy.
    expect(out.result.decision.state).toBe("FLAGGED");
    expect(out.result.decision.checks).toContainEqual(expect.objectContaining({ id: "arithmetic", status: "fail", amountKrw: 100_000 }));
  });
  it("reports unknown arithmetic for a card receipt without itemization", async () => {
    // Given a readable total and vendor but no itemized amounts.
    // When screening the card receipt.
    const out = await run({ docType: "card_receipt", items: "empty" });
    // Then unavailable arithmetic is not a fabricated discrepancy.
    expect(out.result.decision.checks).toContainEqual(expect.objectContaining({ id: "arithmetic", status: "unknown" }));
    expect(out.result.decision.checks.some((c) => c.status === "fail")).toBe(false);
  });
  it("requests evidence rather than an arithmetic failure for malformed null items", async () => {
    // Given a schema-invalid model payload with null lineItems.
    // When all extraction attempts return that payload.
    const out = await run({ docType: "card_receipt", items: "null" });
    // Then extraction remains unread and no arithmetic failure is invented.
    expect(out.result.decision.state).toBe("NEEDS_EVIDENCE");
    expect(out.result.decision.checks.some((c) => c.id === "arithmetic" && c.status === "fail")).toBe(false);
  });
  it.each([
    { name: "absence answers without quotations", scenario: {} },
    { name: "verified document plus rule", scenario: { evidence: "valid-mixed" } },
    { name: "verified negative quotation", scenario: { negative: "valid" } },
    { name: "exception UNKNOWN alone", scenario: { exception: "UNKNOWN" } },
    { name: "valid card receipt", scenario: { docType: "card_receipt" } },
    { name: "non-payment expense", scenario: { docType: "travel_report", total: null, vendor: null, items: "empty" } },
    { name: "no ledger vendor requirement", scenario: { ledgerVendor: "", vendor: null } },
  ] satisfies { name: string; scenario: Scenario }[])("preserves $name and intentional cross-ledger not_run", async ({ scenario }) => {
    // Given a conclusive case without the defective conditions.
    // When screening through the subsidy wrapper.
    const out = await run(scenario);
    // Then unrelated unknown/not_run results do not overblock.
    expect(out.result.decision.state).toBe("NO_FLAGS");
    expect(out.result.decision.coverage.notRun).toEqual(expect.arrayContaining(["allocation_total", "split_purchase"]));
  });
});

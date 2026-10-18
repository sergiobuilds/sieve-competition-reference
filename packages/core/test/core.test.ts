import { describe, expect, it } from "vitest";
import { checkAllocationTotal, checkArithmetic, checkLedgerVsDocTotal, checkSplitPurchase, checkVendorMatch, decide, type ExtractedFacts, type LedgerEntry, type Policy } from "../src/index.js";

const policy: Policy = { id: "p", version: "1", projects: [{ id: "A", start: "2026-01-01", end: "2026-12-31" }], splitThresholdKrw: 20_000_000, splitWindowDays: 30, highValueKrw: 10_000_000 };

function entry(over: Partial<LedgerEntry>): LedgerEntry {
  return { caseId: "c", projectId: "A", vendorId: "V", invoiceKey: "INV", amountKrw: 700_000, executedAt: "2026-05-01", purpose: "p", active: true, ...over };
}

function facts(over: Partial<ExtractedFacts>): ExtractedFacts {
  return { docId: "d", docType: "tax_invoice", vendorId: "V", invoiceKey: "INV", issueDate: "2026-05-01", lineItems: [{ description: "x", qty: 3, unitPriceKrw: 40_000 }], supplyKrw: 120_000, taxKrw: 12_000, totalKrw: 132_000, statesCancelledOrRevised: false, quotes: [], ...over };
}

describe("allocation total", () => {
  it("passes a legitimate split within the invoice total", () => {
    const scope = { entries: [entry({ projectId: "A", amountKrw: 700_000 }), entry({ projectId: "B", amountKrw: 400_000 })], coveredProjectIds: ["A", "B"] };
    expect(checkAllocationTotal(entry({}), 1_100_000, scope, ["A", "B"]).status).toBe("pass");
  });
  it("flags the excess when allocations exceed the invoice", () => {
    const scope = { entries: [entry({ projectId: "A", amountKrw: 700_000 }), entry({ projectId: "C", amountKrw: 600_000 })], coveredProjectIds: ["A", "C"] };
    const r = checkAllocationTotal(entry({}), 1_100_000, scope, ["A", "C"]);
    expect(r.status).toBe("fail");
    expect(r.amountKrw).toBe(200_000);
  });
  it("ignores cancelled allocations", () => {
    const scope = { entries: [entry({ projectId: "A", amountKrw: 700_000 }), entry({ projectId: "C", amountKrw: 600_000, active: false })], coveredProjectIds: ["A", "C"] };
    expect(checkAllocationTotal(entry({}), 1_100_000, scope, ["A", "C"]).status).toBe("pass");
  });
  it("does not run when another project's ledger is missing", () => {
    const scope = { entries: [entry({ projectId: "A" })], coveredProjectIds: ["A"] };
    expect(checkAllocationTotal(entry({}), 1_100_000, scope, ["A", "C"]).status).toBe("not_run");
  });
});

describe("arithmetic", () => {
  it("flags a total that differs from items plus tax", () => {
    const r = checkArithmetic(facts({ totalKrw: 152_000 }));
    expect(r.status).toBe("fail");
    expect(r.amountKrw).toBe(20_000);
  });
  it("passes a consistent invoice", () => {
    expect(checkArithmetic(facts({})).status).toBe("pass");
  });
});

describe("vendor match", () => {
  it("does not treat a name that merely contains the ledger vendor as the same vendor", () => {
    expect(checkVendorMatch(entry({ vendorId: "ABC" }), [facts({ vendorId: "ABCOTHER" })]).status).toBe("fail");
  });
  it("matches on a shared registration identifier even when the names differ", () => {
    expect(checkVendorMatch(entry({ vendorId: "SYN-V-101" }), [facts({ vendorId: "가상바이오상사 (등록번호 SYN-V-101)" })]).status).toBe("pass");
    expect(checkVendorMatch(entry({ vendorId: "123-45-67890" }), [facts({ vendorId: "(주)가상 123-45-67899" })]).status).toBe("fail");
  });
  it("compares business numbers with or without hyphens and not as part of a longer number", () => {
    expect(checkVendorMatch(entry({ vendorId: "123-45-67890" }), [facts({ vendorId: "상사 1234567890" })]).status).toBe("pass");
    expect(checkVendorMatch(entry({ vendorId: "123-45-67890" }), [facts({ vendorId: "0123-45-67890" })]).status).toBe("fail");
  });
  it("treats a blank vendor as unread", () => {
    expect(checkVendorMatch(entry({ vendorId: "SYN-V-101" }), [facts({ vendorId: "  " })]).status).toBe("unknown");
  });
  it("does not match a vendor code that continues with more letters", () => {
    expect(checkVendorMatch(entry({ vendorId: "SYN-V-101" }), [facts({ vendorId: "SYN-V-101OTHER" })]).status).toBe("fail");
  });
  it("does not decide when the ledger vendor is blank after normalization", () => {
    expect(checkVendorMatch(entry({ vendorId: "(주) " }), [facts({ vendorId: "가상상사" })]).status).toBe("unknown");
    expect(checkVendorMatch(entry({ vendorId: "ABC" }), [facts({ vendorId: "(주)" })]).status).toBe("unknown");
  });
});

describe("ledger versus payment documents", () => {
  it("does not decide when several payments only together reach the claimed amount", () => {
    const r = checkLedgerVsDocTotal(entry({ amountKrw: 100 }), [facts({ docId: "a", totalKrw: 60 }), facts({ docId: "b", totalKrw: 40 })]);
    expect(r.status).toBe("unknown");
  });
  it("does not pass when only cancelled payment documents were read", () => {
    expect(checkLedgerVsDocTotal(entry({ amountKrw: 100 }), [facts({ totalKrw: 100, statesCancelledOrRevised: true })]).status).toBe("unknown");
  });
  it("fails when the largest valid payment is below the claim", () => {
    expect(checkLedgerVsDocTotal(entry({ amountKrw: 100 }), [facts({ totalKrw: 70 })]).status).toBe("fail");
  });
});

describe("split purchase", () => {
  it("flags purchases that each stay below the threshold but exceed it together", () => {
    const parts = [1, 2, 3].map((i) => entry({ caseId: "s" + i, amountKrw: 9_500_000, executedAt: "2026-05-0" + i }));
    const r = checkSplitPurchase(parts[0]!, { entries: parts, coveredProjectIds: ["A"] }, policy);
    expect(r.status).toBe("fail");
    expect(r.amountKrw).toBe(28_500_000);
  });
});

describe("decision table", () => {
  const base = { caseId: "c", ruleApplicable: true, gateHandled: false, comparedProjects: ["A"], suspicionQuestions: ["s"], requiredYesQuestions: ["r"], exceptionQuestions: ["e"] };
  it("never passes an UNKNOWN required answer", () => {
    const d = decide({ ...base, checks: [], questions: [{ questionId: "r", answer: "UNKNOWN", evidence: [] }] });
    expect(d.state).toBe("NEEDS_EVIDENCE");
  });
  it("does not pass when a cross-check was not run", () => {
    const d = decide({ ...base, checks: [{ id: "allocation_total", status: "not_run", detail: "" }], questions: [{ questionId: "r", answer: "YES", evidence: [] }] });
    expect(d.state).toBe("NEEDS_EVIDENCE");
    expect(d.coverage.notRun).toContain("allocation_total");
  });
  it("flags a failed rule check", () => {
    const d = decide({ ...base, checks: [{ id: "allocation_total", status: "fail", detail: "", amountKrw: 200_000 }], questions: [{ questionId: "r", answer: "YES", evidence: [] }] });
    expect(d.state).toBe("FLAGGED");
  });
  it("clears a split finding when an approved exception exists", () => {
    const d = decide({ ...base, checks: [{ id: "split_purchase", status: "fail", detail: "" }], questions: [{ questionId: "r", answer: "YES", evidence: [] }, { questionId: "e", answer: "YES", evidence: [] }] });
    expect(d.state).toBe("NO_FLAGS");
  });
  it("keeps a period violation even when an exception is approved", () => {
    const d = decide({ ...base, checks: [{ id: "period", status: "fail", detail: "" }, { id: "split_purchase", status: "fail", detail: "" }], questions: [{ questionId: "r", answer: "YES", evidence: [] }, { questionId: "e", answer: "YES", evidence: [] }] });
    expect(d.state).toBe("FLAGGED");
    expect(d.reasonCodes).toContain("check:period");
    expect(d.reasonCodes).not.toContain("check:split_purchase");
  });
  it("routes undetermined rules to the approver", () => {
    const d = decide({ ...base, ruleApplicable: false, checks: [], questions: [{ questionId: "r", answer: "YES", evidence: [] }] });
    expect(d.state).toBe("RULE_UNDETERMINED");
  });
  it("asks for evidence only when a missing document is named", () => {
    const named = decide({ ...base, missingEvidenceQuestions: ["m"], checks: [], questions: [{ questionId: "r", answer: "YES", evidence: [] }, { questionId: "m", answer: "YES", evidence: [] }] });
    const unsure = decide({ ...base, missingEvidenceQuestions: ["m"], checks: [], questions: [{ questionId: "r", answer: "YES", evidence: [] }, { questionId: "m", answer: "UNKNOWN", evidence: [] }] });
    expect(named.state).toBe("NEEDS_EVIDENCE");
    expect(unsure.state).toBe("NO_FLAGS");
  });
});



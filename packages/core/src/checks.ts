import type {
  CheckId,
  CheckResult,
  DocType,
  ExtractedFacts,
  LedgerEntry,
  LedgerScope,
  Policy,
  ScreeningCase,
} from "./types.js";

const DAY_MS = 86_400_000;

export const CHECK_RULES: Record<CheckId, string> = {
  required_docs: "R-EVIDENCE",
  period: "R-PERIOD",
  arithmetic: "R-EVIDENCE",
  ledger_vs_doc_total: "R-EVIDENCE",
  vendor_match: "R-EVIDENCE",
  allocation_total: "R-DUPLICATE",
  split_purchase: "R-SPLIT",
  injection_text: "R-EVIDENCE",
};

function toDay(date: string): number {
  const ms = Date.parse(date + "T00:00:00Z");
  if (Number.isNaN(ms)) throw new Error("invalid date: " + date);
  return Math.floor(ms / DAY_MS);
}

export function checkRequiredDocs(c: ScreeningCase): CheckResult {
  if (c.requiredDocTypes.length === 0) return { id: "required_docs", status: "not_run", detail: "required document list not configured" };
  const present = new Set<DocType>(c.documents.map((d) => d.type));
  const missing = c.requiredDocTypes.filter((t) => !present.has(t));
  return missing.length === 0
    ? { id: "required_docs", status: "pass", detail: "all required documents present" }
    : { id: "required_docs", status: "fail", detail: "missing: " + missing.join(", ") };
}

export function checkPeriod(entry: LedgerEntry, policy: Policy): CheckResult {
  const project = policy.projects.find((p) => p.id === entry.projectId);
  if (!project) return { id: "period", status: "not_run", detail: "project period not provided" };
  const day = toDay(entry.executedAt);
  if (day < toDay(project.start) || day > toDay(project.end)) {
    return {
      id: "period",
      status: "fail",
      detail: "executed " + entry.executedAt + " outside " + project.start + "~" + project.end,
      amountKrw: entry.amountKrw,
    };
  }
  return { id: "period", status: "pass", detail: "within project period" };
}

export function checkArithmetic(facts: ExtractedFacts): CheckResult {
  if (facts.totalKrw === null || facts.lineItems.length === 0) {
    return { id: "arithmetic", status: "unknown", detail: facts.docId + ": total or line items not read" };
  }
  const lines = facts.lineItems.reduce((sum, l) => sum + l.qty * l.unitPriceKrw, 0);
  const expected = lines + (facts.taxKrw ?? 0);
  const diff = facts.totalKrw - expected;
  return diff === 0
    ? { id: "arithmetic", status: "pass", detail: facts.docId + ": total matches line items and tax" }
    : {
        id: "arithmetic",
        status: "fail",
        detail: facts.docId + ": stated total " + facts.totalKrw + " vs computed " + expected,
        amountKrw: Math.abs(diff),
      };
}

export function checkLedgerVsDocTotal(entry: LedgerEntry, facts: ExtractedFacts[]): CheckResult {
  const money = facts.filter((f) => (f.docType === "tax_invoice" || f.docType === "card_receipt") && f.totalKrw !== null);
  if (money.length === 0) return { id: "ledger_vs_doc_total", status: "unknown", detail: "no payment document total was read" };
  const valid = money.filter((f) => !f.statesCancelledOrRevised);
  if (valid.length === 0) return { id: "ledger_vs_doc_total", status: "unknown", detail: "only cancelled or revised payment documents were read" };
  if (valid.some((f) => (f.totalKrw ?? 0) >= entry.amountKrw)) return { id: "ledger_vs_doc_total", status: "pass", detail: "claimed amount is covered by a payment document" };
  const sum = valid.reduce((s, f) => s + (f.totalKrw ?? 0), 0);
  if (valid.length > 1 && sum >= entry.amountKrw) return { id: "ledger_vs_doc_total", status: "unknown", detail: "several payment documents together reach the claimed amount; their relation needs a reviewer" };
  const mismatch = valid.reduce((a, b) => ((a.totalKrw ?? 0) >= (b.totalKrw ?? 0) ? a : b));
  return {
    id: "ledger_vs_doc_total",
    status: "fail",
    detail: "claimed " + entry.amountKrw + " exceeds " + mismatch.docId + " total " + mismatch.totalKrw,
    amountKrw: entry.amountKrw - (mismatch.totalKrw ?? 0),
  };
}

export function checkVendorMatch(entry: LedgerEntry, facts: ExtractedFacts[]): CheckResult {
  if (!entry.vendorId) return { id: "vendor_match", status: "not_run", detail: "ledger has no vendor" };
  const norm = (v: string) => v.normalize("NFKC").replace(/\(주\)|주식회사|㈜|[\s\-]/g, "").toLowerCase();
  const read = facts.filter((f) => (f.docType === "tax_invoice" || f.docType === "card_receipt") && norm(f.vendorId ?? "").length > 0);
  if (read.length === 0) return { id: "vendor_match", status: "unknown", detail: "no vendor id was read" };
  const ids = (v: string) => {
    const s = v.normalize("NFKC");
    const business = [...s.matchAll(/(?<![\d-])(\d{3})-?(\d{2})-?(\d{5})(?![\d-])/g)].map((m) => "biz:" + m[1] + m[2] + m[3]);
    const codes = [...s.matchAll(/(?<![A-Za-z0-9-])([A-Za-z]+(?:-[A-Za-z]+)*-\d+)(?![A-Za-z0-9-])/g)].map((m) => "code:" + norm(m[1]!));
    return new Set([...business, ...codes]);
  };
  const ledgerIds = ids(entry.vendorId);
  const ledgerVendor = norm(entry.vendorId);
  if (ledgerVendor.length === 0) return { id: "vendor_match", status: "unknown", detail: "ledger vendor is blank after normalization" };
  const other = read.find((f) => {
    const v = norm(f.vendorId ?? "");
    if (v.length === 0) return false;
    const docIds = ids(f.vendorId ?? "");
    if (ledgerIds.size > 0 && docIds.size > 0) return ![...docIds].some((id) => ledgerIds.has(id));
    return v !== ledgerVendor;
  });
  return other
    ? { id: "vendor_match", status: "fail", detail: other.docId + " vendor " + other.vendorId + " vs ledger " + entry.vendorId }
    : { id: "vendor_match", status: "pass", detail: "vendor matches" };
}

export function checkAllocationTotal(
  entry: LedgerEntry,
  invoiceTotalKrw: number | null,
  scope: LedgerScope,
  requiredProjectIds: string[],
): CheckResult {
  const missingScope = requiredProjectIds.filter((p) => !scope.coveredProjectIds.includes(p));
  if (missingScope.length > 0) {
    return { id: "allocation_total", status: "not_run", detail: "ledger not provided for: " + missingScope.join(", ") };
  }
  if (invoiceTotalKrw === null) return { id: "allocation_total", status: "unknown", detail: "invoice total not read" };
  const active = scope.entries.filter((e) => e.invoiceKey === entry.invoiceKey && e.active);
  const allocated = active.reduce((sum, e) => sum + e.amountKrw, 0);
  if (allocated <= invoiceTotalKrw) {
    return { id: "allocation_total", status: "pass", detail: "allocated " + allocated + " of " + invoiceTotalKrw };
  }
  return {
    id: "allocation_total",
    status: "fail",
    detail: "allocated " + allocated + " across " + active.map((e) => e.projectId).join("+") + " exceeds invoice " + invoiceTotalKrw,
    amountKrw: allocated - invoiceTotalKrw,
  };
}

export function checkSplitPurchase(entry: LedgerEntry, scope: LedgerScope, policy: Policy): CheckResult {
  if (!scope.coveredProjectIds.includes(entry.projectId)) {
    return { id: "split_purchase", status: "not_run", detail: "project ledger not provided" };
  }
  const day = toDay(entry.executedAt);
  const group = scope.entries.filter(
    (e) =>
      e.active &&
      e.vendorId === entry.vendorId &&
      e.projectId === entry.projectId &&
      e.purpose === entry.purpose &&
      Math.abs(toDay(e.executedAt) - day) <= policy.splitWindowDays,
  );
  const total = group.reduce((s, e) => s + e.amountKrw, 0);
  const eachBelow = group.every((e) => e.amountKrw < policy.splitThresholdKrw);
  if (group.length >= 2 && eachBelow && total > policy.splitThresholdKrw) {
    return {
      id: "split_purchase",
      status: "fail",
      detail: group.length + " purchases from " + entry.vendorId + " total " + total + " (threshold " + policy.splitThresholdKrw + ")",
      amountKrw: total,
    };
  }
  return { id: "split_purchase", status: "pass", detail: "no split pattern" };
}

const INJECTION_PATTERNS = [
  /ignore (all|previous|the above) instructions/i,
  /mark (this|all) (as )?(normal|approved|compliant)/i,
  /(자동|AI|검토자).{0,10}(정상|적정|승인).{0,6}(처리|판정)/,
  /이전 지시.{0,6}무시/,
];

export function checkInjectionText(c: ScreeningCase): CheckResult {
  const hit = c.documents.find((d) => INJECTION_PATTERNS.some((p) => p.test(d.text)));
  return hit
    ? { id: "injection_text", status: "fail", detail: hit.id + " contains instruction-like text" }
    : { id: "injection_text", status: "pass", detail: "no instruction-like text" };
}



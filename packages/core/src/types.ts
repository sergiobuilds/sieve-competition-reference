export type IsoDate = string;

export type Answer = "YES" | "NO" | "UNKNOWN" | "NA";

export type ScreeningState =
  | "NO_FLAGS"
  | "NEEDS_EVIDENCE"
  | "FLAGGED"
  | "EXTERNAL_CHECK"
  | "INVESTIGATION"
  | "RULE_UNDETERMINED"
  | "FAILED";

export type DocType =
  | "quotation"
  | "delivery_statement"
  | "tax_invoice"
  | "card_receipt"
  | "meeting_minutes"
  | "travel_report"
  | "exception_approval"
  | "other";

export interface EvidenceDoc {
  id: string;
  type: DocType;
    text: string;
    pdfPath?: string;
}

export interface LedgerEntry {
  caseId: string;
  projectId: string;
  vendorId: string;
  invoiceKey: string;
  amountKrw: number;
  executedAt: IsoDate;
  purpose: string;
  active: boolean;
  budgetItem?: string;
  subItem?: string;
}

export interface Project {
  id: string;
  start: IsoDate;
  end: IsoDate;
}

export interface ScreeningCase {
  id: string;
  entry: LedgerEntry;
  documents: EvidenceDoc[];
  requiredDocTypes: DocType[];
}

export interface LedgerScope {
  entries: LedgerEntry[];
  coveredProjectIds: string[];
}

export interface Policy {
  id: string;
  version: string;
  projects: Project[];
    splitThresholdKrw: number;
  splitWindowDays: number;
  highValueKrw: number;
}

export interface ExtractedFacts {
  docId: string;
  docType: DocType;
  vendorId: string | null;
  invoiceKey: string | null;
  issueDate: IsoDate | null;
  lineItems: { description: string; qty: number; unitPriceKrw: number }[];
  supplyKrw: number | null;
  taxKrw: number | null;
  totalKrw: number | null;
  statesCancelledOrRevised: boolean | null;
  quotes: { field: string; quote: string }[];
  transcript?: string;
}

export interface EvidenceRef {
  docId: string;
  quote: string;
  verified: boolean;
  source?: "document" | "rule";
}

export interface CheckResult {
  id: CheckId;
  status: "pass" | "fail" | "not_run" | "unknown";
  detail: string;
  amountKrw?: number;
}

export type CheckId =
  | "required_docs"
  | "period"
  | "arithmetic"
  | "ledger_vs_doc_total"
  | "vendor_match"
  | "allocation_total"
  | "split_purchase"
  | "injection_text";

export interface QuestionResult {
  questionId: string;
  answer: Answer;
  evidence: EvidenceRef[];
  ruleIds?: string[];
}

export interface Decision {
  caseId: string;
  state: ScreeningState;
  reasonCodes: string[];
  checks: CheckResult[];
  questions: QuestionResult[];
  coverage: { checked: CheckId[]; notRun: CheckId[]; comparedProjects: string[] };
  gateHandled: boolean;
}



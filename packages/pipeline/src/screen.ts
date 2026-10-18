import {
  checkAllocationTotal,
  checkArithmetic,
  checkInjectionText,
  checkLedgerVsDocTotal,
  checkPeriod,
  checkRequiredDocs,
  checkSplitPurchase,
  checkVendorMatch,
  decide,
  type CheckResult,
  type Decision,
  type ExtractedFacts,
  type LedgerScope,
  type Policy,
  type QuestionResult,
  type ScreeningCase,
} from "../../core/src/index.js";
import type { ModelProvider } from "../../models/src/index.js";
import { idsByRole, type Questionnaire } from "../../questionnaire/src/index.js";
import { identifyProgram, retrieveRules, type Library, type RetrievedRules } from "../../rules/src/library.js";
import { extractFacts } from "./extract.js";
import { judgeCase } from "./judge.js";
import type { UsageEvent } from "./usage.js";

export interface ScreenConfig {
  provider: ModelProvider;
  extractModel: string;
  judgeModel: string;
  recheckModel: string;
  cacheDir: string;
  questionnaire: Questionnaire;
  policy: Policy;
  scope: LedgerScope;
  allocationProjectIds: string[];
  ruleApplicable: boolean;
  library?: Library;
  programName?: string;
}

export interface ScreenOutput {
  decision: Decision;
  facts: ExtractedFacts[];
  usage: UsageEvent[];
  latencyMs: number;
  llmCalls: number;
  rechecked: boolean;
  readonly recheckStatus: "not_needed" | "succeeded" | "failed" | "disagreed";
  readonly recheck: {
    readonly attempted: boolean;
    readonly firstResults: QuestionResult[] | null;
    readonly secondResults: QuestionResult[] | null;
  };
  rules?: RetrievedRules;
}

function decisionInput(c: ScreeningCase, cfg: ScreenConfig, checks: CheckResult[], questions: QuestionResult[], gateHandled: boolean) {
  return {
    caseId: c.id,
    checks,
    questions,
    ruleApplicable: cfg.ruleApplicable,
    gateHandled,
    comparedProjects: cfg.scope.coveredProjectIds,
    suspicionQuestions: idsByRole(cfg.questionnaire, "suspicion"),
    requiredYesQuestions: idsByRole(cfg.questionnaire, "required_yes"),
    exceptionQuestions: idsByRole(cfg.questionnaire, "exception"),
    missingEvidenceQuestions: idsByRole(cfg.questionnaire, "missing_evidence"),
  };
}

function gate(c: ScreeningCase, cfg: ScreenConfig): { checks: CheckResult[]; handled: boolean } {
  const checks = [checkRequiredDocs(c), checkPeriod(c.entry, cfg.policy), checkSplitPurchase(c.entry, cfg.scope, cfg.policy), checkInjectionText(c)];
  const hasExceptionDoc = c.documents.some((d) => d.type === "exception_approval");
  const byId = new Map(checks.map((x) => [x.id, x]));
  const ruleBreach = (byId.get("period")?.status === "fail" || byId.get("split_purchase")?.status === "fail") && !hasExceptionDoc;
  const injection = byId.get("injection_text")?.status === "fail";
  const missingDocsOnly = byId.get("required_docs")?.status === "fail" && !ruleBreach && !injection;
  return { checks, handled: ruleBreach || injection || missingDocsOnly };
}

function answersDiffer(a: QuestionResult[], b: QuestionResult[], decisive: Set<string>): boolean {
  const map = new Map(b.map((x) => [x.questionId, x.answer]));
  return a.some((x) => decisive.has(x.questionId) && map.get(x.questionId) !== x.answer);
}

export async function screenCase(c: ScreeningCase, cfg: ScreenConfig): Promise<ScreenOutput> {
  const started = Date.now();
  const usage: UsageEvent[] = [];
  const program = cfg.library && cfg.programName ? identifyProgram(cfg.library, cfg.programName) : null;
  const rules = cfg.library
    ? retrieveRules(cfg.library, program, [c.entry.purpose, c.entry.budgetItem ?? "", c.entry.subItem ?? "", ...c.documents.map((d) => d.type), "증빙 불인정 집행 기준"].join(" "), 8, 10)
    : undefined;
  const gated = gate(c, cfg);
  if (gated.handled) {
    return { decision: decide(decisionInput(c, cfg, gated.checks, [], true)), facts: [], usage, latencyMs: Date.now() - started, llmCalls: 0, rechecked: false, recheckStatus: "not_needed", recheck: { attempted: false, firstResults: null, secondResults: null }, rules };
  }

  const extracted = await Promise.all(c.documents.map((doc) => extractFacts(doc, { provider: cfg.provider, model: cfg.extractModel, cacheDir: cfg.cacheDir, caseId: c.id })));
  const facts: ExtractedFacts[] = [];
  for (const out of extracted) {
    usage.push(...out.events);
    if (out.facts) facts.push(out.facts);
  }

  const validInvoices = facts.filter((f) => f.docType === "tax_invoice" && !f.statesCancelledOrRevised);
  const allocation = (() => {
    if (validInvoices.length <= 1) return checkAllocationTotal(c.entry, validInvoices[0]?.totalKrw ?? null, cfg.scope, cfg.allocationProjectIds);
    const totals = validInvoices.map((f) => f.totalKrw);
    if (totals.some((t) => t === null)) return { id: "allocation_total", status: "unknown", detail: "a valid invoice total was not read" } satisfies CheckResult;
    const combined = checkAllocationTotal(c.entry, totals.reduce<number>((s, t) => s + (t ?? 0), 0), cfg.scope, cfg.allocationProjectIds);
    if (combined.status !== "pass") return combined;
    return { id: "allocation_total", status: "unknown", detail: validInvoices.length + " valid invoices together cover the allocations; their relation needs a reviewer" } satisfies CheckResult;
  })();
  const checks: CheckResult[] = [
    ...gated.checks,
    ...facts.filter((f) => f.docType === "tax_invoice" || f.docType === "card_receipt").map(checkArithmetic),
    checkLedgerVsDocTotal(c.entry, facts),
    checkVendorMatch(c.entry, facts),
    allocation,
  ];

  const first = await judgeCase(c.entry, c.documents, facts, cfg.questionnaire, { provider: cfg.provider, model: cfg.judgeModel, caseId: c.id, stage: "judge", rules });
  usage.push(...first.events);
  if (!first.results) {
    const failed: Decision = { ...decide(decisionInput(c, cfg, checks, [], false)), state: "FAILED", reasonCodes: ["model:judge_failed"] };
    return { decision: failed, facts, usage, latencyMs: Date.now() - started, llmCalls: usage.length, rechecked: false, recheckStatus: "not_needed", recheck: { attempted: false, firstResults: null, secondResults: null }, rules };
  }

  let questions = first.results;
  let rechecked = false;
  let secondResults: QuestionResult[] | null = null;
  const decisive = new Set([...idsByRole(cfg.questionnaire, "required_yes"), ...idsByRole(cfg.questionnaire, "suspicion"), ...idsByRole(cfg.questionnaire, "exception"), ...idsByRole(cfg.questionnaire, "missing_evidence")]);
  const needsRecheck = questions.some((q) => decisive.has(q.questionId) && q.answer === "UNKNOWN") || c.entry.amountKrw >= cfg.policy.highValueKrw;
  let disagreement = false;
  if (needsRecheck) {
    const second = await judgeCase(c.entry, c.documents, facts, cfg.questionnaire, { provider: cfg.provider, model: cfg.recheckModel, caseId: c.id, stage: "recheck", rules });
    usage.push(...second.events);
    if (second.results) {
      rechecked = true;
      secondResults = second.results;
      disagreement = answersDiffer(questions, second.results, decisive);
      questions = second.results;
    }
  }

  const missingIds = new Set(idsByRole(cfg.questionnaire, "missing_evidence"));
  const requiredIds = new Set(idsByRole(cfg.questionnaire, "required_yes"));
  const suspicionIds = new Set(idsByRole(cfg.questionnaire, "suspicion"));
  const unverifiedKeyEvidence = questions.some((q) =>
    (q.answer === "YES" && q.evidence.length > 0 && q.evidence.every((e) => !e.verified)) ||
    (q.answer === "NO" && (suspicionIds.has(q.questionId) || missingIds.has(q.questionId)) && q.evidence.some((e) => !e.verified)),
  );
  const unsupported = questions.filter((q) => requiredIds.has(q.questionId) && q.answer === "YES" && !q.evidence.some((e) => e.source === "document" && e.verified));
  if (unsupported.length > 0) {
    const ids = new Set(unsupported.map((q) => q.questionId));
    questions = questions.map((q) => (ids.has(q.questionId) ? { ...q, answer: "UNKNOWN" } : q));
  }
  const uncited = questions.filter((q) => missingIds.has(q.questionId) && q.answer === "YES" && q.evidence.length === 0 && (q.ruleIds ?? []).length === 0);
  if (uncited.length > 0) {
    const ids = new Set(uncited.map((q) => q.questionId));
    questions = questions.map((q) => (ids.has(q.questionId) ? { ...q, answer: "UNKNOWN" } : q));
  }
  const decision = decide(decisionInput(c, cfg, checks, questions, false));
  if (uncited.length > 0) decision.reasonCodes.push("info:uncited_missing_claim");
  if (unsupported.length > 0) decision.reasonCodes.push("info:unsupported_yes");
  if (disagreement) decision.reasonCodes.push("info:recheck_changed_answers");
  if (needsRecheck && !rechecked) decision.reasonCodes.push("model:recheck_failed");
  if ((disagreement || (needsRecheck && !rechecked)) && decision.state === "NO_FLAGS") {
    decision.state = "FLAGGED";
  }
  if (unverifiedKeyEvidence && (decision.state === "NO_FLAGS" || decision.state === "NEEDS_EVIDENCE")) {
    decision.state = "FLAGGED";
    decision.reasonCodes.push("evidence:quote_not_verified");
  }
  if (cfg.library && !program && decision.state === "NO_FLAGS") {
    decision.state = "FLAGGED";
    decision.reasonCodes.push("program:not_identified");
  }
  if (facts.length < c.documents.length && decision.state === "NO_FLAGS") {
    decision.state = "NEEDS_EVIDENCE";
    decision.reasonCodes.push("extract:document_unread");
  }
  const unresolvedSuspicion = questions.filter((q) => suspicionIds.has(q.questionId) && q.answer === "UNKNOWN");
  if (unresolvedSuspicion.length > 0 && decision.state === "NO_FLAGS") {
    decision.state = "NEEDS_EVIDENCE";
    decision.reasonCodes.push(...unresolvedSuspicion.map((q) => "question:unresolved:" + q.questionId));
  }
  const hasPaymentDocument = [...c.documents.map((d) => d.type), ...facts.map((f) => f.docType)]
    .some((type) => type === "tax_invoice" || type === "card_receipt");
  const totalCheck = checks.find((x) => x.id === "ledger_vs_doc_total");
  if (hasPaymentDocument && totalCheck?.status === "unknown" && decision.state === "NO_FLAGS") {
    decision.state = "NEEDS_EVIDENCE";
    decision.reasonCodes.push("check:ledger_total_unresolved");
  }
  if (hasPaymentDocument && checks.some((x) => x.id === "vendor_match" && x.status === "unknown") && decision.state === "NO_FLAGS") {
    decision.state = "NEEDS_EVIDENCE";
    decision.reasonCodes.push("check:vendor_unresolved");
  }
  if (validInvoices.length > 1 && allocation.status === "unknown" && decision.state === "NO_FLAGS") {
    decision.state = "NEEDS_EVIDENCE";
    decision.reasonCodes.push("check:allocation_unresolved");
  }
  const recheckStatus = !needsRecheck ? "not_needed" : !rechecked ? "failed" : disagreement ? "disagreed" : "succeeded";
  return { decision, facts, usage, latencyMs: Date.now() - started, llmCalls: usage.length, rechecked, recheckStatus, recheck: { attempted: needsRecheck, firstResults: first.results, secondResults }, rules };
}



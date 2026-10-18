import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Policy } from "../../core/src/index.js";
import type { ModelProvider } from "../../models/src/index.js";
import { screenCase, type ScreenOutput } from "../../pipeline/src/screen.js";
import { QUESTIONNAIRE_SUBSIDY_V1 } from "../../questionnaire/src/index.js";
import { scopedLibrary, type SubsidyLibrary } from "./library.js";

const date = z.iso.date();
const id = z.string().trim().min(1).max(100);
const docType = z.enum(["quotation", "delivery_statement", "tax_invoice", "card_receipt", "meeting_minutes", "travel_report", "exception_approval", "other"]);
export const screenInputSchema = z.object({
  programId: id,
  entry: z.object({ caseId: id, projectId: id, vendorId: z.string().trim().max(200), invoiceKey: id, amountKrw: z.number().int().nonnegative().max(1_000_000_000_000), executedAt: date, purpose: z.string().trim().min(1).max(2000), budgetItem: z.string().max(100), subItem: z.string().max(100), active: z.literal(true) }),
  period: z.object({ start: date, end: date }).refine((p) => p.start <= p.end, "Project end precedes start"),
  documents: z.array(z.object({ id, type: docType, text: z.string().trim().min(1).max(20_000) })).min(1).max(6),
  requiredDocTypes: z.array(docType).max(8).default([]),
}).refine((x) => new Set(x.documents.map((d) => d.id)).size === x.documents.length, "Document ids must be unique");
export type SubsidyInput = z.infer<typeof screenInputSchema>;

export class UnknownSubsidyProgram extends Error {
  constructor(readonly programId: string) { super("Choose a known subsidy program."); this.name = "UnknownSubsidyProgram"; }
}

export function programFor(library: SubsidyLibrary, id: string) {
  const program = library.programs.find((p) => p.id === id);
  if (!program) throw new UnknownSubsidyProgram(id);
  return program;
}

export const CHECKLIST = {
  ...QUESTIONNAIRE_SUBSIDY_V1,
  approvedBy: undefined,
  approvedAt: undefined,
  questions: QUESTIONNAIRE_SUBSIDY_V1.questions.map((q) => q.id === "required_evidence_missing" ? {
    ...q,
    text: "Compare the submitted evidence with the selected program's required documents. Answer YES only when you can name the missing document and cite the supplied rule that requires it. Answer UNKNOWN when the relevant requirement was not retrieved. Treat payment evidence as supplied through e-Naradoum only when the submitted records establish that payment and the applicable guidance permits relying on it; never assume system payment from the program name alone.",
  } : q),
};

export function demoInput(library: SubsidyLibrary, programId: string) {
  const program = programFor(library, programId);
  const purpose = program.name + " 사업 수행 관련 외부 전문기관 컨설팅 용역";
  return {
    programId, title: "Synthetic consulting expense · SAMPLE",
    entry: { caseId: "SUB-SAMPLE-01", projectId: "SAMPLE-PROJECT", vendorId: "SAMPLE-VENDOR", invoiceKey: "SAMPLE-INV-01", amountKrw: 1_100_000, executedAt: "2026-06-15", purpose, budgetItem: "운영비", subItem: "일반용역비", active: true },
    period: { start: "2026-01-01", end: "2026-12-31" },
    documents: [
      { id: "SAMPLE-INVOICE", type: "tax_invoice", text: "SAMPLE — 합성 시연 자료\n세금계산서 SAMPLE-INV-01\n공급자 SAMPLE-VENDOR\n작성일 2026-06-15\n품목 컨설팅 용역\n수량 1 단가 1000000원\n공급가액 1000000원\n세액 100000원\n합계 1100000원\n사업명 " + program.name + "\n용도 " + purpose },
      { id: "SAMPLE-REPORT", type: "other", text: "SAMPLE — 합성 시연 자료\n사업명 " + program.name + "\n수행기관 SAMPLE-INSTITUTION\n용역업체 SAMPLE-VENDOR\n용역 결과보고서\n수행기간 2026-06-01부터 2026-06-15까지\n" + purpose + " 결과물을 제출함.\n검수일 2026-06-15\n계약금액 1100000원\n지급일 2026-06-15\n지급방법 e나라도움 전용계좌 이체\n지급액 1100000원" },
    ], requiredDocTypes: [],
  } satisfies SubsidyInput & { title: string };
}

export async function screenSubsidy(input: SubsidyInput, library: SubsidyLibrary, options: { readonly provider: ModelProvider; readonly reader: string; readonly judge: string; readonly recheck: string; readonly cacheDir: string }) {
  const program = programFor(library, input.programId);
  const policy: Policy = { id: "subsidy-selected-program", version: library.version, projects: [{ id: input.entry.projectId, ...input.period }], splitThresholdKrw: Number.MAX_SAFE_INTEGER, splitWindowDays: 0, highValueKrw: 10_000_000 };
  const result: ScreenOutput = await screenCase({ id: input.entry.caseId, entry: input.entry, documents: input.documents, requiredDocTypes: input.requiredDocTypes }, {
    provider: options.provider, extractModel: options.reader, judgeModel: options.judge, recheckModel: options.recheck, cacheDir: options.cacheDir,
    questionnaire: CHECKLIST, policy, scope: { entries: [input.entry], coveredProjectIds: [input.entry.projectId] }, allocationProjectIds: [], ruleApplicable: true,
    library: scopedLibrary(library, program), programName: program.name,
  });
  result.decision.checks = result.decision.checks.map((c) => c.id === "split_purchase" || c.id === "allocation_total" ? { ...c, status: "not_run", detail: "Complete related ledgers were not supplied; cross-expense checks were not performed." } : c);
  result.decision.reasonCodes = result.decision.reasonCodes.filter((code) => code !== "check:split_purchase" && code !== "check:allocation_total");
  result.decision.coverage.checked = result.decision.checks.filter((c) => c.status !== "not_run").map((c) => c.id);
  result.decision.coverage.notRun = result.decision.checks.filter((c) => c.status === "not_run").map((c) => c.id);
  result.decision.coverage.comparedProjects = [];
  if (!result.rules?.layer2.length && result.decision.state === "NO_FLAGS") {
    result.decision.state = "RULE_UNDETERMINED";
    result.decision.reasonCodes.push("rules:program_guidance_missing");
  }
  const ruleQuestions = new Set(CHECKLIST.questions.filter((q) => q.ruleRef === "L2").map((q) => q.id));
  if (result.decision.state === "NO_FLAGS" && result.decision.questions.some((q) => ruleQuestions.has(q.questionId) && (q.answer === "UNKNOWN" || q.answer === "NA"))) {
    result.decision.state = "RULE_UNDETERMINED";
    result.decision.reasonCodes.push("rules:unresolved_program_requirement");
  }
  const inputHash = createHash("sha256").update(JSON.stringify({ input, libraryVersion: library.version, questionnaire: CHECKLIST.id, questionnaireVersion: CHECKLIST.version })).digest("hex");
  return {
    runId: randomUUID(), inputHash, libraryVersion: library.version, program,
    questionnaire: { id: CHECKLIST.id, version: CHECKLIST.version, status: CHECKLIST.status },
    input: { entry: input.entry, period: input.period, documents: input.documents }, result,
    limitations: ["Draft screening criteria; a reviewer must confirm the result.", "The imported regulation snapshot has not been certified as the latest applicable version.", "Only the supplied expense and evidence text were checked; no cross-project duplicate or split-purchase clearance.", "Retrieved excerpts are context; cited rule identifiers show the basis used for each answer."],
  };
}

import type { CheckResult, Decision, QuestionResult, ScreeningState } from "./types.js";

export interface DecisionInput {
  caseId: string;
  checks: CheckResult[];
  questions: QuestionResult[];
  ruleApplicable: boolean;
  gateHandled: boolean;
  comparedProjects: string[];
    suspicionQuestions: string[];
    requiredYesQuestions: string[];
    exceptionQuestions: string[];
  missingEvidenceQuestions?: string[];
  blockingCoverage?: string[];
}

export function decide(input: DecisionInput): Decision {
  const reasons: string[] = [];
  const byId = new Map(input.questions.map((q) => [q.questionId, q]));
  const exceptionApproved = input.exceptionQuestions.some((id) => byId.get(id)?.answer === "YES");

  const failed = input.checks.filter((c) => c.status === "fail");
  for (const c of failed) {
    if (exceptionApproved && c.id === "split_purchase") continue;
    reasons.push("check:" + c.id);
  }
  for (const id of input.suspicionQuestions) {
    if (byId.get(id)?.answer === "YES") reasons.push("question:" + id);
  }

  const missingEvidence =
    input.checks.some((c) => c.id === "required_docs" && c.status === "fail") ||
    input.requiredYesQuestions.some((id) => {
      const answer = byId.get(id)?.answer;
      return answer !== "YES" && answer !== "NA";
    }) ||
    (input.missingEvidenceQuestions ?? []).some((id) => byId.get(id)?.answer === "YES");

  const blocking = new Set(input.blockingCoverage ?? ["allocation_total"]);
  const notRun = input.checks.filter((c) => c.status === "not_run").map((c) => c.id);
  const blockingNotRun = notRun.filter((id) => blocking.has(id));

  let state: ScreeningState;
  if (reasons.some((r) => r.startsWith("check:") && r !== "check:required_docs") || reasons.some((r) => r.startsWith("question:"))) {
    state = "FLAGGED";
  } else if (!input.ruleApplicable) {
    state = "RULE_UNDETERMINED";
    reasons.push("rule:undetermined");
  } else if (missingEvidence) {
    state = "NEEDS_EVIDENCE";
    reasons.push("evidence:missing_or_unknown");
  } else if (blockingNotRun.length > 0) {
    state = "NEEDS_EVIDENCE";
    reasons.push("coverage:not_run:" + blockingNotRun.join(","));
  } else {
    state = "NO_FLAGS";
  }

  return {
    caseId: input.caseId,
    state,
    reasonCodes: reasons,
    checks: input.checks,
    questions: input.questions,
    coverage: {
      checked: input.checks.filter((c) => c.status !== "not_run").map((c) => c.id),
      notRun,
      comparedProjects: input.comparedProjects,
    },
    gateHandled: input.gateHandled,
  };
}



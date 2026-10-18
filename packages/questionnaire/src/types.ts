export type QuestionRole = "required_yes" | "suspicion" | "exception" | "missing_evidence" | "info";

export interface Question {
  id: string;
  text: string;
  role: QuestionRole;
  ruleRef: string;
}

export interface Questionnaire {
  id: string;
  version: number;
  status: "draft" | "approved";
  policyId: string;
  questions: Question[];
  approvedBy?: string;
  approvedAt?: string;
}

export function idsByRole(q: Questionnaire, role: QuestionRole): string[] {
  return q.questions.filter((x) => x.role === role).map((x) => x.id);
}



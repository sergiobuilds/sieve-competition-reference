import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRequiredDocs, type Answer, type ScreeningCase } from "../../core/src/index.js";
import { ZERO_USAGE, type ModelProvider } from "../../models/src/index.js";
import type { Questionnaire } from "../../questionnaire/src/index.js";
import { screenInputSchema } from "../../subsidy/src/screen.js";
import { judgeCase } from "../src/judge.js";
import { screenCase } from "../src/screen.js";

const questionnaire: Questionnaire = { id: "regression", version: 1, status: "draft", policyId: "p", questions: [{ id: "risk", role: "suspicion", ruleRef: "", text: "Risk?" }] };
const fixture: ScreeningCase = { id: "c", entry: { caseId: "c", projectId: "p", vendorId: "", invoiceKey: "i", amountKrw: 100, executedAt: "2026-06-01", purpose: "test", active: true }, documents: [], requiredDocTypes: [] };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function provider(first: Answer, second: Answer | "error" | "malformed"): ModelProvider {
  return { name: "scripted-model-boundary", async generateJson(request) {
    if (request.model === "second" && second === "error") throw new Error("Recheck unavailable");
    const json = request.model === "second" && second === "malformed" ? {} : { answers: [{ questionId: "risk", answer: request.model === "second" ? second : first, evidence: [], ruleIds: [] }] };
    return { json, rawText: JSON.stringify(json), model: request.model, usage: ZERO_USAGE, latencyMs: 0 };
  } };
}
function run(first: Answer, second: Answer | "error" | "malformed", highValue = true) {
  const cacheDir = mkdtempSync(join(tmpdir(), "sieve-reliability-")); dirs.push(cacheDir);
  return screenCase(fixture, { provider: provider(first, second), extractModel: "reader", judgeModel: "first", recheckModel: "second", cacheDir, questionnaire, policy: { id: "p", version: "1", projects: [{ id: "p", start: "2026-01-01", end: "2026-12-31" }], splitThresholdKrw: 1000, splitWindowDays: 0, highValueKrw: highValue ? 100 : 1000 }, scope: { entries: [fixture.entry], coveredProjectIds: ["p"] }, allocationProjectIds: [], ruleApplicable: true });
}
describe("recheck reliability", () => {
  it.each(["error", "malformed"] as const)("requires review when all recheck attempts return %s", async (failure) => {
    // Given a high-value case initially answered NO.
    // When every recheck attempt fails.
    const out = await run("NO", failure);
    // Then it cannot clear and the first answer remains available.
    expect(out.decision.state).toBe("FLAGGED");
    expect(out.decision.reasonCodes).toContain("model:recheck_failed");
    expect(out.recheckStatus).toBe("failed");
    expect(out.rechecked).toBe(false);
    expect(out.recheck).toMatchObject({ attempted: true, firstResults: [{ questionId: "risk", answer: "NO" }], secondResults: null });
    expect(out.usage.filter((u) => u.stage === "recheck")).toHaveLength(3);
  });
  it.each([["YES", "NO"], ["NO", "YES"], ["UNKNOWN", "NO"]] as const)("preserves both answers and requires review when %s changes to %s", async (first, second) => {
    // Given differing decisive model answers; when screening completes.
    const out = await run(first, second);
    // Then disagreement remains visible and cannot clear.
    expect(out.decision.state).toBe("FLAGGED");
    expect(out.decision.reasonCodes).toContain("info:recheck_changed_answers");
    expect(out.recheckStatus).toBe("disagreed");
    expect(out.rechecked).toBe(true);
    expect(out.recheck).toMatchObject({ attempted: true, firstResults: [{ answer: first }], secondResults: [{ answer: second }] });
  });
  it("clears when both completed answers agree on NO", async () => {
    // Given matching NO answers; when the high-value recheck completes.
    const out = await run("NO", "NO");
    // Then successful agreement permits clearance.
    expect(out.decision.state).toBe("NO_FLAGS");
    expect(out.recheckStatus).toBe("succeeded");
    expect(out.rechecked).toBe(true);
  });
  it("marks recheck not run when a low-value case is conclusive", async () => {
    // Given a low-value NO; when screening completes.
    const out = await run("NO", "error", false);
    // Then no recheck is reported as successful or attempted.
    expect(out.rechecked).toBe(false);
    expect(out.recheckStatus).toBe("not_needed");
    expect(out.recheck).toMatchObject({ attempted: false, secondResults: null });
  });
});
describe("complete document input", () => {
  it.each([0, 14, 19])("preserves evidence at line index %i for both judging stages", async (index) => {
    // Given six documents at the validated 20,000-character limit.
    const lines = Array.from({ length: 20 }, () => "사업 내용"); lines[index] = "검수 결과: 미완료, 지급 불가";
    const text = lines.join("\n").padEnd(20_000, "끝");
    const input = screenInputSchema.parse({ programId: "patent", entry: { ...fixture.entry, budgetItem: "", subItem: "" }, period: { start: "2026-01-01", end: "2026-12-31" }, documents: Array.from({ length: 6 }, (_, i) => ({ id: "doc-" + i, type: "other", text })) });
    const received: string[] = [];
    const model: ModelProvider = { name: "capture", async generateJson(request) { received.push(request.user); return { json: { answers: [] }, rawText: "", model: request.model, usage: ZERO_USAGE, latencyMs: 0 }; } };
    // When both stages construct their model input.
    for (const stage of ["judge", "recheck"] as const) await judgeCase(input.entry, input.documents, [], questionnaire, { provider: model, model: "capture", caseId: "c", stage });
    // Then each entire source document reaches each stage unchanged.
    expect(received).toHaveLength(2);
    for (const user of received) expect(user.split(text)).toHaveLength(7);
  });
});
describe("required document coverage", () => {
  it("does not claim a pass when the required list is empty", () => {
    // Given no configured document requirements; when checking coverage.
    const check = checkRequiredDocs(fixture);
    // Then the check was not performed.
    expect(check.status).toBe("not_run");
  });
  it("records missing coverage without blocking solely on an empty list", async () => {
    // Given a conclusive low-value case with no required list; when screened.
    const out = await run("NO", "NO", false);
    // Then the omitted check stays visible but does not block the case.
    expect(out.decision.coverage.notRun).toContain("required_docs");
    expect(out.decision.coverage.checked).not.toContain("required_docs");
    expect(out.decision.state).toBe("NO_FLAGS");
  });
});

import { describe, expect, it } from "vitest";
import { quoteIsInDocument } from "../src/extract.js";

const doc = { id: "d", type: "other" as const, text: "거래명세서(합성)\n공급자: 가상상사\n납품일자: 2026-05-12\n검수 결과: 이상 없음" };
const d = (text: string) => ({ id: "t", type: "other" as const, text });

describe("quote verification", () => {
  it("accepts a verbatim quote and a quote that runs across adjacent lines", () => {
    expect(quoteIsInDocument("납품일자: 2026-05-12", doc)).toBe(true);
    expect(quoteIsInDocument("가상상사 납품일자: 2026-05-12", doc)).toBe(true);
  });
  it("rejects invented text", () => {
    expect(quoteIsInDocument("검수 결과: 수량 부족", doc)).toBe(false);
    expect(quoteIsInDocument("revised: null", doc)).toBe(false);
  });
  it("requires an explicit gap marker to skip text", () => {
    expect(quoteIsInDocument("거래명세서(합성) 납품일자: 2026-05-12", doc)).toBe(false);
    expect(quoteIsInDocument("거래명세서(합성) ... 납품일자: 2026-05-12", doc)).toBe(true);
    expect(quoteIsInDocument("지급 승인 확인 완료", d("지급 승인 불가 확인 완료"))).toBe(false);
    expect(quoteIsInDocument("지급 승인 확인 완료", d("지급 승인 불가\n확인 완료"))).toBe(false);
  });
  it("keeps fragments in document order", () => {
    expect(quoteIsInDocument("지급 불가 승인 완료", d("지급 불가\n승인 완료"))).toBe(true);
    expect(quoteIsInDocument("승인 완료 ... 지급 불가", d("지급 불가\n승인 완료"))).toBe(false);
    expect(quoteIsInDocument("검수 결과: 이상 없음 ... 거래명세서(합성)", doc)).toBe(false);
    expect(quoteIsInDocument("거래명세서(합성)…검수 결과: 이상 없음", doc)).toBe(true);
    expect(quoteIsInDocument("a b", d("a X a b"))).toBe(true);
    expect(quoteIsInDocument("a ... a ... a", d("a\na"))).toBe(false);
  });
  it("rejects a gap that hides a negation, whatever marker is used", () => {
    expect(quoteIsInDocument("지급 승인 ... 확인 완료", d("지급 승인\n불가\n확인 완료"))).toBe(false);
    expect(quoteIsInDocument("지급 승인 | 완료", d("지급 승인 불가 완료"))).toBe(false);
    expect(quoteIsInDocument("지급 승인 … 완료", d("지급 승인 not 완료"))).toBe(false);
    expect(quoteIsInDocument("지급 승인 불 ... 완료", d("지급 승인 불가 완료"))).toBe(false);
    expect(quoteIsInDocument("지급 승인 ... 가 완료", d("지급 승인 불가 완료"))).toBe(false);
  });
  it("uses the closest earlier fragment so a later valid gap is found", () => {
    expect(quoteIsInDocument("지급 승인 ... 확인 완료", d("지급 승인\n불가\n지급 승인\n담당자 홍길동\n확인 완료"))).toBe(true);
    expect(quoteIsInDocument("지급 승인 ... table 확인", d("지급 승인\nnotable 확인\n담당자\ntable 확인"))).toBe(true);
    expect(quoteIsInDocument("지급 승인 ... ice 확인", d("지급 승인\nnotice 확인"))).toBe(true);
  });
  it("treats a standalone pipe as a gap and still accepts a literal pipe", () => {
    const text = "품목: 현미경 부품 | 수량: 1 | 단가: 100원\n세액: 10원\n합계금액: 110원";
    expect(quoteIsInDocument("품목: 현미경 부품 | 합계금액: 110원", d(text))).toBe(true);
    expect(quoteIsInDocument("품목: 현미경 부품 | 수량: 1", d(text))).toBe(true);
    expect(quoteIsInDocument("합계금액: 110원 | 품목: 현미경 부품", d(text))).toBe(false);
  });
  it("rejects a fragment that starts right after a negative prefix but not inside a longer word", () => {
    expect(quoteIsInDocument("승인 확인 완료", d("미승인\n확인 완료"))).toBe(false);
    expect(quoteIsInDocument("인정 금액", d("불인정 금액"))).toBe(false);
    expect(quoteIsInDocument("추진비 집행", d("업무추진비 집행"))).toBe(true);
    expect(quoteIsInDocument("금액 1,100,000원", d("지불금액 1,100,000원"))).toBe(true);
  });
  it("stays fast on long repetitive documents that do not match", () => {
    const started = performance.now();
    expect(quoteIsInDocument("a ".repeat(12) + "z", d("a\nx\n".repeat(5000)))).toBe(false);
    expect(quoteIsInDocument("a ... ".repeat(12) + "z", d("a\nx\n".repeat(5000)))).toBe(false);
    expect(quoteIsInDocument("a | ".repeat(12) + "z", d("a\n".repeat(20000)))).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});


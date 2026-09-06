import { describe, it, expect } from "vitest";
import {
  evaluate,
  tryEvaluate,
  formatNumber,
  applyTax,
  applyDiscount,
  splitBill,
  profitMargin,
  pushHistory,
  HISTORY_LIMIT,
  CalcError,
} from "../calctime/calculator";

describe("calculator: scientific notation", () => {
  it("accepts an exponent on a number", () => {
    expect(evaluate("1e6")).toBe(1_000_000);
    expect(evaluate("1E6")).toBe(1_000_000);
    expect(evaluate("1.5e3")).toBe(1500);
    expect(evaluate("1.5e-3")).toBeCloseTo(0.0015, 12);
    expect(evaluate("2e+2")).toBe(200);
  });

  it("works inside a larger expression", () => {
    expect(evaluate("1e3 + 1")).toBe(1001);
    expect(evaluate("2 * 1e3")).toBe(2000);
    expect(evaluate("(1e2 + 1) * 2")).toBe(202);
  });

  it("still rejects an incomplete exponent rather than guessing", () => {
    expect(() => evaluate("2e")).toThrow();
    expect(() => evaluate("2e+")).toThrow();
    expect(() => evaluate("e5")).toThrow();
  });

  it("rejects an exponent that overflows to Infinity", () => {
    expect(() => evaluate("1e999")).toThrow(/bad number/i);
  });
});

describe("calculator: arithmetic", () => {
  it("does the four operations", () => {
    expect(evaluate("2+3")).toBe(5);
    expect(evaluate("9-4")).toBe(5);
    expect(evaluate("6*7")).toBe(42);
    expect(evaluate("84/2")).toBe(42);
  });

  it("respects precedence and brackets", () => {
    expect(evaluate("2+3*4")).toBe(14);
    expect(evaluate("(2+3)*4")).toBe(20);
    expect(evaluate("2*(3+(4-1))")).toBe(12);
    expect(evaluate("100/(2+3)/2")).toBe(10);
  });

  it("handles decimals and unary minus", () => {
    expect(evaluate("0.5+0.25")).toBe(0.75);
    expect(evaluate("-5+8")).toBe(3);
    expect(evaluate("-(3*4)")).toBe(-12);
    expect(evaluate("10*-2")).toBe(-20);
  });

  it("handles powers, right-associatively", () => {
    expect(evaluate("2^10")).toBe(1024);
    // Right-assoc: 2^(3^2) = 512, not (2^3)^2 = 64.
    expect(evaluate("2^3^2")).toBe(512);
    expect(evaluate("2^-2")).toBe(0.25);
  });

  it("handles square roots", () => {
    expect(evaluate("√16")).toBe(4);
    expect(evaluate("√(9+16)")).toBe(5);
    expect(evaluate("2*√9")).toBe(6);
  });

  it("treats % as 'divide by 100', like a pocket calculator", () => {
    expect(evaluate("50%")).toBe(0.5);
    expect(evaluate("200*15%")).toBe(30);
  });

  it("accepts the keypad's × ÷ − glyphs and thousands separators", () => {
    expect(evaluate("6×7")).toBe(42);
    expect(evaluate("84÷2")).toBe(42);
    expect(evaluate("9−4")).toBe(5);
    expect(evaluate("1,000+1")).toBe(1001);
  });

  it("reports errors instead of throwing raw or returning nonsense", () => {
    expect(tryEvaluate("1/0")).toEqual({ ok: false, error: "Cannot divide by zero" });
    expect(tryEvaluate("(1+2").ok).toBe(false);
    expect(tryEvaluate("").ok).toBe(false);
    expect(tryEvaluate("2++").ok).toBe(false);
    expect(tryEvaluate("√-4").ok).toBe(false);
    expect(tryEvaluate("1.2.3").ok).toBe(false);
  });

  it("never evaluates arbitrary code", () => {
    // The parser only knows numbers and operators — identifiers are rejected
    // outright rather than reaching any JS evaluation path.
    expect(() => evaluate("alert(1)")).toThrow(CalcError);
    expect(() => evaluate("globalThis")).toThrow(CalcError);
    expect(() => evaluate("1;2")).toThrow(CalcError);
  });

  it("hides binary-float fuzz when formatting", () => {
    expect(formatNumber(evaluate("0.1+0.2"))).toBe("0.3");
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatNumber(2 / 3)).toBe("0.6666666667");
  });
});

describe("calculator: money maths", () => {
  it("adds tax on top", () => {
    const r = applyTax(1000, 18, "add");
    expect(r.tax).toBeCloseTo(180, 6);
    expect(r.total).toBeCloseTo(1180, 6);
  });

  it("backs tax out of an inclusive amount", () => {
    // The common mistake is 1180 - 18% = 967.60. Correct is 1180 / 1.18.
    const r = applyTax(1180, 18, "remove");
    expect(r.base).toBeCloseTo(1000, 6);
    expect(r.tax).toBeCloseTo(180, 6);
    expect(r.total).toBeCloseTo(1180, 6);
  });

  it("applies discounts", () => {
    const r = applyDiscount(2499, 30);
    expect(r.saved).toBeCloseTo(749.7, 6);
    expect(r.final).toBeCloseTo(1749.3, 6);
  });

  it("accepts the full 0–100% range", () => {
    expect(applyDiscount(100, 0)).toEqual({ saved: 0, final: 100 });
    expect(applyDiscount(100, 100)).toEqual({ saved: 100, final: 0 });
  });

  it("refuses a discount that would make the price negative", () => {
    // "150% off" produced { saved: 150, final: -50 } and the panel cheerfully
    // displayed "You pay -50.00".
    expect(() => applyDiscount(100, 150)).toThrow(/between 0 and 100/i);
    expect(() => applyDiscount(100, -10)).toThrow();
    expect(() => applyDiscount(100, NaN)).toThrow();
    expect(() => applyDiscount(NaN, 10)).toThrow();
  });

  it("splits a bill with a tip, never collecting short", () => {
    const r = splitBill(100, 3, 10);
    expect(r.total).toBeCloseTo(110, 6);
    expect(r.tip).toBeCloseTo(10, 6);
    // 110/3 = 36.666…, rounded up so three people cover the whole bill.
    expect(r.perPerson).toBe(36.67);
    expect(r.perPerson * 3).toBeGreaterThanOrEqual(r.total);
    expect(r.remainder).toBeCloseTo(0.01, 6);
  });

  it("splits evenly with no remainder when it divides cleanly", () => {
    const r = splitBill(90, 3, 0);
    expect(r.perPerson).toBe(30);
    expect(r.remainder).toBeCloseTo(0, 6);
  });

  it("rejects a nonsensical head count", () => {
    expect(() => splitBill(100, 0)).toThrow(CalcError);
  });

  it("distinguishes margin from markup", () => {
    // The classic confusion: cost 100, sell 150 is 50% markup but 33.3% margin.
    const r = profitMargin(100, 150);
    expect(r.profit).toBe(50);
    expect(r.markupPercent).toBeCloseTo(50, 6);
    expect(r.marginPercent).toBeCloseTo(33.3333, 3);
  });

  it("reports a loss as negative rather than clamping", () => {
    const r = profitMargin(200, 150);
    expect(r.profit).toBe(-50);
    expect(r.marginPercent).toBeLessThan(0);
  });
});

describe("calculator: history", () => {
  it("keeps newest first and caps the tape", () => {
    let list: { expression: string; result: string }[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      list = pushHistory(list, { expression: `${i}+0`, result: String(i) });
    }
    expect(list).toHaveLength(HISTORY_LIMIT);
    expect(list[0].result).toBe(String(HISTORY_LIMIT + 4));
  });
});

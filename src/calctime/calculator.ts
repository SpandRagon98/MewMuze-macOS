/**
 * A small, safe arithmetic evaluator plus the everyday money maths people
 * actually open a calculator for (tax, discount, tip splitting, margin).
 *
 * Deliberately hand-written rather than `eval`/`Function`: evaluating user text
 * as code in a desktop app is a real injection risk, and a parser this size is
 * cheaper than pulling in a dependency. Everything here is pure and synchronous
 * — no I/O, no clock, no network — so it is fully unit-testable and costs
 * nothing while the panel is closed.
 *
 * Supported: + - * / ( ) decimals, ^ (right-assoc), unary minus, √,
 * and a trailing/infix % that behaves the way pocket calculators do.
 */

export type Token =
  | { kind: "num"; value: number }
  | { kind: "op"; value: string }
  | { kind: "lparen" }
  | { kind: "rparen" };

/** Characters accepted as the same operator, so × ÷ − from the keypad work. */
const OP_ALIASES: Record<string, string> = {
  "×": "*",
  "·": "*",
  "÷": "/",
  "−": "-", // U+2212 minus
  "–": "-",
  "—": "-",
  ",": "", // thousands separators are ignored
};

export class CalcError extends Error {}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const src = [...input].map((ch) => (ch in OP_ALIASES ? OP_ALIASES[ch] : ch)).join("");
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      // Optional exponent, but only when it is a complete one directly after
      // the mantissa: "1e6", "1.5e-3". A bare "2e" or "2e+" is a typo, and
      // consuming the "e" there would turn a clear "Bad number" into a
      // confusing complaint about whatever followed it.
      if (j < src.length && (src[j] === "e" || src[j] === "E")) {
        let k = j + 1;
        if (k < src.length && (src[k] === "+" || src[k] === "-")) k++;
        let digits = k;
        while (digits < src.length && /[0-9]/.test(src[digits])) digits++;
        if (digits > k) j = digits; // at least one exponent digit: take it
      }
      const text = src.slice(i, j);
      if ((text.match(/\./g) ?? []).length > 1) throw new CalcError(`Bad number "${text}"`);
      const value = Number(text);
      // Number("") is 0 and Number(".") is NaN; both are caught here, as is an
      // exponent large enough to overflow to Infinity.
      if (!Number.isFinite(value)) throw new CalcError(`Bad number "${text}"`);
      tokens.push({ kind: "num", value });
      i = j;
      continue;
    }
    if ("+-*/^%".includes(ch)) {
      tokens.push({ kind: "op", value: ch });
      i++;
      continue;
    }
    if (ch === "√") {
      tokens.push({ kind: "op", value: "√" });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      continue;
    }
    throw new CalcError(`Unexpected "${ch}"`);
  }
  return tokens;
}

/**
 * Recursive-descent parser/evaluator.
 *
 * Precedence, loosest first: + -  |  * /  |  unary - and √  |  ^ (right-assoc).
 * `%` binds tightest of all as a postfix "divide by 100", which is what makes
 * `200 * 15%` read as fifteen percent of 200 rather than a modulo.
 */
export function evaluate(input: string): number {
  const tokens = tokenize(input);
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const eat = (): Token | undefined => tokens[pos++];

  const parseExpr = (): number => {
    let left = parseTerm();
    for (;;) {
      const t = peek();
      if (t?.kind === "op" && (t.value === "+" || t.value === "-")) {
        eat();
        const right = parseTerm();
        left = t.value === "+" ? left + right : left - right;
      } else return left;
    }
  };

  const parseTerm = (): number => {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t?.kind === "op" && (t.value === "*" || t.value === "/")) {
        eat();
        const right = parseUnary();
        if (t.value === "/") {
          if (right === 0) throw new CalcError("Cannot divide by zero");
          left = left / right;
        } else left = left * right;
      } else return left;
    }
  };

  const parseUnary = (): number => {
    const t = peek();
    if (t?.kind === "op" && t.value === "-") {
      eat();
      return -parseUnary();
    }
    if (t?.kind === "op" && t.value === "+") {
      eat();
      return parseUnary();
    }
    if (t?.kind === "op" && t.value === "√") {
      eat();
      const v = parseUnary();
      if (v < 0) throw new CalcError("Cannot take the square root of a negative number");
      return Math.sqrt(v);
    }
    return parsePower();
  };

  const parsePower = (): number => {
    const base = parsePostfix();
    const t = peek();
    if (t?.kind === "op" && t.value === "^") {
      eat();
      // Right-associative, and the exponent may itself be negative: 2^-3.
      const exp = parseUnary();
      const out = Math.pow(base, exp);
      if (!Number.isFinite(out)) throw new CalcError("Result is out of range");
      return out;
    }
    return base;
  };

  const parsePostfix = (): number => {
    let v = parsePrimary();
    for (;;) {
      const t = peek();
      if (t?.kind === "op" && t.value === "%") {
        eat();
        v = v / 100;
      } else return v;
    }
  };

  const parsePrimary = (): number => {
    const t = eat();
    if (!t) throw new CalcError("Unexpected end of expression");
    if (t.kind === "num") return t.value;
    if (t.kind === "lparen") {
      const v = parseExpr();
      const close = eat();
      if (close?.kind !== "rparen") throw new CalcError("Missing closing bracket");
      return v;
    }
    if (t.kind === "op" && (t.value === "-" || t.value === "+" || t.value === "√")) {
      pos--; // let parseUnary own it
      return parseUnary();
    }
    throw new CalcError("Unexpected symbol");
  };

  if (tokens.length === 0) throw new CalcError("Nothing to calculate");
  const result = parseExpr();
  if (pos < tokens.length) throw new CalcError("Unexpected trailing input");
  if (!Number.isFinite(result)) throw new CalcError("Result is out of range");
  return result;
}

/** Evaluate, returning either a value or a human-readable error. */
export function tryEvaluate(input: string): { ok: true; value: number } | { ok: false; error: string } {
  try {
    return { ok: true, value: evaluate(input) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid expression" };
  }
}

/**
 * Format for display: trims float fuzz (0.1+0.2) without turning genuinely
 * long numbers into rubbish, and groups thousands for readability.
 */
export function formatNumber(value: number, maxDecimals = 10): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Number(value.toFixed(maxDecimals));
  if (Number.isInteger(rounded) && Math.abs(rounded) < 1e21) {
    return rounded.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  if (Math.abs(rounded) !== 0 && (Math.abs(rounded) < 1e-6 || Math.abs(rounded) >= 1e15)) {
    return rounded.toExponential(6).replace(/\.?0+e/, "e");
  }
  return rounded.toLocaleString("en-US", { maximumFractionDigits: maxDecimals });
}

// ---- everyday money maths -------------------------------------------------

export interface TaxResult {
  /** Amount before tax. */
  base: number;
  /** The tax portion alone. */
  tax: number;
  /** Base + tax. */
  total: number;
}

/**
 * GST / VAT / sales tax.
 *
 * `mode: "add"` treats `amount` as pre-tax and adds tax on top.
 * `mode: "remove"` treats `amount` as tax-inclusive and works backwards — the
 * case people usually get wrong by subtracting the percentage instead of
 * dividing.
 */
export function applyTax(amount: number, ratePercent: number, mode: "add" | "remove"): TaxResult {
  const r = ratePercent / 100;
  if (mode === "add") {
    const tax = amount * r;
    return { base: amount, tax, total: amount + tax };
  }
  if (1 + r === 0) throw new CalcError("Invalid tax rate");
  const base = amount / (1 + r);
  return { base, tax: amount - base, total: amount };
}

export interface DiscountResult {
  saved: number;
  final: number;
}

/**
 * Take a percentage off a price.
 *
 * Rejects a percentage outside 0–100 rather than returning a negative price:
 * "150% off £100" used to display "You pay -50.00", which is not a discount,
 * it is a refund plus change. Matches `splitBill`, which already refuses a
 * head-count below one.
 */
export function applyDiscount(price: number, percentOff: number): DiscountResult {
  if (!Number.isFinite(price)) throw new CalcError("Enter a price");
  if (!Number.isFinite(percentOff) || percentOff < 0 || percentOff > 100) {
    throw new CalcError("Discount must be between 0 and 100%");
  }
  const saved = price * (percentOff / 100);
  return { saved, final: price - saved };
}

export interface SplitResult {
  /** Bill after the tip is added. */
  total: number;
  /** The tip portion alone. */
  tip: number;
  /** What each person pays, rounded up to the cent. */
  perPerson: number;
  /** Rounding leftover the payer absorbs (may be 0). */
  remainder: number;
}

/**
 * Split a bill, optionally with a tip.
 *
 * Per-head is rounded UP to the cent so the collected total is never short;
 * `remainder` reports the small overshoot rather than hiding it.
 */
export function splitBill(amount: number, people: number, tipPercent = 0): SplitResult {
  if (!Number.isFinite(people) || people < 1) throw new CalcError("Need at least one person");
  const tip = amount * (tipPercent / 100);
  const total = amount + tip;
  const exact = total / people;
  const perPerson = Math.ceil(exact * 100) / 100;
  return { total, tip, perPerson, remainder: perPerson * people - total };
}

export interface MarginResult {
  /** Absolute profit. */
  profit: number;
  /** Profit as a share of the SELLING price. */
  marginPercent: number;
  /** Profit as a share of the COST — the bigger, flattering number. */
  markupPercent: number;
}

/**
 * Profit, margin and markup.
 *
 * Margin and markup are routinely confused: a 50% markup is only a 33.3%
 * margin. Both are returned so the distinction is visible rather than assumed.
 */
export function profitMargin(cost: number, sell: number): MarginResult {
  const profit = sell - cost;
  return {
    profit,
    marginPercent: sell === 0 ? 0 : (profit / sell) * 100,
    markupPercent: cost === 0 ? 0 : (profit / cost) * 100,
  };
}

// ---- history --------------------------------------------------------------

export interface HistoryEntry {
  expression: string;
  result: string;
}

/** Newest first, capped — the panel keeps a short in-memory tape, not a log. */
export const HISTORY_LIMIT = 12;

export function pushHistory(list: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [entry, ...list].slice(0, HISTORY_LIMIT);
}

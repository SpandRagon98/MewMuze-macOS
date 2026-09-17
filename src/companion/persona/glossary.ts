//! Plain definitions of terms small models get wrong.
//!
//! Asked "What is a SIP?", Qwen3-1.7B answered "Single Interest Payment" and,
//! in another run, "Session Initiation Protocol"; the 0.6B model said "Service
//! IP". When a message mentions a term below, its definition rides along as a
//! fact (the same path live facts use), so the reply builds on it instead of
//! inventing one. Definitions only - never doses, prices or advice.

interface Term {
  /** Matched on word boundaries. Acronyms are case-sensitive ("SIP", not "sip of water"). */
  match: RegExp;
  fact: string;
}

const TERMS: readonly Term[] = [
  { match: /\bSIPs?\b/, fact: "SIP = Systematic Investment Plan: investing a fixed amount in a mutual fund at regular intervals, usually monthly." },
  { match: /\bEMIs?\b/, fact: "EMI = Equated Monthly Instalment: the fixed monthly loan payment that covers interest and part of the principal." },
  { match: /\bNAV\b/, fact: "NAV = Net Asset Value: the price of one unit of a mutual fund." },
  { match: /\bELSS\b/, fact: "ELSS = Equity Linked Savings Scheme: an Indian tax-saving equity mutual fund with a 3-year lock-in." },
  { match: /\bPPF\b/, fact: "PPF = Public Provident Fund: a government-backed Indian savings scheme with a 15-year term." },
  { match: /\b(FDs?|fixed deposits?)\b/i, fact: "A fixed deposit (FD) is money kept with a bank for a fixed term at a fixed interest rate." },
  { match: /\bETFs?\b/, fact: "ETF = exchange-traded fund: a fund holding a basket of assets that trades on a stock exchange like a share." },
  { match: /\bindex funds?\b/i, fact: "An index fund tracks a market index such as the Nifty 50 or the S&P 500, usually with low fees." },
  { match: /\bmutual funds?\b/i, fact: "A mutual fund pools many investors' money, managed by a professional fund manager." },
  { match: /\b(CIBIL|credit score)\b/i, fact: "A credit score (CIBIL score in India, 300-900) summarises how reliably someone has repaid credit." },
  { match: /\bAPR\b/, fact: "APR = annual percentage rate: the yearly cost of borrowing, including interest and fees." },
  { match: /\bcompound interest\b/i, fact: "Compound interest is interest earned on the original amount and on the interest already added." },
  { match: /\bUPI\b/, fact: "UPI = Unified Payments Interface: India's instant bank-to-bank payment system." },
  { match: /\bGST\b/, fact: "GST = Goods and Services Tax: India's tax on the supply of goods and services." },
  { match: /\b401\(?k\)?/i, fact: "A 401(k) is a US employer-sponsored retirement savings account." },
  { match: /\bBMI\b/, fact: "BMI = body mass index: weight in kg divided by height in metres squared - a rough screening number, not a diagnosis." },
  { match: /\b(paracetamol|acetaminophen)\b/i, fact: "Paracetamol (acetaminophen) relieves pain and fever; going over the label's daily maximum can damage the liver." },
  { match: /\bibuprofen\b/i, fact: "Ibuprofen is an anti-inflammatory painkiller (an NSAID); people with stomach, kidney or heart problems should ask a pharmacist first." },
  { match: /\bcetirizine\b/i, fact: "Cetirizine is an antihistamine for allergies such as hay fever and hives; it can make some people drowsy." },
];

/** The definitions a message needs, as one facts line - or "" if none. */
export function glossaryNote(text: string): string {
  const facts = TERMS.filter((t) => t.match.test(text)).map((t) => t.fact);
  return facts.length ? `Reliable definitions (use them, do not contradict them): ${facts.join(" ")}` : "";
}

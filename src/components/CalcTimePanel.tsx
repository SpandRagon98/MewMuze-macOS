import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { placePanel, type Area, type Box } from "../quicktools/panelPlacement";
import {
  applyDiscount,
  applyTax,
  CalcError,
  formatNumber,
  profitMargin,
  pushHistory,
  splitBill,
  tryEvaluate,
  type HistoryEntry,
} from "../calctime/calculator";
import { CATEGORIES, convert, findCategory, formatConverted } from "../calctime/units";
import {
  convertZone,
  dayShiftLabel,
  findZone,
  formatDate,
  formatOffset,
  formatTime,
  localZone,
  searchZones,
  zoneAbbreviation,
} from "../calctime/timezones";
import "./calctime.css";

/**
 * Calculator · Units · Time.
 *
 * Deliberately reuses the `quick-tools` class so it inherits the existing
 * skeuomorphic theme — surfaces, shadows, typography, and the whole `.sk-light`
 * variant — rather than restating it. Only genuinely new structure gets its own
 * `ct-` classes. Placement uses the same helper Quick Tools does, so it opens
 * beside the cat and never covers it.
 */
export const CALC_PANEL_SIZE = { width: 306, height: 428 };

type Tab = "calc" | "units" | "time";
/** The extra money tools, folded away so the keypad stays the default view. */
type MoneyTool = "none" | "tax" | "discount" | "split" | "margin";

const KEYS: string[] = [
  "7", "8", "9", "÷",
  "4", "5", "6", "×",
  "1", "2", "3", "−",
  "0", ".", "=", "+",
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** A searchable zone picker: a filter box above a native select. */
function ZonePicker({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => searchZones(query), [query]);
  const zone = findZone(value);
  return (
    <div className="ct-zone">
      <div className="ct-zone-label">{label}</div>
      <input
        className="ct-input ct-zone-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={zone ? `${zone.label} — search…` : "Search city or zone…"}
        aria-label={`Search ${label}`}
        spellCheck={false}
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        size={1}
      >
        {/* Keep the current zone selectable even when the filter excludes it,
            or changing the search would silently reset the selection. */}
        {matches.length === 0 && zone && (
          <option value={zone.id}>{zone.label} — {zone.region}</option>
        )}
        {matches.map((z) => (
          <option key={z.id} value={z.id}>
            {z.label} — {z.region}
          </option>
        ))}
      </select>
    </div>
  );
}

export function CalcTimePanel({
  cat,
  area,
  onClose,
  onResult,
}: {
  cat: Box;
  area: Area;
  onClose: () => void;
  /** Fires when the user copies something, so the cat can react. */
  onResult?: (kind: "copy" | "error") => void;
}) {
  const [tab, setTab] = useState<Tab>("calc");

  // ---- calculator ----
  const [expr, setExpr] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [money, setMoney] = useState<MoneyTool>("none");
  const [amount, setAmount] = useState("1000");
  const [rate, setRate] = useState("18");
  const [taxMode, setTaxMode] = useState<"add" | "remove">("add");
  const [people, setPeople] = useState("4");
  const [tip, setTip] = useState("10");
  const [cost, setCost] = useState("100");
  const [sell, setSell] = useState("150");

  // Live preview: evaluated on every keystroke, never on a timer.
  const live = useMemo(() => (expr.trim() ? tryEvaluate(expr) : null), [expr]);

  // ---- units ----
  const [catId, setCatId] = useState("length");
  const category = findCategory(catId) ?? CATEGORIES[0];
  const [fromU, setFromU] = useState(category.defaultFrom);
  const [toU, setToU] = useState(category.defaultTo);
  const [unitValue, setUnitValue] = useState("1");

  // ---- time ----
  const now = useMemo(() => new Date(), []);
  const [date, setDate] = useState(
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
  );
  const [time, setTime] = useState(`${pad2(now.getHours())}:${pad2(now.getMinutes())}`);
  const [fromZ, setFromZ] = useState(() => (findZone(localZone()) ? localZone() : "Asia/Kolkata"));
  const [toZ, setToZ] = useState("America/New_York");
  const [hour12, setHour12] = useState(true);

  const [copied, setCopied] = useState("");

  const boxRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState(() =>
    placePanel({ cat, panel: CALC_PANEL_SIZE, area }),
  );

  // The three tabs are different heights, so re-place against the box that
  // actually rendered — same approach Quick Tools uses.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // A zero measurement means the box has not been laid out yet (or is
    // hidden). Re-placing against it would size the panel to nothing and park
    // it off-screen, so keep the estimate until a real box exists.
    if (r.width < 1 || r.height < 1) return;
    if (
      Math.abs(r.width - CALC_PANEL_SIZE.width) > 2 ||
      Math.abs(r.height - CALC_PANEL_SIZE.height) > 2
    ) {
      setPlacement(placePanel({ cat, panel: { width: r.width, height: r.height }, area }));
    }
  }, [cat, area, tab, money, history.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Clear the "Copied" flash without leaving a timer behind on unmount.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(""), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      onResult?.("copy");
    } catch {
      setCopied("");
      onResult?.("error");
    }
  };

  const pressKey = (k: string) => {
    if (k === "=") {
      const r = tryEvaluate(expr);
      if (r.ok) {
        setHistory((h) => pushHistory(h, { expression: expr, result: formatNumber(r.value) }));
        setExpr(formatNumber(r.value).replace(/,/g, ""));
      } else {
        onResult?.("error");
      }
      return;
    }
    setExpr((e) => e + k);
  };

  // ---- unit conversion result ----
  const unitResult = useMemo(() => {
    const n = Number(unitValue);
    if (!unitValue.trim() || !Number.isFinite(n)) return null;
    try {
      return convert(n, catId, fromU, toU);
    } catch {
      return null;
    }
  }, [unitValue, catId, fromU, toU]);

  const toUnitSymbol = category.units.find((u) => u.id === toU)?.symbol ?? "";

  // ---- time conversion result ----
  const timeResult = useMemo(() => {
    const [y, m, d] = date.split("-").map(Number);
    const [hh, mm] = time.split(":").map(Number);
    if (![y, m, d, hh, mm].every((v) => Number.isFinite(v))) return null;
    try {
      return convertZone({ year: y, month: m, day: d, hour: hh, minute: mm }, fromZ, toZ);
    } catch {
      return null;
    }
  }, [date, time, fromZ, toZ]);

  const switchCategory = (id: string) => {
    const next = findCategory(id);
    if (!next) return;
    setCatId(id);
    setFromU(next.defaultFrom);
    setToU(next.defaultTo);
  };

  /**
   * Money results, or the reason there isn't one.
   *
   * The money helpers reject nonsense input by throwing (a discount over 100%,
   * a bill split between zero people). Swallowing that and rendering nothing
   * left the panel looking broken — the result simply vanished with no hint
   * why — so the message is surfaced instead.
   */
  const moneyOut = (): { label: string; value: string; error?: false } | { error: true; message: string } | null => {
    const a = Number(amount);
    try {
      if (money === "tax") {
        const r = applyTax(a, Number(rate), taxMode);
        return {
          label: taxMode === "add" ? "Total with tax" : "Before tax",
          value: `${formatNumber(taxMode === "add" ? r.total : r.base, 2)}  (tax ${formatNumber(r.tax, 2)})`,
        };
      }
      if (money === "discount") {
        const r = applyDiscount(a, Number(rate));
        return { label: "You pay", value: `${formatNumber(r.final, 2)}  (save ${formatNumber(r.saved, 2)})` };
      }
      if (money === "split") {
        const r = splitBill(a, Number(people), Number(tip));
        return { label: "Each person", value: `${formatNumber(r.perPerson, 2)}  of ${formatNumber(r.total, 2)}` };
      }
      if (money === "margin") {
        const r = profitMargin(Number(cost), Number(sell));
        return {
          label: "Profit",
          value: `${formatNumber(r.profit, 2)}  ·  margin ${formatNumber(r.marginPercent, 1)}%  ·  markup ${formatNumber(r.markupPercent, 1)}%`,
        };
      }
    } catch (err) {
      // Only the helpers' own validation messages are shown; anything else
      // stays generic rather than leaking an internal error string.
      const message = err instanceof CalcError ? err.message : "Check the values above";
      return { error: true, message };
    }
    return null;
  };
  const mo = money === "none" ? null : moneyOut();

  return (
    <div
      ref={boxRef}
      className="quick-tools calc-tools pixel-ui"
      data-side={placement.side}
      style={{ left: placement.x, top: placement.y, width: CALC_PANEL_SIZE.width }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        // Suppress both the cat's menu and the webview's default menu.
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="qt-head">
        <span className="qt-title">🧮 Calc &amp; Time</span>
        <button className="qt-x" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <div className="ct-tabs" role="tablist">
        {([
          ["calc", "Calculator"],
          ["units", "Units"],
          ["time", "Time"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`ct-tab${tab === id ? " active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "calc" && (
        <>
          <div className="ct-display">
            <input
              className="ct-expr"
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
              placeholder="0"
              aria-label="Expression"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter") pressKey("=");
              }}
            />
            <div className={`ct-preview${live && !live.ok ? " error" : ""}`}>
              {live ? (live.ok ? `= ${formatNumber(live.value)}` : live.error) : " "}
            </div>
          </div>

          <div className="ct-keys">
            <button className="ct-key fn" onClick={() => setExpr("")}>C</button>
            <button className="ct-key fn" onClick={() => setExpr((e) => e.slice(0, -1))}>⌫</button>
            <button className="ct-key fn" onClick={() => setExpr((e) => e + "(")}>(</button>
            <button className="ct-key fn" onClick={() => setExpr((e) => e + ")")}>)</button>
            <button className="ct-key fn" onClick={() => setExpr((e) => e + "√")}>√</button>
            <button className="ct-key fn" onClick={() => setExpr((e) => e + "^")}>x^y</button>
            <button className="ct-key fn" onClick={() => setExpr((e) => e + "%")}>%</button>
            <button
              className="ct-key fn"
              onClick={() => live?.ok && copy(formatNumber(live.value), "Result")}
              disabled={!live?.ok}
              title="Copy result"
            >
              ⧉
            </button>
            {KEYS.map((k) => (
              <button
                key={k}
                className={`ct-key${k === "=" ? " eq" : ""}`}
                onClick={() => pressKey(k)}
              >
                {k}
              </button>
            ))}
          </div>

          <div className="qt-section">Everyday maths</div>
          <div className="ct-chips">
            {([
              ["tax", "GST / Tax"],
              ["discount", "Discount"],
              ["split", "Split bill"],
              ["margin", "Margin"],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                className={`ct-chip${money === id ? " active" : ""}`}
                onClick={() => setMoney((m) => (m === id ? "none" : id))}
              >
                {label}
              </button>
            ))}
          </div>

          {money !== "none" && (
            <div className="ct-money">
              {money === "margin" ? (
                <div className="ct-fields">
                  <label>Cost<input className="ct-input" value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" /></label>
                  <label>Sell<input className="ct-input" value={sell} onChange={(e) => setSell(e.target.value)} inputMode="decimal" /></label>
                </div>
              ) : (
                <div className="ct-fields">
                  <label>Amount<input className="ct-input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></label>
                  {money === "split" ? (
                    <>
                      <label>People<input className="ct-input" value={people} onChange={(e) => setPeople(e.target.value)} inputMode="numeric" /></label>
                      <label>Tip %<input className="ct-input" value={tip} onChange={(e) => setTip(e.target.value)} inputMode="decimal" /></label>
                    </>
                  ) : (
                    <label>{money === "tax" ? "Rate %" : "Off %"}<input className="ct-input" value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" /></label>
                  )}
                </div>
              )}
              {money === "tax" && (
                <div className="qt-row">
                  <select value={taxMode} onChange={(e) => setTaxMode(e.target.value as "add" | "remove")}>
                    <option value="add">Add tax on top</option>
                    <option value="remove">Amount already includes tax</option>
                  </select>
                </div>
              )}
              {mo?.error === true ? (
                <div className="ct-result ct-result-error">
                  <div className="ct-result-label">Check that</div>
                  <div className="ct-result-value">{mo.message}</div>
                </div>
              ) : (
                mo && (
                  <div className="ct-result">
                    <div className="ct-result-label">{mo.label}</div>
                    <div className="ct-result-value">{mo.value}</div>
                    <button className="pixel-btn" onClick={() => copy(mo.value, "Result")}>Copy</button>
                  </div>
                )
              )}
            </div>
          )}

          {history.length > 0 && (
            <>
              <div className="qt-section">
                History
                <button className="ct-clear" onClick={() => setHistory([])}>clear</button>
              </div>
              <div className="ct-history">
                {history.map((h, i) => (
                  <button
                    key={`${h.expression}-${i}`}
                    className="ct-hist-row"
                    onClick={() => setExpr(h.result.replace(/,/g, ""))}
                    title="Use this result"
                  >
                    <span className="ct-hist-expr">{h.expression}</span>
                    <span className="ct-hist-res">{h.result}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {tab === "units" && (
        <>
          <div className="qt-row">
            <select value={catId} onChange={(e) => switchCategory(e.target.value)} aria-label="Category">
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div className="ct-convert">
            <input
              className="ct-input ct-value"
              value={unitValue}
              onChange={(e) => setUnitValue(e.target.value)}
              inputMode="decimal"
              aria-label="Value"
              spellCheck={false}
            />
            <select value={fromU} onChange={(e) => setFromU(e.target.value)} aria-label="From unit">
              {category.units.map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.symbol})</option>
              ))}
            </select>
            <button
              className="ct-swap"
              onClick={() => {
                setFromU(toU);
                setToU(fromU);
              }}
              title="Swap units"
              aria-label="Swap units"
            >
              ⇄
            </button>
            <select value={toU} onChange={(e) => setToU(e.target.value)} aria-label="To unit">
              {category.units.map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.symbol})</option>
              ))}
            </select>
          </div>

          <div className="ct-result big">
            <div className="ct-result-value">
              {unitResult === null ? "—" : `${formatConverted(unitResult)} ${toUnitSymbol}`}
            </div>
            <button
              className="pixel-btn"
              disabled={unitResult === null}
              onClick={() => unitResult !== null && copy(formatConverted(unitResult), "Value")}
            >
              Copy
            </button>
          </div>
        </>
      )}

      {tab === "time" && (
        <>
          <div className="ct-datetime">
            <input
              className="ct-input"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-label="Date"
            />
            <input
              className="ct-input"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              aria-label="Time"
            />
          </div>

          <div className="ct-zones">
            <ZonePicker value={fromZ} onChange={setFromZ} label="From" />
            <button
              className="ct-swap"
              onClick={() => {
                setFromZ(toZ);
                setToZ(fromZ);
              }}
              title="Swap zones"
              aria-label="Swap zones"
            >
              ⇄
            </button>
            <ZonePicker value={toZ} onChange={setToZ} label="To" />
          </div>

          <div className="qt-row ct-mode">
            <button
              className={`ct-chip${hour12 ? " active" : ""}`}
              onClick={() => setHour12(true)}
            >
              12h
            </button>
            <button
              className={`ct-chip${!hour12 ? " active" : ""}`}
              onClick={() => setHour12(false)}
            >
              24h
            </button>
          </div>

          {timeResult && (
            <div className="ct-time-out">
              <div className="ct-time-big">{formatTime(timeResult.wall, hour12)}</div>
              <div className="ct-time-date">
                {formatDate(timeResult.wall)}
                {timeResult.dayShift !== 0 && (
                  <span className="ct-dayshift">{dayShiftLabel(timeResult.dayShift)}</span>
                )}
              </div>
              <div className="ct-time-zone">
                {findZone(toZ)?.label ?? toZ} ·{" "}
                {zoneAbbreviation(timeResult.utcMs, toZ) || formatOffset(timeResult.offsetMinutes)} ·{" "}
                {formatOffset(timeResult.offsetMinutes)}
              </div>
              <button
                className="pixel-btn primary"
                onClick={() =>
                  copy(
                    `${formatTime(timeResult.wall, hour12)} · ${formatDate(timeResult.wall)} · ${findZone(toZ)?.label ?? toZ}`,
                    "Time",
                  )
                }
              >
                Copy
              </button>
            </div>
          )}
        </>
      )}

      {copied && <div className="ct-copied">{copied} copied</div>}
    </div>
  );
}

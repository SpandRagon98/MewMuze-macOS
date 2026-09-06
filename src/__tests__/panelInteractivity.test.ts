import { describe, it, expect } from "vitest";
// @ts-expect-error ?raw has no ambient type without vite/client in `types`.
import appSource from "../App.tsx?raw";

/**
 * The overlay window is CLICK-THROUGH by default. It is only made interactive
 * while the cursor is over the cat, or while `overUI` is true — and `overUI` is
 * driven by a hand-maintained list of panel refs in App.tsx.
 *
 * A panel missing from that list renders perfectly and then swallows nothing:
 * every click passes straight through to the app behind it, so it looks frozen.
 * That is exactly what happened when Calc & Time was first wired up, and the
 * component tests could not catch it because they render the panel in isolation
 * rather than through the overlay.
 *
 * These tests read App.tsx and assert the wiring, which is the only place the
 * invariant actually lives.
 */

const APP: string = appSource;

/** The `if (...) overUI = true;` condition that unlocks pointer input. */
function clickThroughGate(): string {
  const start = APP.indexOf("let overUI = false;");
  expect(start, "the click-through gate should exist in App.tsx").toBeGreaterThan(-1);
  const end = APP.indexOf("overUI = true;", start);
  expect(end).toBeGreaterThan(start);
  return APP.slice(start, end);
}

/** Refs for panels that must accept clicks whenever they are open. */
const PANEL_REFS = [
  "gateRef",
  "menuRef",
  "panelRef",
  "costumeInstallRef",
  "quickToolsRef",
  "reminderPanelRef",
  "notePanelRef",
  "breakPickerRef",
  "clipboardPanelRef",
  "calcTimeRef",
];

describe("overlay interactivity wiring", () => {
  it("registers every panel in the click-through gate", () => {
    const gate = clickThroughGate();
    const missing = PANEL_REFS.filter((ref) => !gate.includes(ref));
    expect(
      missing,
      `these panels render but would be click-through (unclickable): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps Calc & Time clickable — the exact regression that shipped once", () => {
    expect(clickThroughGate()).toContain("calcTimeRef.current");
  });

  it("suppresses cursor chasing while a tool panel is open", () => {
    // Otherwise the cat wanders off after the pointer while you are typing into
    // the panel, leaving it anchored to empty space.
    const start = APP.indexOf("engine.setCursorChasing(");
    expect(start).toBeGreaterThan(-1);
    const block = APP.slice(start, APP.indexOf(");", start));
    for (const ref of ["quickToolsRef", "clipboardPanelRef", "calcTimeRef"]) {
      expect(block, `${ref} should suppress chasing while open`).toContain(ref);
    }
  });

  it("declares a ref for every panel it gates on", () => {
    // `x.current` only works if `const xRef = useRef(...)` exists; a typo here
    // would be a silent always-falsy check rather than a compile error.
    for (const ref of PANEL_REFS) {
      expect(APP, `${ref} should be declared`).toContain(`const ${ref} = useRef(`);
    }
  });
});

/**
 * Calc & Time enters the same way Work mode does: a lightning strike, the cat
 * swapping to its tool pose mid-flash, and then parked with the tool until the
 * panel closes. These assert the wiring, since the transition lives inside
 * App.tsx's effect closure and cannot be imported.
 */
describe("Calc & Time strike transition", () => {
  it("fires the shared ThunderStrike with the shared timings", () => {
    const start = APP.indexOf("const strikeIntoCalcMode");
    expect(start, "strikeIntoCalcMode should exist").toBeGreaterThan(-1);
    const block = APP.slice(start, start + 700);
    expect(block).toContain("setStrike(");
    // Reused, not re-invented: the same constants Work mode uses.
    expect(block).toContain("STRIKE_SWAP_MS");
    expect(block).toContain("STRIKE_TOTAL_MS");
  });

  it("arms the pose at the strike so the swap hides inside the flash", () => {
    const block = APP.slice(APP.indexOf("const strikeIntoCalcMode"), APP.indexOf("const enterCalcMode"));
    expect(block).toContain("calcModeArmed = true");
  });

  it("parks the cat holding the calculator while the panel is open", () => {
    // The armed flag is OR-ed in so the pose holds from the flash onward, not
    // only once the panel state lands.
    expect(APP).toContain("calcTimeRef.current !== null || calcModeArmed");
    const loop = APP.slice(APP.indexOf("const loopAnim"), APP.indexOf("const loopAnim") + 400);
    expect(loop).toContain('"calcTools"');
  });

  it("treats work mode and calc mode as mutually exclusive", () => {
    // Both park the cat at a tool; entering one must leave the other, or the
    // cat would be armed for two poses at once.
    const enterCalc = APP.slice(APP.indexOf("const enterCalcMode"), APP.indexOf("const enterWorkMode"));
    expect(enterCalc).toContain("exitWorkMode()");
    const enterWork = APP.slice(APP.indexOf("const enterWorkMode"));
    expect(enterWork.slice(0, 300)).toContain("exitCalcMode()");
  });

  it("clears the strike when leaving, so no flash is left on screen", () => {
    const block = APP.slice(APP.indexOf("const exitCalcMode"), APP.indexOf("const exitCalcMode") + 220);
    expect(block).toContain("setStrike(null)");
    expect(block).toContain("calcModeArmed = false");
    expect(block).toContain("setCalcTime(null)");
  });
});

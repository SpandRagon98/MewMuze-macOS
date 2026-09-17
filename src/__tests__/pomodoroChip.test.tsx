import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreakPicker, PomodoroChip } from "../components/OverlayUI";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (onClose = vi.fn()) => {
  act(() =>
    root.render(<PomodoroChip snapshot={{ phase: "focus", remaining: 1500, cycle: 1, completed: null }} x={10} y={10} onClose={onClose} />),
  );
  return onClose;
};

describe("pomodoro chip", () => {
  it("can be dismissed from the chip itself", () => {
    const onClose = render();
    const x = host.querySelector<HTMLButtonElement>(".pomo-x")!;
    expect(x.getAttribute("aria-label")).toBe("Stop the timer");
    act(() => x.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("still shows the phase and the time left", () => {
    render();
    expect(host.querySelector(".pomo-chip")!.textContent).toContain("Focus");
    expect(host.querySelector(".pomo-chip")!.textContent).toContain("25:00");
  });

  it("stays out of the way when no timer is running", () => {
    act(() =>
      root.render(<PomodoroChip snapshot={{ phase: "idle", remaining: 0, cycle: 0, completed: null }} x={0} y={0} onClose={vi.fn()} />),
    );
    expect(host.querySelector(".pomo-chip")).toBeNull();
  });
});

describe("break picker", () => {
  it("closes on Escape, like every other surface by the cat", () => {
    const onClose = vi.fn();
    act(() =>
      root.render(<BreakPicker catCx={300} catTop={400} areaLeft={0} areaRight={1000} onPick={vi.fn()} onClose={onClose} />),
    );
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MailStack } from "../components/OverlayUI";

/**
 * jsdom has no layout engine, so every rect measures 0 — the placement maths
 * cannot be asserted here (that is browser-harness work). What these cover is
 * the part that breaks silently: which cards render, what the buttons are, and
 * that each one acts on ITS OWN message rather than the top of the stack.
 */
describe("MailStack", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const items = (uids: number[]) => uids.map((uid) => ({ uid, line: `Sender ${uid} — Subject ${uid}` }));

  function render(props: Partial<Parameters<typeof MailStack>[0]> = {}) {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <MailStack
          items={items([8, 7, 6, 5, 4])}
          limit={5}
          queued={3}
          catCx={500}
          catTop={400}
          areaLeft={0}
          areaRight={1920}
          areaTop={0}
          noticeKey=""
          onOpen={onOpen}
          onDismiss={onDismiss}
          {...props}
        />,
      );
    });
    return { onOpen, onDismiss };
  }

  const cards = () => Array.from(host.querySelectorAll(".mail-card"));

  it("renders one card per visible message, newest first in the DOM", () => {
    render();
    expect(cards()).toHaveLength(5);
    expect(cards()[0].textContent).toContain("Sender 8");
    expect(cards()[4].textContent).toContain("Sender 4");
  });

  it("gives every card both an Open and an OK button", () => {
    render();
    for (const card of cards()) {
      const labels = Array.from(card.querySelectorAll("button")).map((b) => b.textContent);
      expect(labels).toEqual(["Open", "OK"]);
    }
  });

  it("OK dismisses only the card it belongs to", () => {
    const { onDismiss, onOpen } = render();
    const third = cards()[2]; // uid 6
    act(() => {
      third.querySelectorAll("button")[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(6);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("Open acts on its own message, not the newest one", () => {
    const { onOpen, onDismiss } = render();
    const last = cards()[4]; // uid 4
    act(() => {
      last.querySelectorAll("button")[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(4);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("shows the queued overflow count once, on the topmost card", () => {
    render();
    const more = host.querySelectorAll(".mail-more");
    expect(more).toHaveLength(1);
    expect(more[0].textContent).toBe("+3 more");
    // Visually topmost = last in the DOM, because the column is reversed.
    expect(cards()[4].contains(more[0])).toBe(true);
  });

  it("shows no overflow badge when nothing is queued", () => {
    render({ items: items([2, 1]), queued: 0 });
    expect(host.querySelectorAll(".mail-more")).toHaveLength(0);
    expect(cards()).toHaveLength(2);
  });

  it("respects a user limit of one", () => {
    render({ items: items([9]), limit: 1, queued: 4 });
    expect(cards()).toHaveLength(1);
    expect(cards()[0].textContent).toContain("Sender 9");
    expect(host.querySelector(".mail-more")?.textContent).toBe("+4 more");
  });

  describe("placement against an anchored notice", () => {
    // jsdom measures everything as 0, so feed the component real numbers. Only
    // the notice's HEIGHT is stubbed meaningfully: the component must not read
    // its position, which is a frame stale in the real app.
    const CARD_H = 33;
    const STACK_H = 185;
    const STACK_W = 500;
    let original: typeof Element.prototype.getBoundingClientRect;

    beforeEach(() => {
      original = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function (this: Element) {
        const rect = (h: number, w: number, top: number) =>
          ({ height: h, width: w, top, bottom: top + h, left: 0, right: w, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
        if (this.classList.contains("notice-single")) return rect(30, 300, -9999); // parked, unplaced
        if (this.classList.contains("mail-stack")) return rect(STACK_H, STACK_W, 0);
        if (this.classList.contains("mail-card")) return rect(CARD_H, 456, 0);
        return original.call(this);
      };
    });
    afterEach(() => {
      Element.prototype.getBoundingClientRect = original;
    });

    const styleOf = () => (host.querySelector(".mail-stack") as HTMLElement).style;

    it("sits above the cat when no notice is anchored", () => {
      render({ catCx: 640, catTop: 500, areaLeft: 0, areaRight: 1280, areaTop: 0, noticeKey: "" });
      // bottom = catTop - GAP(5)  →  top = 500 - 5 - 185
      expect(styleOf().top).toBe("310px");
      expect(styleOf().left).toBe(`${640 - STACK_W / 2}px`); // centred on the cat
    });

    it("clears an anchored notice by its height, never by its stale position", () => {
      const notice = document.createElement("div");
      notice.className = "retro-notice notice-single";
      document.body.appendChild(notice);
      try {
        render({ catCx: 640, catTop: 500, areaLeft: 0, areaRight: 1280, areaTop: 0, noticeKey: "sch:1|x" });
        // catTop - GAP - noticeHeight(30) - GAP - stackHeight
        expect(styleOf().top).toBe("275px");
      } finally {
        notice.remove();
      }
    });

    it("clamps into the work area at the left and right edges", () => {
      render({ catCx: 10, catTop: 500, areaLeft: 0, areaRight: 1280, areaTop: 0 });
      expect(styleOf().left).toBe("6px"); // areaLeft + MARGIN, never negative
      render({ catCx: 1270, catTop: 500, areaLeft: 0, areaRight: 1280, areaTop: 0 });
      expect(styleOf().left).toBe(`${1280 - 6 - STACK_W}px`);
    });

    it("shows fewer cards when there is not enough room above the cat", () => {
      // Room for roughly three cards: (catTop - GAP) - (areaTop + MARGIN).
      render({ catCx: 640, catTop: 130, areaLeft: 0, areaRight: 1280, areaTop: 0 });
      expect(host.querySelectorAll(".mail-card").length).toBeLessThan(5);
      expect(host.querySelectorAll(".mail-card").length).toBeGreaterThanOrEqual(1);
    });

    it("never renders zero cards, even with the cat jammed against the top", () => {
      render({ catCx: 640, catTop: 8, areaLeft: 0, areaRight: 1280, areaTop: 0 });
      expect(host.querySelectorAll(".mail-card").length).toBe(1);
    });
  });

  it("keeps the retro notice styling the rest of the app uses", () => {
    render();
    for (const card of cards()) expect(card.classList.contains("retro-notice")).toBe(true);
    // The stack must NOT look like the single cat-anchored notice, or it would
    // measure itself against its own cards.
    expect(host.querySelectorAll(".notice-single")).toHaveLength(0);
  });
});

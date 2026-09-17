import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoModePanel } from "../photo/PhotoModePanel";
import { PHOTO_EXPRESSIONS, PHOTO_POSES } from "../photo/photoMode";
import { CatContextMenu } from "../components/OverlayUI";
import { allMenuLabels } from "./menuHelpers";

const cat = { x: 400, y: 400, width: 64, height: 64 };
const area = { left: 0, top: 0, right: 1920, bottom: 1032 };

function reactEnv() {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });
}

describe("Photo Mode panel", () => {
  let host: HTMLDivElement;
  let root: Root;
  reactEnv();

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(over: Partial<Parameters<typeof PhotoModePanel>[0]> = {}) {
    const onSelectionChange = vi.fn();
    const onFolderChange = vi.fn();
    const onClose = vi.fn();
    act(() => {
      root.render(
        <PhotoModePanel
          cat={cat}
          area={area}
          folder=""
          onSelectionChange={onSelectionChange}
          onFolderChange={onFolderChange}
          onClose={onClose}
          {...over}
        />,
      );
    });
    return { onSelectionChange, onFolderChange, onClose };
  }

  const click = (el: Element) =>
    act(() => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

  const button = (label: string) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === label,
    )!;

  it("wears the same shell as the other panels, not a new dialog style", () => {
    render();
    const panel = host.querySelector(".photo-mode")!;
    expect(panel.classList.contains("quick-tools")).toBe(true);
    expect(panel.classList.contains("pixel-ui")).toBe(true);
    expect(host.querySelector(".qt-title")?.textContent).toContain("Photo Mode");
    expect(host.querySelector(".qt-x")).not.toBeNull();
  });

  it("offers every pose and every expression", () => {
    render();
    const chips = Array.from(host.querySelectorAll(".pm-chips .sk-chip")).map((c) => c.textContent);
    for (const pose of PHOTO_POSES) expect(chips, pose.label).toContain(pose.label);
    for (const face of PHOTO_EXPRESSIONS) expect(chips, face.label).toContain(face.label);
  });

  it("tells the app which pose to hold the real cat in", () => {
    const { onSelectionChange } = render();
    // The initial selection is published, so the cat poses as soon as it opens.
    expect(onSelectionChange).toHaveBeenLastCalledWith({ poseId: "sit", expressionId: "as-posed" });
    click(button("Wave"));
    expect(onSelectionChange).toHaveBeenLastCalledWith({ poseId: "wave", expressionId: "as-posed" });
    click(button("Sleepy"));
    expect(onSelectionChange).toHaveBeenLastCalledWith({ poseId: "wave", expressionId: "sleepy" });
  });

  it("marks exactly one pose and one expression as chosen", () => {
    render();
    const rows = host.querySelectorAll(".pm-chips");
    expect(rows[0].querySelectorAll(".sk-chip.on")).toHaveLength(1);
    expect(rows[1].querySelectorAll(".sk-chip.on")).toHaveLength(1);
  });

  it("shows every whole feeling at once, no side-scrolling", () => {
    render();
    // Pose, faces, then feelings: each group is a wrapped row of its own.
    const feelingsRow = host.querySelectorAll(".pm-chips")[2];
    const feelings = Array.from(feelingsRow.querySelectorAll(".sk-chip")).map((c) => c.textContent);
    expect(feelings).toEqual(["Sad", "Crying", "Savage", "Victory", "Shy", "Angry", "Curious", "Excited"]);
    click(Array.from(feelingsRow.querySelectorAll<HTMLButtonElement>(".sk-chip")).find((b) => b.textContent === "Crying")!);
    expect(feelingsRow.querySelector(".sk-chip.on")?.textContent).toBe("Crying");
  });

  it("groups its choices into labelled sections", () => {
    render();
    // Left column: the shot. Right column: the cat.
    const heads = Array.from(host.querySelectorAll(".qt-group-head")).map((h) => h.textContent);
    expect(heads).toEqual(["Capture", "Pose", "Expression", "Feeling"]);
    const cols = host.querySelectorAll(".pm-body .pm-col");
    expect(cols).toHaveLength(2);
    expect(cols[0].querySelector(".pm-stage")).toBeTruthy();
    expect(cols[0].querySelector(".pm-capture")).toBeTruthy();
    expect(cols[1].querySelectorAll(".pm-chips")).toHaveLength(3);
  });

  it("opens on Cat only, with no screen warning in sight", () => {
    render();
    expect(host.querySelector(".pm-mode.on")?.textContent).toBe("Cat only");
    expect(host.querySelector(".pm-consent")).toBeNull();
    expect(host.querySelector(".pm-detail")?.textContent).toContain("Transparent");
    // Save and Copy are live immediately: the safe modes need no permission.
    expect(button("Save").disabled).toBe(false);
    expect(button("Copy Image").disabled).toBe(false);
  });

  it("blocks a desktop photo until the warning is accepted", () => {
    render();
    click(button("Desktop + MewMuze"));
    const consent = host.querySelector(".pm-consent")!;
    expect(consent).not.toBeNull();
    expect(consent.textContent?.toLowerCase()).toContain("on my screen");
    expect(button("Save").disabled).toBe(true);
    expect(button("Copy Image").disabled).toBe(true);

    // A real click, not a poked `.checked`: React tracks the DOM value and
    // ignores a change event whose value it believes it already knows about.
    click(host.querySelector<HTMLInputElement>(".pm-consent input")!);
    expect(button("Save").disabled).toBe(false);
  });

  it("forgets consent the moment the capture changes, so it is never reused", () => {
    render();
    click(button("Desktop + MewMuze"));
    click(host.querySelector<HTMLInputElement>(".pm-consent input")!);
    expect(button("Save").disabled).toBe(false);

    click(button("Cat only"));
    click(button("Desktop + MewMuze"));
    expect(host.querySelector<HTMLInputElement>(".pm-consent input")!.checked).toBe(false);
    expect(button("Save").disabled).toBe(true);
  });

  it("offers Save and Copy Image, and no upload or social button", () => {
    render();
    const labels = Array.from(host.querySelectorAll("button")).map((b) => b.textContent?.trim());
    expect(labels).toContain("Save");
    expect(labels).toContain("Copy Image");
    for (const forbidden of ["Post", "Upload", "Tweet", "Share to", "Sign in"]) {
      expect(labels.some((l) => l?.includes(forbidden)), forbidden).toBe(false);
    }
    // The hashtag is a suggestion in text, not a button that posts anything.
    expect(host.querySelector(".pm-share")?.textContent).toContain("#MyMewMuze");
  });

  it("cannot open a folder before anything has been saved", () => {
    render();
    expect(button("Open folder").disabled).toBe(true);
  });

  it("asks where to save until a folder is remembered", () => {
    render({ folder: "" });
    expect(button("Choose folder")).toBeDefined();
    act(() => root.unmount());
    root = createRoot(host);
    render({ folder: "D:\\Pictures" });
    expect(button("Change folder")).toBeDefined();
  });

  it("Esc closes it", () => {
    const { onClose } = render();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves no key listener behind on unmount", () => {
    const { onClose } = render();
    act(() => root.unmount());
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(0);
    root = createRoot(host); // keep the shared afterEach unmount valid
  });
});

describe("right-click menu", () => {
  let host: HTMLDivElement;
  let root: Root;
  reactEnv();

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function renderMenu(onCommand = vi.fn()) {
    act(() => {
      root.render(
        <CatContextMenu
          state={{ x: 10, y: 10 }}
          workMode={false}
          session={null}
          clipboardEnabled
          onCommand={onCommand}
          onClose={() => undefined}
        />,
      );
    });
    return onCommand;
  }

  it("gains Photo Mode without losing any existing item", () => {
    renderMenu();
    // The redesign grouped the menu into submenus; every earlier action must
    // still be reachable somewhere in it.
    const text = allMenuLabels(host).join("|");
    expect(text).toContain("Photo Mode");
    for (const existing of [
      "Work Mode",
      "Start focusing",
      "Take a break",
      "Set a reminder",
      "Add a note",
      "Calculator & time",
      "Settings",
      "Quit MewMuze",
    ]) {
      expect(text, `menu lost "${existing}"`).toContain(existing);
    }
  });

  it("the Photo Mode entry issues the photo-mode command", () => {
    const onCommand = renderMenu();
    const item = Array.from(host.querySelectorAll(".cat-menu-item")).find((i) =>
      i.textContent?.includes("Photo Mode"),
    )!;
    act(() => item.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onCommand).toHaveBeenCalledWith("photo-mode");
  });
});

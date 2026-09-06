import { describe, it, expect } from "vitest";
import {
  CAPTURE_MODES,
  DEFAULT_CAPTURE_MODE,
  DEFAULT_EXPRESSION_ID,
  DEFAULT_POSE_ID,
  PHOTO_EXPRESSIONS,
  PHOTO_POSES,
  cardLayout,
  captureMode,
  exportScale,
  findExpression,
  findPose,
  isBranded,
  needsScreenConsent,
  photoFileName,
} from "../photo/photoMode";
import { ANIMATIONS } from "../animation/animationDefinitions";
import { ART } from "../animation/spriteLoader";
import { DEFAULT_SETTINGS } from "../settings/defaultSettings";
import { sanitizeSettings } from "../settings/settingsStore";

describe("what can be photographed", () => {
  it("offers the nine advertised poses", () => {
    expect(PHOTO_POSES.map((p) => p.label)).toEqual([
      "Sit",
      "Happy",
      "Wave",
      "Sleep",
      "Stretch",
      "Curious",
      "Celebration",
      "Groom",
      "Peek",
    ]);
  });

  it("every pose is a real MewMuze animation, not a photo-only invention", () => {
    for (const pose of PHOTO_POSES) {
      expect(ANIMATIONS[pose.anim], `${pose.label} -> ${pose.anim}`).toBeDefined();
    }
  });

  it("no two poses are the same animation wearing different labels", () => {
    const anims = PHOTO_POSES.map((p) => p.anim);
    expect(new Set(anims).size).toBe(anims.length);
  });

  it("the default expression changes nothing, so a pose keeps its own face", () => {
    const preset = findExpression(DEFAULT_EXPRESSION_ID);
    expect(preset.eyes).toBeNull();
    expect(preset.mouth).toBeNull();
  });

  it("every other expression actually overrides something", () => {
    for (const e of PHOTO_EXPRESSIONS.filter((x) => x.id !== DEFAULT_EXPRESSION_ID)) {
      expect(e.eyes !== null || e.mouth !== null, e.label).toBe(true);
    }
  });

  it("falls back to the first entry rather than throwing on an unknown id", () => {
    expect(findPose("no-such-pose")).toBe(PHOTO_POSES[0]);
    expect(findExpression("no-such-face")).toBe(PHOTO_EXPRESSIONS[0]);
    expect(captureMode("nope" as never)).toBe(CAPTURE_MODES[0]);
  });

  it("the default pose and expression exist", () => {
    expect(PHOTO_POSES.some((p) => p.id === DEFAULT_POSE_ID)).toBe(true);
    expect(PHOTO_EXPRESSIONS.some((e) => e.id === DEFAULT_EXPRESSION_ID)).toBe(true);
  });
});

describe("privacy", () => {
  it("the default capture cannot contain anything but the cat", () => {
    const preset = captureMode(DEFAULT_CAPTURE_MODE);
    expect(preset.id).toBe("cat");
    expect(preset.capturesScreen).toBe(false);
    expect(preset.branded).toBe(false);
  });

  it("only the desktop mode reads the screen, and it always needs consent", () => {
    for (const mode of CAPTURE_MODES) {
      expect(needsScreenConsent(mode.id), mode.label).toBe(mode.capturesScreen);
      expect(mode.capturesScreen, mode.label).toBe(mode.id === "desktop");
    }
  });

  it("the desktop option says in plain words what will be in the image", () => {
    const desktop = captureMode("desktop");
    expect(desktop.detail.toLowerCase()).toContain("screen");
  });

  it("the transparent export is never watermarked", () => {
    // The brand footer is the one thing that would make a Cat Only PNG
    // unusable as a sticker, so this is asserted rather than assumed.
    expect(isBranded("cat")).toBe(false);
    expect(cardLayout(512, false).footerY).toBeNull();
  });

  it("only the card is branded", () => {
    expect(CAPTURE_MODES.filter((m) => m.branded).map((m) => m.id)).toEqual(["card"]);
  });
});

describe("file naming", () => {
  it("uses the documented MewMuze-YYYY-MM-DD-HHMMSS.png shape", () => {
    expect(photoFileName(new Date(2026, 8, 5, 14, 3, 9))).toBe("MewMuze-2026-09-05-140309.png");
  });

  it("pads every field, so names sort chronologically as text", () => {
    const early = photoFileName(new Date(2026, 0, 2, 3, 4, 5));
    const later = photoFileName(new Date(2026, 0, 2, 13, 4, 5));
    expect(early).toBe("MewMuze-2026-01-02-030405.png");
    expect([later, early].sort()).toEqual([early, later]);
  });

  it("uses local time, not UTC — a 9pm photo is not filed under tomorrow", () => {
    const at = new Date(2026, 8, 5, 21, 30, 0);
    expect(photoFileName(at)).toContain(`-${2026}-09-05-2130`);
  });
});

describe("export quality", () => {
  it("scales by a whole number, which is what keeps pixel art crisp", () => {
    for (const target of [1024, 1000, 900, 513, 200, 129]) {
      const scale = exportScale(ART, target);
      expect(Number.isInteger(scale), `target ${target}`).toBe(true);
      expect(scale, `target ${target}`).toBeGreaterThanOrEqual(1);
      // Never larger than asked for; a fractional remainder is dropped rather
      // than rounded up into a blurry resample.
      expect(ART * scale, `target ${target}`).toBeLessThanOrEqual(Math.max(target, ART));
    }
  });

  it("blows the 128px sprite up to 1024 for a normal export", () => {
    expect(exportScale(128, 1024)).toBe(8);
    expect(128 * exportScale(128, 1024)).toBe(1024);
  });

  it("never shrinks the art, even for a nonsense target", () => {
    expect(exportScale(ART, 1)).toBe(1);
    expect(exportScale(ART, 0)).toBe(1);
    expect(exportScale(ART, Number.NaN)).toBe(1);
    expect(exportScale(0, 1024)).toBe(1);
  });

  it("the card is laid out on whole pixels, so no seam falls mid-sprite", () => {
    const layout = cardLayout(1024, true);
    for (const [name, value] of Object.entries({
      width: layout.width,
      height: layout.height,
      x: layout.cat.x,
      y: layout.cat.y,
      size: layout.cat.size,
      pad: layout.pad,
      footerY: layout.footerY ?? 0,
    })) {
      expect(Number.isInteger(value), name).toBe(true);
    }
  });

  it("the card always has room for the cat plus its padding", () => {
    const layout = cardLayout(1024, true);
    expect(layout.width).toBe(layout.cat.size + layout.pad * 2);
    expect(layout.height).toBeGreaterThan(layout.width); // the footer strip
    expect(layout.footerY!).toBeGreaterThan(layout.cat.y + layout.cat.size);
  });
});

describe("settings stay backward compatible", () => {
  it("a settings.json written before Photo Mode still loads", () => {
    // Exactly what an existing Pro install has on disk: no photoFolder key.
    const old = { ...DEFAULT_SETTINGS, userName: "Spandy", uiTheme: "light" } as Record<string, unknown>;
    delete old.photoFolder;
    const loaded = sanitizeSettings(old);
    expect(loaded.photoFolder).toBe("");
    // ...and nothing else was disturbed on the way through.
    expect(loaded.userName).toBe("Spandy");
    expect(loaded.uiTheme).toBe("light");
  });

  it("keeps a folder the user chose, and rejects a non-string", () => {
    expect(sanitizeSettings({ photoFolder: "D:\\Pictures\\MewMuze" }).photoFolder).toBe(
      "D:\\Pictures\\MewMuze",
    );
    expect(sanitizeSettings({ photoFolder: 42 }).photoFolder).toBe("");
  });

  it("defaults to asking where to save", () => {
    expect(DEFAULT_SETTINGS.photoFolder).toBe("");
  });
});

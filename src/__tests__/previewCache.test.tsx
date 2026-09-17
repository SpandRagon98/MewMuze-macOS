import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSpriteCache, DEFAULT_POSE, previewKey, renderFramePreview, spriteCacheSize } from "../animation/spriteLoader";
import { cachedPreview, CatPreview, previewCacheLimit, previewCacheSize } from "../components/CatPreview";
// @ts-expect-error ?raw has no ambient type without vite/client in `types`.
import catPreviewRaw from "../components/CatPreview.tsx?raw";
// @ts-expect-error ?raw has no ambient type without vite/client in `types`.
import looksRaw from "../components/FeaturedLooks.tsx?raw";

const catPreviewSrc: string = catPreviewRaw;
const looksSrc: string = looksRaw;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  clearSpriteCache();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

/**
 * Settings, Cat & Looks and the chat header preview the cat with big frames.
 * Those used to live in the live cat's 192-frame cache, where eye tracking and
 * tail phases evicted them within a minute - so every Settings open repainted
 * them (~0.5 s of canvas work measured in the real app) and pushed the live
 * cat's own frames out as well.
 */
describe("preview frames", () => {
  it("never touch the live cat's sprite cache", () => {
    for (const eyes of ["open", "half", "closed"] as const) renderFramePreview({ ...DEFAULT_POSE, eyes }, 200);
    expect(spriteCacheSize()).toBe(0);
    // And the preview surfaces really use that path (jsdom cannot draw them).
    expect(catPreviewSrc).toContain("renderFramePreview(pose, px)");
    expect(catPreviewSrc).not.toMatch(/[^.\w]renderFrame\(/);
    expect(looksSrc).toContain("cachedPreview(");
    act(() => root.render(<CatPreview sizePx={200} />));
    act(() => void vi.advanceTimersByTime(1000));
    expect(spriteCacheSize()).toBe(0);
  });

  it("are reused on the next open instead of repainted", () => {
    const make = vi.fn(() => renderFramePreview(DEFAULT_POSE, 150));
    const key = `test|${previewKey(DEFAULT_POSE, 150)}`;
    const a = cachedPreview(key, make);
    const b = cachedPreview(key, make);
    expect(b).toBe(a);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it("stay bounded however many poses are shown", () => {
    for (let i = 0; i < previewCacheLimit() * 3; i++) {
      cachedPreview(`bound|${i}`, () => document.createElement("canvas"));
    }
    expect(previewCacheSize()).toBeLessThanOrEqual(previewCacheLimit());
  });

  it("key on size and appearance, so a changed look is never served stale", () => {
    expect(previewKey(DEFAULT_POSE, 150)).not.toBe(previewKey(DEFAULT_POSE, 200));
    expect(previewKey(DEFAULT_POSE, 150)).not.toBe(previewKey({ ...DEFAULT_POSE, eyes: "closed" }, 150));
  });
});

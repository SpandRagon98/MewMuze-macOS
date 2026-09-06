//! Turning a pose into an image.
//!
//! Everything the cat looks like comes from the existing renderer — this file
//! never draws fur. It asks for the same composed sprite the overlay draws,
//! blows it up by a whole-number factor with smoothing off, and (for the card)
//! puts a backdrop behind it.

import { ART, applyAppearanceStroke, renderFrame, type PoseSpec } from "../animation/spriteLoader";
import { composeCostumeSprite } from "../costumes/costumeOverlay";
import { BRAND_TITLE, BRAND_URL, cardLayout, exportScale, EXPORT_TARGET } from "./photoMode";

/**
 * The composed sprite for a pose: appearance, costume overlay and stroke, in
 * that order.
 *
 * This is the identical expression used by `CatRenderer.drawCatSprite` and by
 * the settings `CatPreview`. Photographing the cat through the very same call
 * is what guarantees a photo cannot drift from the cat on the desktop — there
 * is no second appearance path to keep in sync.
 */
export function photoSprite(pose: PoseSpec): HTMLCanvasElement {
  return applyAppearanceStroke(composeCostumeSprite(renderFrame(pose), pose));
}

/** Theme colours for the card, taken from the panel so it matches the app. */
export interface CardTheme {
  background: string;
  edge: string;
  ink: string;
  inkDim: string;
}

export const CARD_THEMES: Record<"dark" | "light", CardTheme> = {
  dark: { background: "#1e2126", edge: "#0e1013", ink: "#eceef4", inkDim: "#9aa0b0" },
  light: { background: "#fffaf4", edge: "#e6d5c0", ink: "#3a2e20", inkDim: "#7a6a54" },
};

function blank(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // The single most important line in this file. Left on, the browser would
  // bilinear-filter every blown-up pixel and hand back a blurred cat.
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

/**
 * Cat only, on a fully transparent background.
 *
 * The sprite is already transparent outside the silhouette, so this is a
 * straight integer-scaled blit and the alpha edges survive untouched — no
 * matting, no background fill, nothing that would leave a halo when the PNG is
 * dropped onto a coloured surface.
 */
export function composeCatOnly(sprite: HTMLCanvasElement, target = EXPORT_TARGET): HTMLCanvasElement | null {
  const scale = exportScale(ART, target);
  const size = ART * scale;
  const made = blank(size, size);
  if (!made) return null;
  made.ctx.drawImage(sprite, 0, 0, size, size);
  return made.canvas;
}

/** Cat on a simple MewMuze card, with the small branded footer. */
export function composeCard(
  sprite: HTMLCanvasElement,
  theme: CardTheme,
  target = EXPORT_TARGET,
): HTMLCanvasElement | null {
  const scale = exportScale(ART, target);
  const size = ART * scale;
  const layout = cardLayout(size, true);
  const made = blank(layout.width, layout.height);
  if (!made) return null;
  const { ctx } = made;

  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, layout.width, layout.height);
  // A hairline inset edge, the same trick the panels use to read as a physical
  // object rather than a flat rectangle.
  const inset = Math.max(1, Math.round(size / 256));
  ctx.strokeStyle = theme.edge;
  ctx.lineWidth = inset * 2;
  ctx.strokeRect(inset, inset, layout.width - inset * 2, layout.height - inset * 2);

  ctx.drawImage(sprite, layout.cat.x, layout.cat.y, layout.cat.size, layout.cat.size);

  if (layout.footerY !== null) {
    // Text is the one thing here that SHOULD be antialiased, so smoothing is
    // irrelevant to it — but the cat is already drawn by this point either way.
    const titleSize = Math.round(size * 0.062);
    const urlSize = Math.round(size * 0.042);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = theme.ink;
    ctx.font = `600 ${titleSize}px "Nunito", "Segoe UI", system-ui, sans-serif`;
    ctx.fillText(BRAND_TITLE, layout.width / 2, layout.footerY);
    ctx.fillStyle = theme.inkDim;
    ctx.font = `400 ${urlSize}px "Nunito", "Segoe UI", system-ui, sans-serif`;
    ctx.fillText(BRAND_URL, layout.width / 2, layout.footerY + Math.round(urlSize * 1.5));
  }

  return made.canvas;
}

/** Draw a screenshot and the cat's own pose is already in it — nothing to add. */
export function composeDesktop(screenshot: HTMLImageElement): HTMLCanvasElement | null {
  const made = blank(screenshot.naturalWidth, screenshot.naturalHeight);
  if (!made) return null;
  made.ctx.drawImage(screenshot, 0, 0);
  return made.canvas;
}

/** PNG bytes, ready to hand to the Rust side to write or copy. */
export async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not encode the photo.");
  return new Uint8Array(await blob.arrayBuffer());
}

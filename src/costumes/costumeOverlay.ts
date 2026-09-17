import { invoke } from "@tauri-apps/api/core";
import {
  bodyAnchors,
  headTiltPivot,
  renderFrameWith,
  setCostumePainter,
  type BodyEllipse,
  type CatView,
  type CostumePainter,
  type CostumeTraits,
  type PoseSpec,
} from "../animation/spriteLoader";

interface VisualLayerPayload {
  dataUrl: string;
  variant: string;
  /** Which body mass this piece rides: "torso", "head" or "sprite". */
  anchor: string;
  offsetX: number;
  offsetY: number;
  scale: number;
  opacity: number;
}

/** Where the artist assumed the body was, in the costume's design space. */
interface CostumeAnchorSpec {
  space: string;
  designSize: number;
  /** Cap on how far the garment may be stretched out of proportion. */
  maxAspect?: number;
  torso: Record<string, BodyEllipse>;
  head: Record<string, BodyEllipse>;
}

interface CostumeVisualsPayload {
  costumeId: string;
  supportedBodies: string[];
  /** Every layer for a view, in manifest order - a costume is often several
   *  garments at once, so this is a list rather than one entry per variant. */
  views: Record<string, VisualLayerPayload[]>;
  anchor: CostumeAnchorSpec | null;
}

interface LoadedLayer extends Omit<VisualLayerPayload, "dataUrl"> {
  image: HTMLImageElement;
}

type ArmorVariant = "base" | "maskOpen" | "eyeGlow";

import { corporatePainter, resolveCorporateColour, CORPORATE_CAT_ID, CORPORATE_TRAITS } from "./corporateCat";
import { cyberpunkPainter, resolveCyberpunkColour, CYBERPUNK_CAT_ID, CYBERPUNK_TRAITS } from "./cyberpunkCat";
import { batCatPainter, resolveBatcatColour, BATCAT_ID, BATCAT_TRAITS } from "./batCat";

/** What each costume covers, as the costume declares it (packaged costumes: nothing yet). */
const TRAITS: Record<string, CostumeTraits> = {
  [CORPORATE_CAT_ID]: CORPORATE_TRAITS,
  [CYBERPUNK_CAT_ID]: CYBERPUNK_TRAITS,
  [BATCAT_ID]: BATCAT_TRAITS,
};

export function costumeTraits(costumeId: string): CostumeTraits {
  return TRAITS[costumeId] ?? {};
}

/**
 * Costumes drawn INSIDE the sprite instead of composited over the finished
 * frame.
 *
 * One table, because every id here has to be known in two places at once: the
 * painter that draws it, and the fact that `composeCostumeSprite` must NOT
 * then paste the package's own PNG layers on top of what that painter drew.
 * Naming the ids separately in both places is exactly how the Cyberpunk cat
 * ended up wearing two jackets, the second one over the paws and props the
 * first had carefully stayed behind.
 *
 * `tint` is the customer's chosen colour; costumes that do not offer one
 * ignore it. The returned key goes straight into the sprite cache key, so it
 * must change whenever the drawing would.
 */
const PROCEDURAL: Record<string, (tint: string) => { painter: CostumePainter; key: string }> = {
  [CORPORATE_CAT_ID]: (tint) => {
    const colour = resolveCorporateColour(tint);
    return { painter: corporatePainter(colour), key: `${CORPORATE_CAT_ID}:${colour}` };
  },
  [CYBERPUNK_CAT_ID]: (tint) => {
    const colour = resolveCyberpunkColour(tint);
    return { painter: cyberpunkPainter(colour), key: `${CYBERPUNK_CAT_ID}:${colour}` };
  },
  [BATCAT_ID]: (tint) => {
    const colour = resolveBatcatColour(tint);
    return { painter: batCatPainter(colour), key: `${BATCAT_ID}:${colour}` };
  },
};

const IRON_MAN_CAT_ID = "mewmuze.iron-man-cat.v1";
const DESIGN_SIZE = 48;
const ARMOR = {
  outline: "#32171c",
  deep: "#5b181f",
  red: "#ab2626",
  redLight: "#d04432",
  gold: "#efb137",
  goldLight: "#ffda67",
  cyan: "#63e7ff",
  white: "#efffff",
};

let activeCostumeId = "";
let activeViews = new Map<string, LoadedLayer[]>();
let activeAnchor: CostumeAnchorSpec | null = null;
let overlayEpochValue = 0;
let composites = new WeakMap<object, Map<string, HTMLCanvasElement>>();

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The costume image could not be decoded."));
    image.src = source;
  });
}

/**
 * Colour for costumes that offer one. Held here rather than passed through
 * every call site: the overlay is what decides which painter is live, so it is
 * also the thing that has to know which colour that painter was built for.
 */
let activeTint = "";

/** Set the tint BEFORE activating, so the painter is built with it. */
export function setCostumeTint(hex: string): void {
  activeTint = hex;
}

export async function activateCostumeOverlay(costumeId: string): Promise<string[]> {
  if (!costumeId) {
    activeCostumeId = "";
    activeViews = new Map();
    activeAnchor = null;
    setCostumePainter(null, "");
    composites = new WeakMap();
    overlayEpochValue += 1;
    return [];
  }
  const payload = await invoke<CostumeVisualsPayload>("get_costume_visuals", { costumeId });
  const loaded = new Map<string, LoadedLayer[]>();
  await Promise.all(
    Object.entries(payload.views).map(async ([view, layers]) => {
      // Manifest order is draw order, so the images are awaited together but
      // written back by index: a blazer must not end up on top of its lapels
      // because one PNG happened to decode first.
      const decoded = await Promise.all(
        layers.map(async (layer) => ({
          image: await loadImage(layer.dataUrl),
          variant: layer.variant,
          anchor: layer.anchor,
          offsetX: layer.offsetX,
          offsetY: layer.offsetY,
          scale: layer.scale,
          opacity: layer.opacity,
        })),
      );
      loaded.set(view, decoded);
    }),
  );
  activeCostumeId = payload.costumeId;
  activeViews = loaded;
  activeAnchor = payload.anchor;
  // Procedural costumes paint inside the sprite; everything else is composited
  // over the finished frame by composeCostumeSprite below. The cache key
  // carries the colour as well as the costume: renderFrame caches by pose, so
  // a colour change with an unchanged key would leave every already-drawn
  // frame in the old colour.
  const procedural = PROCEDURAL[payload.costumeId];
  if (procedural) {
    const { painter, key } = procedural(activeTint);
    setCostumePainter(painter, key);
  } else {
    setCostumePainter(null, payload.costumeId);
  }
  composites = new WeakMap();
  overlayEpochValue += 1;
  return payload.supportedBodies;
}

const previewPainters = new Map<string, CostumePainter>();

/**
 * A procedural costume on the cat as it looks right now, for a preview card.
 * Leaves the costume the cat is actually wearing untouched.
 */
export function previewCostumeFrame(costumeId: string, tint: string, pose: PoseSpec, size?: number): HTMLCanvasElement {
  const make = PROCEDURAL[costumeId];
  if (!make) return renderFrameWith(pose, null, size);
  const key = `${costumeId}:${tint}`;
  let painter = previewPainters.get(key);
  if (!painter) {
    painter = make(tint).painter;
    previewPainters.set(key, painter);
  }
  return renderFrameWith(pose, painter, size);
}

export function costumeOverlayEpoch(): number {
  return overlayEpochValue;
}

export function activeCostume(): string {
  return activeCostumeId;
}

export function activeCostumeTraits(): CostumeTraits {
  return costumeTraits(activeCostumeId);
}

function variantAt(now: number, layers: LoadedLayer[]): ArmorVariant {
  const has = (v: string) => layers.some((l) => l.variant === v);
  const maskOpen = has("maskOpen") && now % 10_000 >= 7_600;
  const eyeGlow = !maskOpen && has("eyeGlow") && now % 4_700 >= 3_950;
  return maskOpen ? "maskOpen" : eyeGlow ? "eyeGlow" : "base";
}

/**
 * Draw one layer onto the sprite, mapped from where the artist assumed the body
 * was to where it actually is this frame.
 *
 * The whole point of the anchor system: the torso travels from (17.5, 34.5)
 * with a half-height of 7.0 when standing to (19, 40) with 4.2 when lying, and
 * a chonk's is 1.3x wider again. Rather than ask an artist for a drawing per
 * pose per species, the art is drawn once against a reference body and squeezed
 * onto the real one.
 */
function drawAnchored(
  ctx: CanvasRenderingContext2D,
  layer: LoadedLayer,
  pose: PoseSpec,
  size: number,
): void {
  const reference =
    activeAnchor && (layer.anchor === "torso" || layer.anchor === "head")
      ? (layer.anchor === "torso" ? activeAnchor.torso : activeAnchor.head)[pose.view] ??
        (layer.anchor === "torso" ? activeAnchor.torso : activeAnchor.head).front
      : undefined;

  ctx.save();
  ctx.globalAlpha = layer.opacity;

  if (!reference || reference.rx <= 0 || reference.ry <= 0) {
    // "sprite" anchoring, or a costume with no anchor data: the pre-anchor
    // behaviour, centred on the frame. Every schema-1 package lands here.
    const width = size * layer.scale;
    const height = size * layer.scale;
    ctx.drawImage(
      layer.image,
      (size - width) / 2 + layer.offsetX,
      (size - height) / 2 + layer.offsetY,
      width,
      height,
    );
    ctx.restore();
    return;
  }

  const design = activeAnchor?.designSize || 48;
  const unit = size / design;
  const live = bodyAnchors(pose);
  const target: BodyEllipse = layer.anchor === "torso" ? live.torso : live.head;

  // Map the reference ellipse onto the live one. Following the torso's position
  // and overall size is what makes a garment look worn; following its exact
  // aspect is what makes it look broken - a lying cat's torso is 12.5 x 4.2
  // against a standing 9.6 x 7.0, which squashes a jacket into a slab. So the
  // anisotropy is bounded around the uniform scale that preserves area.
  let sx = target.rx / reference.rx;
  let sy = target.ry / reference.ry;
  const limit = activeAnchor?.maxAspect ?? 1.15;
  if (limit > 1 && sx > 0 && sy > 0) {
    const uniform = Math.sqrt(sx * sy);
    sx = Math.min(Math.max(sx, uniform / limit), uniform * limit);
    sy = Math.min(Math.max(sy, uniform / limit), uniform * limit);
  }

  // A hat or helmet tilts with the head it sits on, about the same neck pivot.
  const pivot = layer.anchor === "head" ? headTiltPivot(pose) : null;
  if (pivot) {
    ctx.translate(pivot.x * unit, pivot.y * unit);
    ctx.rotate((pose.headTilt * Math.PI) / 180);
    ctx.translate(-pivot.x * unit, -pivot.y * unit);
  }
  ctx.translate((target.x + layer.offsetX) * unit, (target.y + layer.offsetY) * unit);
  ctx.scale(sx * layer.scale, sy * layer.scale);
  ctx.translate(-reference.x * unit, -reference.y * unit);
  ctx.drawImage(layer.image, 0, 0, size, size);
  ctx.restore();
}

/**
 * Included in the renderer signature so a motionless cat still opens its mask
 * and pulses the helmet eyes at the intended moments.
 */
export function costumeOverlayFrame(now = performance.now()): string {
  if (!activeCostumeId) return "";
  const layers = activeViews.get("front") ?? activeViews.get("all");
  if (!layers) return "";
  return variantAt(now, layers);
}

function polygon(
  ctx: CanvasRenderingContext2D,
  points: Array<[number, number]>,
  fill: string,
  stroke = ARMOR.outline,
  width = 1,
): void {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.stroke();
}

function ellipse(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  fill: string,
  stroke = ARMOR.outline,
  width = 1,
): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.stroke();
}

function armorLine(
  ctx: CanvasRenderingContext2D,
  points: Array<[number, number]>,
  color: string,
  width: number,
): void {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1]);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function armoredTail(
  ctx: CanvasRenderingContext2D,
  start: [number, number],
  control: [number, number],
  end: [number, number],
): void {
  const trace = (color: string, width: number) => {
    ctx.beginPath();
    ctx.moveTo(start[0], start[1]);
    ctx.quadraticCurveTo(control[0], control[1], end[0], end[1]);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  trace(ARMOR.outline, 5.2);
  trace(ARMOR.red, 3.7);
  for (const t of [0.22, 0.44, 0.66, 0.86]) {
    const u = 1 - t;
    const x = u * u * start[0] + 2 * u * t * control[0] + t * t * end[0];
    const y = u * u * start[1] + 2 * u * t * control[1] + t * t * end[1];
    ellipse(ctx, x, y, 0.78, 1.25, ARMOR.gold, ARMOR.outline, 0.45);
  }
}

function drawFrontTailArmor(ctx: CanvasRenderingContext2D, pose: PoseSpec, bodyX: number): void {
  if (pose.view === "threeQuarter") {
    armoredTail(ctx, [16, 39], [7.5, 38], [9.5, 24]);
    return;
  }
  if (pose.body === "dangle" || pose.body === "hang") {
    armoredTail(ctx, [17.5, 36], [10, 39], [11.5, 26]);
  } else if (pose.tail === "wrap" || pose.tail === "tuck") {
    armoredTail(ctx, [bodyX + 7, 40], [38.5, 45.5], [16.5, 44.4]);
  } else if (pose.tail === "down") {
    armoredTail(ctx, [bodyX + 7.5, 39], [37, 43], [40, 40]);
  } else {
    armoredTail(ctx, [bodyX + 7.5, 39], [41.5, 34], [38.5, 21.5]);
  }
}

function eyeSlits(
  ctx: CanvasRenderingContext2D,
  left: Array<[number, number]>,
  right: Array<[number, number]> | null,
  glow: boolean,
): void {
  ctx.save();
  if (glow) {
    ctx.shadowColor = ARMOR.cyan;
    ctx.shadowBlur = 3;
  }
  armorLine(ctx, left, glow ? ARMOR.white : ARMOR.cyan, glow ? 1.55 : 1.05);
  if (right) armorLine(ctx, right, glow ? ARMOR.white : ARMOR.cyan, glow ? 1.55 : 1.05);
  ctx.restore();
}

function drawFrontHelmet(
  ctx: CanvasRenderingContext2D,
  hx: number,
  hy: number,
  variant: ArmorVariant,
  threeQuarter: boolean,
): void {
  const lean = threeQuarter ? 0.8 : 0;
  // Ear caps keep the feline silhouette and the user's original ear tips visible.
  polygon(ctx, [[hx - 10.2, hy - 5.3], [hx - 8.3, hy - 11], [hx - 5.9, hy - 6.6], [hx - 7.1, hy - 3.5]], ARMOR.red);
  polygon(ctx, [[hx + 6.5, hy - 6.5], [hx + 8.5, hy - 11], [hx + 10.3, hy - 5.1], [hx + 7.2, hy - 3.5]], ARMOR.red);

  if (variant === "maskOpen") {
    // The faceplate hinges above the forehead; no pixel covers the cat's eyes,
    // nose, mouth, fur pattern, or eyelashes while it is open.
    polygon(
      ctx,
      [
        [hx - 7.8, hy - 10.2],
        [hx - 5.8, hy - 13.5],
        [hx + 5.6, hy - 13.5],
        [hx + 8.2, hy - 10.1],
        [hx + 6.1, hy - 7.7],
        [hx - 6, hy - 7.7],
      ],
      ARMOR.gold,
    );
    polygon(ctx, [[hx - 6, hy - 13.2], [hx + 5.7, hy - 13.2], [hx + 4.2, hy - 10.4], [hx - 4.5, hy - 10.4]], ARMOR.red);
    ellipse(ctx, hx - 10.1, hy + 0.5, 1.65, 4.8, ARMOR.deep);
    ellipse(ctx, hx + 10.1, hy + 0.5, 1.65, 4.8, ARMOR.deep);
    return;
  }

  // A fitted central mask leaves a narrow fur/cheek rim visible, so the armor
  // reads as something this exact cat is wearing rather than a replacement cat.
  polygon(
    ctx,
    [
      [hx - 8.8, hy - 7.6],
      [hx - 5.6, hy - 10],
      [hx + 5.7, hy - 10],
      [hx + 8.9, hy - 7.2],
      [hx + 8.2 + lean, hy + 5.7],
      [hx + 3.8 + lean, hy + 9],
      [hx - 3.8 + lean, hy + 9],
      [hx - 8.2, hy + 5.7],
    ],
    ARMOR.gold,
  );
  polygon(ctx, [[hx - 7, hy - 8.6], [hx + 7.1, hy - 8.6], [hx + 5.8, hy - 5.5], [hx - 5.8, hy - 5.5]], ARMOR.red);
  polygon(ctx, [[hx - 8.2, hy + 5.2], [hx - 3.8, hy + 8.8], [hx - 3.2, hy + 5.6], [hx - 6.7, hy + 3.3]], ARMOR.red);
  polygon(ctx, [[hx + 8.2, hy + 5.2], [hx + 3.8, hy + 8.8], [hx + 3.2, hy + 5.6], [hx + 6.7, hy + 3.3]], ARMOR.red);
  eyeSlits(
    ctx,
    [[hx - 6.3, hy - 0.9], [hx - 1.5, hy + 0.1]],
    [[hx + 1.5, hy + 0.1], [hx + 6.3, hy - 0.9]],
    variant === "eyeGlow",
  );
}

function frontBodyGeometry(pose: PoseSpec): { hx: number; hy: number; by: number; brx: number; bry: number } {
  const threeQuarter = pose.view === "threeQuarter";
  if (threeQuarter) {
    return {
      hx: 26.5 + pose.headTurnX * 0.95,
      hy: 16.5 + pose.headBob + pose.headTurnY * 0.62,
      by: 36,
      brx: 8.8,
      bry: 7.6,
    };
  }
  let hy = 15.5 + pose.headBob;
  let by = 34;
  let brx = 9;
  let bry = 8.8;
  if (pose.body === "loaf") {
    hy = 18 + pose.headBob;
    by = 38.5;
    brx = 12.5;
    bry = 6;
  } else if (pose.body === "dangle") {
    hy = 14 + pose.headBob;
    by = 32;
    brx = 7.6;
    bry = 8;
  } else if (pose.body === "hang") {
    hy = 20 + pose.headBob;
    by = 34;
    brx = 7.6;
    bry = 8.2;
  }
  return {
    hx: 24 + pose.headTurnX * 0.95,
    hy: hy + pose.headTurnY * 0.62,
    by,
    brx,
    bry,
  };
}

function drawFrontArmor(ctx: CanvasRenderingContext2D, pose: PoseSpec, variant: ArmorVariant): void {
  const { hx, hy, by, brx, bry } = frontBodyGeometry(pose);
  const threeQuarter = pose.view === "threeQuarter";
  const bodyX = threeQuarter ? 23 : 24;
  const half = Math.max(5.6, brx * 0.72);
  const top = by - bry * 0.72;
  const bottom = Math.min(43, by + bry * 0.72);

  // The tail gets articulated suit segments while the outer haunches and
  // cheeks retain enough original fur to keep the underlying cat recognizable.
  drawFrontTailArmor(ctx, pose, bodyX);
  polygon(
    ctx,
    [
      [bodyX - half, top + 1],
      [bodyX - half + 2, top - 1.7],
      [bodyX + half - 2, top - 1.7],
      [bodyX + half, top + 1],
      [bodyX + half - 1.1, bottom],
      [bodyX - half + 1.1, bottom],
    ],
    ARMOR.red,
  );
  polygon(ctx, [[bodyX - half + 1.5, top + 1.5], [bodyX, top - 0.5], [bodyX + half - 1.5, top + 1.5], [bodyX + 3.8, by + 3.7], [bodyX - 3.8, by + 3.7]], ARMOR.redLight);
  ellipse(ctx, bodyX, by + 0.8, 3.3, 3.3, ARMOR.gold);
  ellipse(ctx, bodyX, by + 0.8, 2, 2, ARMOR.cyan, ARMOR.white, 0.65);
  polygon(ctx, [[bodyX - half - 1.2, top + 1.4], [bodyX - half + 1.4, top - 1.5], [bodyX - half + 3.1, top + 2.2], [bodyX - half + 0.2, top + 4]], ARMOR.gold);
  polygon(ctx, [[bodyX + half + 1.2, top + 1.4], [bodyX + half - 1.4, top - 1.5], [bodyX + half - 3.1, top + 2.2], [bodyX + half - 0.2, top + 4]], ARMOR.gold);
  armorLine(ctx, [[bodyX, by + 4.2], [bodyX, bottom - 0.5]], ARMOR.gold, 1.4);

  if (pose.body === "loaf") {
    polygon(ctx, [[bodyX - 8.5, 40], [bodyX - 3.5, 39.1], [bodyX - 3, 44], [bodyX - 8.4, 44]], ARMOR.red);
    polygon(ctx, [[bodyX + 3.5, 39.1], [bodyX + 8.5, 40], [bodyX + 8.4, 44], [bodyX + 3, 44]], ARMOR.red);
  } else if (pose.body !== "hang") {
    for (const pawX of [bodyX - 4.4, bodyX + 4.4]) {
      polygon(ctx, [[pawX - 2.2, 40.5], [pawX + 2.2, 40.5], [pawX + 2.5, 44.3], [pawX - 2.5, 44.3]], ARMOR.red);
      armorLine(ctx, [[pawX - 2, 43.4], [pawX + 2, 43.4]], ARMOR.goldLight, 1.25);
    }
  }
  drawFrontHelmet(ctx, hx, hy, variant, threeQuarter);
}

function sideGeometry(pose: PoseSpec): { bx: number; by: number; brx: number; bry: number; hx: number; hy: number; hrx: number; hry: number } {
  const gait = Math.sin(pose.legPhase * Math.PI * 2);
  let bx = 17.5;
  let by = 34.5 - Math.max(0, gait) * 0.6;
  let brx = 9.6;
  let bry = 7;
  let hx = 31;
  let hy = 21.5 + pose.headBob - Math.max(0, gait) * 0.4;
  let hrx = 10.2;
  let hry = 9.6;
  if (pose.body === "crouch") ({ bx, by, brx, bry, hx, hy } = { bx: 17.5, by: 37, brx: 11, bry: 5.4, hx: 32, hy: 24 + pose.headBob });
  if (pose.body === "air") ({ bx, by, brx, bry, hx, hy } = { bx: 16.5, by: 31, brx: 11, bry: 5.8, hx: 33, hy: 19 + pose.headBob });
  if (pose.body === "lie") ({ bx, by, brx, bry, hx, hy, hrx, hry } = { bx: 19, by: 40, brx: 12.5, bry: 4.2, hx: 33, hy: 32 + pose.headBob, hrx: 9, hry: 8.4 });
  if (pose.body === "sit") ({ bx, by, brx, bry, hx, hy } = { bx: 20.5, by: 34.5, brx: 8.3, bry: 9.2, hx: 27.5, hy: 20 + pose.headBob });
  if (pose.body === "stretch") {
    const reach = Math.max(0, Math.min(1, pose.legPhase));
    bx = 15 + reach * 1.5;
    by = 32.5 - reach * 1.5;
    brx = 11.5;
    bry = 5.8;
    hx = 33 + reach * 2;
    hy = 30 + reach * 5 + pose.headBob;
  }
  hx += pose.headTurnX * 0.95;
  hy += pose.headTurnY * 0.62;
  return { bx, by, brx, bry, hx, hy, hrx, hry };
}

function drawSideHelmet(
  ctx: CanvasRenderingContext2D,
  hx: number,
  hy: number,
  hrx: number,
  hry: number,
  variant: ArmorVariant,
): void {
  polygon(ctx, [[hx - 5.5, hy - hry + 3], [hx - 3.8, hy - hry - 2], [hx - 1.2, hy - hry + 3.2]], ARMOR.red);
  polygon(ctx, [[hx + 1.4, hy - hry + 2.6], [hx + 4.2, hy - hry - 2], [hx + 5.5, hy - hry + 3.5]], ARMOR.red);
  if (variant === "maskOpen") {
    polygon(ctx, [[hx - 4.8, hy - hry - 0.5], [hx + 4.8, hy - hry - 0.5], [hx + 7, hy - hry + 3], [hx - 3.3, hy - hry + 3.2]], ARMOR.gold);
    polygon(ctx, [[hx - 3.5, hy - hry], [hx + 3.8, hy - hry], [hx + 4.8, hy - hry + 1.4], [hx - 2.8, hy - hry + 1.5]], ARMOR.red);
    ellipse(ctx, hx - hrx + 1.2, hy + 0.8, 1.4, 4.4, ARMOR.deep);
    return;
  }
  polygon(
    ctx,
    [[hx - 5.5, hy - 6.7], [hx + 3.5, hy - 7.8], [hx + 8.1, hy - 3], [hx + 7.1, hy + 5.2], [hx + 3.4, hy + 8], [hx - 4.4, hy + 5.7]],
    ARMOR.gold,
  );
  polygon(ctx, [[hx - 3.8, hy - 7.2], [hx + 3.8, hy - 7], [hx + 5.4, hy - 4.5], [hx - 2.8, hy - 4.4]], ARMOR.red);
  polygon(ctx, [[hx + 6.9, hy + 4.8], [hx + 3.2, hy + 7.8], [hx + 1.9, hy + 4.8], [hx + 5.5, hy + 2.7]], ARMOR.red);
  eyeSlits(ctx, [[hx + 0.4, hy - 1.1], [hx + 6.2, hy - 0.5]], null, variant === "eyeGlow");
}

function drawSideArmor(ctx: CanvasRenderingContext2D, pose: PoseSpec, variant: ArmorVariant): void {
  const { bx, by, brx, bry, hx, hy, hrx, hry } = sideGeometry(pose);
  if (pose.body === "lie" && pose.eyes === "closed") {
    polygon(ctx, [[17, 33], [25, 30.5], [36.5, 34], [36, 41.8], [23, 43.2], [16, 39.5]], ARMOR.red);
    ellipse(ctx, 27.5, 36.7, 3.1, 3.1, ARMOR.gold);
    ellipse(ctx, 27.5, 36.7, 1.8, 1.8, ARMOR.cyan, ARMOR.white, 0.65);
    drawSideHelmet(ctx, 16, 36.5 + pose.headBob * 0.45, 7.5, 6.5, variant);
    return;
  }
  const tailRoot: [number, number] = [bx - brx + 2.5, by - 2];
  if (pose.tail === "down") {
    armoredTail(ctx, tailRoot, [tailRoot[0] - 6, tailRoot[1] + 7], [tailRoot[0] - 10, 41]);
  } else if (pose.tail === "flick") {
    armoredTail(ctx, tailRoot, [tailRoot[0] - 9, tailRoot[1] - 6], [tailRoot[0] - 9.5, 15]);
  } else {
    armoredTail(ctx, tailRoot, [tailRoot[0] - 8.5, tailRoot[1] - 9], [tailRoot[0] - 2.5, 12.5]);
  }
  const left = bx - brx * 0.7;
  const right = bx + brx * 0.82;
  const top = by - bry * 0.72;
  const bottom = Math.min(43, by + bry * 0.72);
  polygon(ctx, [[left, top + 1], [bx - 2, top - 1.4], [right - 1, top], [right + 1, by], [right - 1.5, bottom], [left + 1, bottom]], ARMOR.red);
  polygon(ctx, [[bx - 1, top], [right - 1.4, top + 0.7], [right - 0.2, by + 3.2], [bx + 0.8, by + 2.4]], ARMOR.redLight);
  polygon(ctx, [[right - 2, top - 1.2], [right + 1.7, top + 0.5], [right + 0.5, top + 4], [right - 3, top + 2.7]], ARMOR.gold);
  ellipse(ctx, bx + 3.2, by, 2.9, 2.9, ARMOR.gold);
  ellipse(ctx, bx + 3.2, by, 1.7, 1.7, ARMOR.cyan, ARMOR.white, 0.6);
  armorLine(ctx, [[left + 1.5, bottom - 1], [right - 1.6, bottom - 1]], ARMOR.gold, 1.2);
  if (!["air", "stretch"].includes(pose.body)) {
    polygon(ctx, [[bx - 6, 40.4], [bx - 1.8, 40.4], [bx - 1.2, 44], [bx - 6.2, 44]], ARMOR.red);
    polygon(ctx, [[bx + 4, 40.3], [bx + 8.4, 40.3], [bx + 8.8, 44], [bx + 3.7, 44]], ARMOR.red);
  }
  drawSideHelmet(ctx, hx, hy, hrx, hry, variant);
}

function drawBackArmor(ctx: CanvasRenderingContext2D, pose: PoseSpec): void {
  const sway = pose.body === "climb" ? Math.sin(pose.legPhase * Math.PI * 2) * 1.4 : 0;
  const hx = 24 + sway;
  const hy = (pose.body === "climb" ? 14.5 : 15.5) + pose.headBob;
  const by = pose.body === "climb" ? 31 : 35.5;
  if (pose.body === "climb") {
    armoredTail(ctx, [24 + sway, 38], [31 + sway, 34], [30 + sway, 21]);
  } else {
    armoredTail(ctx, [28, 39], [37.5, 37], [36.5, 23]);
  }
  polygon(ctx, [[hx - 8.5, hy - 6.5], [hx - 5.8, hy - 9.2], [hx + 5.8, hy - 9.2], [hx + 8.5, hy - 6.5], [hx + 7.4, hy + 6.8], [hx - 7.4, hy + 6.8]], ARMOR.red);
  polygon(ctx, [[hx - 6.4, hy - 7.2], [hx + 6.4, hy - 7.2], [hx + 4.8, hy - 4.5], [hx - 4.8, hy - 4.5]], ARMOR.gold);
  polygon(ctx, [[hx - 7.7, by - 6], [hx - 4.5, by - 8.2], [hx + 4.5, by - 8.2], [hx + 7.7, by - 6], [hx + 6.8, by + 7], [hx - 6.8, by + 7]], ARMOR.red);
  armorLine(ctx, [[hx, by - 6.5], [hx, by + 6]], ARMOR.gold, 2.2);
  polygon(ctx, [[hx - 9, by - 5.8], [hx - 6.2, by - 8], [hx - 4.5, by - 4.7], [hx - 7.4, by - 2.9]], ARMOR.gold);
  polygon(ctx, [[hx + 9, by - 5.8], [hx + 6.2, by - 8], [hx + 4.5, by - 4.7], [hx + 7.4, by - 2.9]], ARMOR.gold);
}

export function renderIronManCatCostume(
  base: HTMLCanvasElement,
  pose: PoseSpec,
  variant: ArmorVariant,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = base.width;
  canvas.height = base.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true }); // a frame, read back by the outline pass: software
  if (!ctx) return base;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(base, 0, 0);
  ctx.save();
  const scale = canvas.width / DESIGN_SIZE;
  ctx.scale(scale, scale);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (pose.view === "side") drawSideArmor(ctx, pose, variant);
  else if (pose.view === "back") drawBackArmor(ctx, pose);
  else drawFrontArmor(ctx, pose, variant);
  ctx.restore();
  return canvas;
}

export function composeCostumeSprite(
  base: HTMLCanvasElement,
  pose: PoseSpec,
): HTMLCanvasElement {
  const view: CatView = pose.view;
  const viewLayers =
    activeViews.get(view) ??
    (view === "threeQuarter" ? activeViews.get("front") : undefined) ??
    activeViews.get("all");
  if (!viewLayers || viewLayers.length === 0) return base;
  const variant = variantAt(performance.now(), viewLayers);

  let byView = composites.get(base);
  if (!byView) {
    byView = new Map();
    composites.set(base, byView);
  }
  // Keyed by view+variant only, deliberately. The cache is a WeakMap on the
  // BASE sprite, and the base sprite is already cached per distinct pose - so
  // one base canvas implies one set of anchors, and the pose cannot vary
  // underneath a cache hit.
  const cacheKey = `${view}:${variant}`;
  const cached = byView.get(cacheKey);
  if (cached) return cached;

  if (activeCostumeId === IRON_MAN_CAT_ID) {
    const armored = renderIronManCatCostume(base, pose, variant);
    byView.set(cacheKey, armored);
    return armored;
  }

  // A procedural costume is painted INSIDE the sprite, so by the time a frame
  // reaches here it is already dressed. Compositing the package art again
  // would put a second garment on top of the paws and props the first pass
  // deliberately stayed behind.
  if (PROCEDURAL[activeCostumeId]) return base;

  // Everything for this variant, plus anything variant-less that always shows.
  const drawn = viewLayers.filter((l) => l.variant === variant || l.variant === "base");
  if (drawn.length === 0) return base;

  const canvas = document.createElement("canvas");
  canvas.width = base.width;
  canvas.height = base.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true }); // a frame, read back by the outline pass: software
  if (!ctx) return base;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(base, 0, 0);
  for (const layer of drawn) drawAnchored(ctx, layer, pose, canvas.width);
  byView.set(cacheKey, canvas);
  return canvas;
}

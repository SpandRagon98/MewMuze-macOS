/**
 * Procedural art for a chibi black cat, rasterised at 96 px native.
 *
 * Geometry is authored in a 48-unit design space and rasterised on the 96 px
 * grid (every primitive scales coordinates before per-pixel rasterisation), so
 * curves resolve smoothly — the style reads as polished high-resolution pixel
 * art / soft vector rather than chunky blocks, while edges stay crisp via
 * nearest-neighbour blitting.
 *
 * Proportions follow the cute-chibi reference: a large rounded head (~55% of
 * the height), very large expressive eyes with big glossy pupils and double
 * highlights, small triangular ears, a tiny muzzle with a default smile, a
 * compact soft body, rounded paws and a long curved tail.
 *
 * Each directional view owns its silhouette; only the side view is mirrored.
 * Appearance (fur/eye/ear colour, pattern, accessory) is configurable via
 * `configureAppearance`. Props (notebook, keyboard, book) and music notes are
 * per-pose flags used by the context-aware companion animations.
 */

/**
 * Native rasterisation size. Raised 96 -> 128 for crisper art.
 *
 * Chosen by measurement, not taste. 144 (a clean integer S=3) looked best but
 * cost 4.4ms per cache miss and dragged the render loop from 59fps to 37 and
 * animation from 39 to 31 updates/sec — it bought sharpness by spending the
 * smoothness. 128 keeps the loop at ~53fps and ~35 updates/sec, near the 96px
 * baseline, while still being 1.8x the pixels.
 */
export const ART = 128;
/** Design space is 48 units; S is the design-unit -> pixel scale. */
const S = ART / 48;

export type CatView = "side" | "front" | "back" | "threeQuarter";
export type EyeState =
  | "open"
  | "half"
  | "closed"
  | "wide"
  | "up"
  | "down"
  | "surprised"
  | "happy"
  | "focus"
  /** Blown-wide panic eyes: oversized whites, shrunken pupil. */
  | "panic"
  /** Droopy, upward-gazing sad eyes. */
  | "sad"
  /** Narrowed glare with brows slanting in — the fed-up-with-you face. */
  | "angry";

/**
 * Whole-sprite colour shift. Part of the cache key, so keep the set small.
 * `panic` adds a warm exertion flush; `sad` desaturates it slightly.
 */
export type CatTint = "none" | "panic" | "sad";
export type EarState = "up" | "back" | "perk" | "flat";
export type TailState = "curl" | "up" | "flick" | "down" | "tuck" | "puff" | "wrap";
export type BodyState = "stand" | "sit" | "crouch" | "lie" | "dangle" | "air" | "loaf" | "hang" | "climb" | "stretch";
export type Gesture =
  | "none"
  | "pawUp"
  | "swat"
  | "groom"
  | "scratch"
  | "hangTwo"
  | "hangOne"
  | "pull"
  | "peek"
  | "wiggle"
  | "knead"
  | "cheer"
  /** Both forepaws raised overhead and brought together — the alarm clap. */
  | "clap";
export type MouthState = "none" | "smile" | "open" | "yawn" | "frown" | "teeth";
export type CatProp = "none" | "notebook" | "keyboard" | "book" | "mic" | "laptop" | "placard" | "bowl" | "calculator";

export interface PoseSpec {
  view: CatView;
  body: BodyState;
  /** 0..1 phase for gait, climbing and subtle body sway. */
  legPhase: number;
  eyes: EyeState;
  ears: EarState;
  tail: TailState;
  /**
   * Quantised sway phase, 0..TAIL_PHASE_STEPS-1. The tail is never truly still:
   * the engine advances this continuously so it curls and drifts even while the
   * cat sits. Quantised (not a raw float) because it is part of the cache key.
   */
  tailPhase: number;
  /** -2..2 vertical head offset in design units. */
  headBob: number;
  /** Gait stride-length multiplier (stalk ≈0.7, walk 1, sprint ≈1.8). */
  stride: number;
  gesture: Gesture;
  /** -2..2 pupil offset in design units (cursor eye-tracking). */
  pupilX: number;
  pupilY: number;
  /**
   * -1..1 head lean toward the cursor. Deliberately a much smaller range than
   * the pupils: the eyes do most of the looking and the head only hints at it,
   * which is what keeps the head attached to the body rather than swivelling.
   */
  headTurnX: number;
  headTurnY: number;
  mouth: MouthState;
  /** Whole-coat colour shift for emotional states. */
  tint: CatTint;
  /** Tiny themed prop in front of the cat (notebook / keyboard / book). */
  prop: CatProp;
  /** Floating music notes (media reactions). */
  notes: boolean;
  blush: boolean;
  steam: boolean;
  hearts: boolean;
  zzz: boolean;
}

/**
 * Number of distinct tail sway positions.
 *
 * This trades directly against the sprite cache: the tail phase multiplies
 * every cached frame. At 12 the tail advanced a step only every ~0.38s while
 * the cat idled, which read as a jerky twitch rather than a sway — the slower
 * the motion, the MORE steps it needs to look continuous.
 *
 * The idle sway is only 0.22 cycles/sec, so the step count IS the tail's frame
 * rate. But it is also a CACHE MULTIPLIER, and the working set is the product
 * of tail x pupil x head positions — at 128 the cache sat permanently full
 * (1024/1024, 64MB) and thrashed on every machine.
 *
 * 40 keeps the sway smooth (~9 updates/sec idle, ~34 while running) while
 * letting the reduced-quality levels below actually fit inside the cache, which
 * is what makes adaptive quality do anything at all on a weak machine.
 */
export const TAIL_PHASE_STEPS = 40;

export const DEFAULT_POSE: PoseSpec = {
  view: "front",
  body: "stand",
  legPhase: 0,
  eyes: "open",
  ears: "up",
  tail: "curl",
  tailPhase: 0,
  headBob: 0,
  stride: 1,
  gesture: "none",
  pupilX: 0,
  pupilY: 0,
  headTurnX: 0,
  headTurnY: 0,
  mouth: "none",
  tint: "none",
  prop: "none",
  notes: false,
  blush: false,
  steam: false,
  hearts: false,
  zzz: false,
};

// ---- appearance / palettes ----------------------------------------------
export type CatPattern =
  | "solid"
  | "tuxedo"
  | "tabby"
  | "socks"
  | "spotted"
  | "calico"
  | "bicolour";
export type CatAccessory =
  | "none"
  | "sunglasses"
  | "headphones"
  | "glasses"
  | "bandana"
  | "watch"
  | "hat"
  | "cap"
  // Seasonal costumes (also selectable manually).
  | "santaHat"
  | "witchHat"
  | "partyHat"
  | "flowerCrown"
  | "scarf";

/** Costumes the calendar can put the cat in. */
export const SEASONAL_ACCESSORIES: CatAccessory[] = ["santaHat", "witchHat", "partyHat", "flowerCrown", "scarf"];

/**
 * Distinct cat breeds. These are NOT recolours: each one rescales the head,
 * body, legs, ears, eyes and tail, and some add real anatomy (ear tufts, a
 * neck ruff, colour-point extremities), so the silhouettes read differently
 * even in pure black.
 */
export type CatSpecies = "classic" | "chonk" | "fluffy" | "siamese" | "kitten";

export interface SpeciesTraits {
  /** Head radius multiplier. */
  head: number;
  /** Torso width / height multipliers. */
  bodyW: number;
  bodyH: number;
  /** Design-units to lower the body (shorter legs sit closer to the ground). */
  bodyDrop: number;
  /** Ear height multiplier. */
  ear: number;
  /** Eye radius multiplier. */
  eye: number;
  /** Tail thickness multiplier. */
  tail: number;
  /** Long-haired: ear tufts + cheek floof. */
  tufts: boolean;
  /** Long-haired: a chest/neck ruff. */
  ruff: boolean;
  /** Colour-point: pale torso with dark face, ears, paws and tail. */
  point: boolean;
}

export const SPECIES_TRAITS: Record<CatSpecies, SpeciesTraits> = {
  // The original chibi house cat — the balanced baseline.
  classic: { head: 1, bodyW: 1, bodyH: 1, bodyDrop: 0, ear: 1, eye: 1, tail: 1, tufts: false, ruff: false, point: false },
  // Round, stubby-legged and heavy-cheeked.
  chonk: { head: 1.04, bodyW: 1.3, bodyH: 1.12, bodyDrop: 2.4, ear: 0.82, eye: 1, tail: 1.15, tufts: false, ruff: false, point: false },
  // Long-haired: bigger overall mass, ear tufts, ruff and a plume tail.
  fluffy: { head: 1.08, bodyW: 1.18, bodyH: 1.06, bodyDrop: 0.8, ear: 0.95, eye: 1, tail: 1.55, tufts: true, ruff: true, point: false },
  // Slender and leggy with tall ears and dark points.
  siamese: { head: 0.94, bodyW: 0.86, bodyH: 0.94, bodyDrop: -1.4, ear: 1.4, eye: 1.05, tail: 0.72, tufts: false, ruff: false, point: true },
  // Tiny body, oversized head and eyes.
  kitten: { head: 1.16, bodyW: 0.8, bodyH: 0.78, bodyDrop: 3, ear: 0.88, eye: 1.14, tail: 0.78, tufts: false, ruff: false, point: false },
};

export interface CatAppearance {
  /** Base fur colour (mid tone). */
  furColor: string;
  /** Iris base colour. */
  eyeColor: string;
  /** Inner-ear colour. */
  earColor: string;
  pattern: CatPattern;
  accessory: CatAccessory;
  species: CatSpecies;
  /** Long upper lashes on the outer corner of each eye. */
  eyelashes: boolean;
  /** Draw a solid outline around the final cat silhouette. */
  stroke: boolean;
  /** Colour used by the optional silhouette outline. */
  strokeColor: string;
}

export const DEFAULT_APPEARANCE: CatAppearance = {
  furColor: "#FAFAFA",
  eyeColor: "#76df31",
  earColor: "#e06e91",
  pattern: "solid",
  accessory: "none",
  species: "classic",
  eyelashes: false,
  stroke: false,
  strokeColor: "#ffffff",
};

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
/** Blend `hex` toward `target` by `t` (0..1). */
function mixHex(hex: string, target: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(hex);
  const [r2, g2, b2] = hexToRgb(target);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

/** Multiply a colour toward black (f<1) or white (f>1). */
function shade(hex: string, f: number): string {
  const [r, g, b] = hexToRgb(hex);
  if (f <= 1) return rgbToHex(r * f, g * f, b * f);
  const t = f - 1;
  return rgbToHex(r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t);
}

// Mutable palettes, regenerated by configureAppearance().
let FUR = ["#3f3f4c", "#272730", "#17171e", "#0a0a10"];
let FAR_FUR = ["#22222b", "#111117"];
let CHEST = ["#3f3f4c", "#272730", "#17171e"];
/** Torso palette — same as FUR except for colour-point breeds (pale body). */
let BODY = FUR;
let SP: SpeciesTraits = SPECIES_TRAITS.classic;
let EYE_LIGHT = "#caff43";
let EYE_MID = "#76df31";
let EYE_DARK = "#2c8b31";
let EAR_DARK = "#8f536a";
let EAR_LIGHT = "#e06e91";
let PAW_GLEAM = "#555562";
let pattern: CatPattern = "solid";
let accessory: CatAccessory = "none";
/**
 * Marking colour, deliberately high-contrast against the coat. Markings used to
 * be drawn in FUR[0] (a ~28% lighter shade of the fur itself), which was almost
 * invisible — the whole point of a pattern is that you can see it.
 */
let MARK: string[] = ["#000000"];
/** Secondary marking colour, for multi-tone coats (calico). */
let MARK2: string[] = ["#000000"];
/** True for coats with white paws (socks/tuxedo), so paws render as boots. */
let SOCKED = false;
/** Long upper lashes on the outer corner of each eye (appearance toggle). */
let EYELASHES = false;
/** Optional outline applied after the base cat and any costume are composed. */
let STROKE_ENABLED = false;
let STROKE_COLOR = "#ffffff";
let strokeCache = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
/** Palette for those boots. Recomputed by configureAppearance. */
let SOCK: string[] = ["#e9e4d8"];

const EYE_PUPIL = "#0b1410";
const EYE_SHINE = "#ffffff";
const NOSE = "#e38aa2";
const MOUTH = "#6e5560";
const TONGUE = "#e8798f";
const WHISKER = "#8f8f9c";
const HEART = "#ff5b8a";
const ZCOL = "#9bdcff";
const BLUSH = "#d96a7e";
const STEAM = "#cfd4e0";
const CREAM = "#e9e4d8";
/** Warm ginger used for the calico coat's third tone. */
const GINGER = "#d98a3f";
const PAPER = "#f3ecd7";
const PAPER_DARK = "#c9bd97";
const INK = "#5b5244";
const PENCIL = "#e0a23c";
const MIC_BODY = "#3d4250";
const MIC_HEAD = "#c9ccd8";
const MIC_RING = "#8f94a6";

/** Motivational placard held up in both paws. */
const PLACARD_BOARD = "#f6efdb";
const PLACARD_EDGE = "#b8ac83";
const PLACARD_INK = "#5b5244";

/** Water bowl for the drink reminder. */
const BOWL_BODY = "#7fa8c9";
const BOWL_RIM = "#a9c8e0";
const BOWL_SHADE = "#5d83a3";
const WATER = "#69b7e8";
const WATER_LIGHT = "#a8dcf7";

/** Mini laptop carried by the Quick Tools pose. */
const LAPTOP_BODY = "#4a4f5e";
const LAPTOP_DARK = "#2b2f3a";
const LAPTOP_BEZEL = "#1b1e26";
const LAPTOP_SCREEN = "#16323d";
const LAPTOP_GLOW = "#9be7ff";
const LAPTOP_LINE = "#4d8fa8";
// Calc & Time: a pocket calculator, warmer and plainer than the work laptop
// so the two modes read as different tools at a glance.
const CALC_BODY = "#59606f";
const CALC_DARK = "#333844";
const CALC_LCD = "#b9d98a";
const CALC_DIGIT = "#2f3f22";
const CALC_KEY = "#8b93a5";
const CALC_KEY_HI = "#e0b25c";

const KEYS_BASE = "#3a3a46";
const KEYS_CAP = "#5d5d6e";
/** Bottomed-out keycap under a striking paw. */
const KEYS_PRESSED = "#2a2a34";
/** Keycap top bevel, impact flashes and motion trails. */
const KEYS_HILITE = "#8e8ea6";
const PHONES = "#d8455a";
const PHONES_DARK = "#5a1e28";
const GLASS_RIM = "#c9a15e";
const GLASS_GLINT = "#bcd3e8";
const SHADE_LENS = "#14161c";
const SHADE_LIGHT = "#354b67";
const SUNGLASS_RIM = "#080a0f";
const BANDANA = "#e34f62";
const BANDANA_DARK = "#7b2635";
const WATCH_STRAP = "#3c465b";
const WATCH_FACE = "#72e2eb";
const HAT = "#654329";
const HAT_DARK = "#2d2018";
const CAP = "#496fc5";
const CAP_LIGHT = "#7898e2";
// Seasonal costume palette.
const SANTA_RED = "#d8323c";
const SANTA_RED_DARK = "#8e1c25";
const SANTA_TRIM = "#f4f1ea";
const WITCH_PURPLE = "#5b3a86";
const WITCH_PURPLE_DARK = "#33204d";
const WITCH_BUCKLE = "#e8c453";
const PARTY_A = "#ff5f8f";
const PARTY_B = "#ffd84d";
const FLOWER_PINK = "#f58ab4";
const FLOWER_WHITE = "#fdf3f7";
const FLOWER_CENTRE = "#ffd84d";
const LEAF = "#5aa15e";
const SCARF = "#c2453f";
const SCARF_DARK = "#7d2723";

export function configureAppearance(a: Partial<CatAppearance>): void {
  const fur = a.furColor ?? DEFAULT_APPEARANCE.furColor;
  const eye = a.eyeColor ?? DEFAULT_APPEARANCE.eyeColor;
  const ear = a.earColor ?? DEFAULT_APPEARANCE.earColor;
  pattern = a.pattern ?? DEFAULT_APPEARANCE.pattern;
  accessory = a.accessory ?? DEFAULT_APPEARANCE.accessory;
  SP = SPECIES_TRAITS[a.species ?? DEFAULT_APPEARANCE.species] ?? SPECIES_TRAITS.classic;
  FUR = [shade(fur, 1.28), fur, shade(fur, 0.58), shade(fur, 0.3)];
  FAR_FUR = [shade(fur, 0.82), shade(fur, 0.45)];
  // Colour-point breeds keep dark extremities but wear a warmer, paler torso.
  // `shade` blends toward white, so factors must stay below ~1.7 or the body
  // blows out to flat white and stops reading as fur.
  BODY = SP.point ? [shade(fur, 1.62), shade(fur, 1.44), shade(fur, 1.16), shade(fur, 0.92)] : FUR;
  CHEST =
    pattern === "tuxedo"
      ? [shade(CREAM, 1.02), CREAM, shade(CREAM, 0.82)]
      : SP.point
        ? [shade(fur, 1.7), shade(fur, 1.52), shade(fur, 1.28)]
        : [FUR[0], FUR[1], FUR[2]];
  EYE_LIGHT = shade(eye, 1.45);
  EYE_MID = eye;
  EYE_DARK = shade(eye, 0.5);
  EAR_LIGHT = ear;
  EAR_DARK = shade(ear, 0.62);
  PAW_GLEAM = pattern === "socks" || pattern === "tuxedo" ? CREAM : shade(fur, 1.6);
  // Markings must contrast with the coat whatever colour the user picked, so
  // pick their direction from the fur's luminance: pale markings on a dark cat,
  // dark markings on a pale one.
  const [fr, fg, fb] = hexToRgb(fur);
  const luma = (0.299 * fr + 0.587 * fg + 0.114 * fb) / 255;
  MARK = luma < 0.45
    ? [shade(fur, 2.0), shade(fur, 1.75)]
    : [shade(fur, 0.42), shade(fur, 0.55)];
  // Calico's third tone: a warm ginger patch that reads against both.
  MARK2 = luma < 0.45 ? [GINGER, shade(GINGER, 0.8)] : [shade(GINGER, 0.72), shade(GINGER, 0.58)];
  // Socks/tuxedo get real white boots rather than a two-pixel highlight, which
  // was so subtle the pattern was indistinguishable from a solid coat.
  SOCKED = pattern === "socks" || pattern === "tuxedo";
  SOCK = luma < 0.5 ? [CREAM, shade(CREAM, 0.88), shade(CREAM, 0.74)] : [shade(fur, 1.9), shade(fur, 1.7), shade(fur, 1.5)];
  // The palette is baked into each rasterised frame, so appearance is part of
  // the cache key rather than a reason to wipe the cache. The app swaps the
  // accessory at runtime (headphones while music plays, glasses while coding,
  // seasonal costumes), and clearing on every swap caused a re-rasterisation
  // storm; keying means toggling back reuses the frames already drawn.
  EYELASHES = a.eyelashes ?? DEFAULT_APPEARANCE.eyelashes;
  STROKE_ENABLED = a.stroke ?? DEFAULT_APPEARANCE.stroke;
  STROKE_COLOR = a.strokeColor ?? DEFAULT_APPEARANCE.strokeColor;
  strokeCache = new WeakMap();
  appearanceKey = `${fur}/${eye}/${ear}/${pattern}/${accessory}/${a.species ?? DEFAULT_APPEARANCE.species}/${EYELASHES ? "lash" : "bare"}`;
  appearanceEpoch++;
}

/**
 * Add a crisp outline behind the fully composed sprite. Keeping this as a
 * post-process means the same border follows every pose, accessory and visual
 * layer without changing any of the cat artwork itself.
 */
export function applyAppearanceStroke(source: HTMLCanvasElement): HTMLCanvasElement {
  if (!STROKE_ENABLED) return source;
  const cached = strokeCache.get(source);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return source;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0);

  try {
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const output = new Uint8ClampedArray(image.data);
    const [red, green, blue] = hexToRgb(STROKE_COLOR);
    const radius = Math.max(1, Math.round(canvas.width / 64));
    const radiusSquared = radius * radius;
    const { width, height } = canvas;
    const pixelCount = width * height;
    const visited = new Uint8Array(pixelCount);
    let mainComponent: number[] = [];

    // Detached effects such as hearts, music notes and sleep symbols are part
    // of the same sprite canvas, but they are not part of the cat. Find the
    // largest connected opaque component so only the character silhouette is
    // outlined.
    for (let start = 0; start < pixelCount; start++) {
      if (visited[start] || image.data[start * 4 + 3] <= 16) continue;
      const component: number[] = [];
      const stack = [start];
      visited[start] = 1;
      while (stack.length) {
        const pixel = stack.pop()!;
        component.push(pixel);
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        for (let dy = -1; dy <= 1; dy++) {
          const nearY = y + dy;
          if (nearY < 0 || nearY >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nearX = x + dx;
            if (nearX < 0 || nearX >= width) continue;
            const near = nearY * width + nearX;
            if (visited[near] || image.data[near * 4 + 3] <= 16) continue;
            visited[near] = 1;
            stack.push(near);
          }
        }
      }
      if (component.length > mainComponent.length) mainComponent = component;
    }
    const catMask = new Uint8Array(pixelCount);
    for (const pixel of mainComponent) catMask[pixel] = 1;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        if (image.data[index + 3] !== 0) continue;

        let touchesSprite = false;
        for (let dy = -radius; dy <= radius && !touchesSprite; dy++) {
          const nearY = y + dy;
          if (nearY < 0 || nearY >= height) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            if (dx * dx + dy * dy > radiusSquared) continue;
            const nearX = x + dx;
            if (nearX < 0 || nearX >= width) continue;
            if (catMask[nearY * width + nearX]) {
              touchesSprite = true;
              break;
            }
          }
        }

        if (touchesSprite) {
          output[index] = red;
          output[index + 1] = green;
          output[index + 2] = blue;
          output[index + 3] = 255;
        }
      }
    }

    ctx.putImageData(new ImageData(output, width, height), 0, 0);
  } catch {
    // If a platform refuses pixel reads, keep the original sprite intact.
    return source;
  }

  strokeCache.set(source, canvas);
  return canvas;
}

/**
 * Design units the head shifts per unit of headTurn. Small on purpose — the
 * spec is a subtle lean, never a rotation.
 */
/**
 * Design units of head travel per unit of `headTurnX/Y`. The engine now feeds
 * a -2..2 range (was -1..1), so these are the per-STEP lean: peak travel is
 * twice these numbers. Deliberately kept under the old peak-times-two so the
 * head follows the cursor further without the skull sliding off the neck.
 */
const HEAD_LEAN_X = 0.95;
const HEAD_LEAN_Y = 0.62;

const FEET_Y = 44;
type Ctx = CanvasRenderingContext2D;
interface Pt { x: number; y: number }

/** Rect in design units, rasterised on the native grid. */
function px(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x * S), Math.round(y * S), Math.max(1, Math.round(w * S)), Math.max(1, Math.round(h * S)));
}

function tone(nx: number, ny: number, palette: string[]): string {
  const light = -(nx * -0.35 + ny * -0.94);
  const index = Math.max(0, Math.min(palette.length - 1, Math.round((1 - (light + 1) / 2) * (palette.length - 1))));
  return palette[index];
}

/** Shaded ellipse; loops on the NATIVE grid for smooth 96 px curves. */
function blob(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, palette = FUR): void {
  const scx = cx * S, scy = cy * S, srx = Math.max(0.6, rx * S), sry = Math.max(0.6, ry * S);
  for (let y = Math.floor(scy - sry); y <= Math.ceil(scy + sry); y++) {
    for (let x = Math.floor(scx - srx); x <= Math.ceil(scx + srx); x++) {
      const nx = (x + 0.5 - scx) / srx;
      const ny = (y + 0.5 - scy) / sry;
      if (nx * nx + ny * ny <= 1) {
        ctx.fillStyle = tone(nx, ny, palette);
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
}

function tri(ctx: Ctx, a: Pt, b: Pt, c: Pt, color: string): void {
  const A = { x: a.x * S, y: a.y * S }, B = { x: b.x * S, y: b.y * S }, C = { x: c.x * S, y: c.y * S };
  const minX = Math.floor(Math.min(A.x, B.x, C.x));
  const maxX = Math.ceil(Math.max(A.x, B.x, C.x));
  const minY = Math.floor(Math.min(A.y, B.y, C.y));
  const maxY = Math.ceil(Math.max(A.y, B.y, C.y));
  const d = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y);
  if (d === 0) return;
  ctx.fillStyle = color;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const wa = ((B.y - C.y) * (x + 0.5 - C.x) + (C.x - B.x) * (y + 0.5 - C.y)) / d;
      const wb = ((C.y - A.y) * (x + 0.5 - C.x) + (A.x - C.x) * (y + 0.5 - C.y)) / d;
      if (wa >= -0.02 && wb >= -0.02 && 1 - wa - wb >= -0.02) ctx.fillRect(x, y, 1, 1);
    }
  }
}

function bez(p0: Pt, p1: Pt, p2: Pt, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y };
}

/** Smooth stroked curve (for lash lines, smiles, whiskers, glasses rims). */
function stroke(ctx: Ctx, from: Pt, through: Pt, to: Pt, width: number, color: string): void {
  for (let i = 0; i <= 16; i++) {
    const p = bez(from, through, to, i / 16);
    blob(ctx, p.x, p.y, width, width, [color]);
  }
}

function curvedLimb(ctx: Ctx, from: Pt, through: Pt, to: Pt, width: number, palette = FUR): void {
  for (let i = 0; i <= 14; i++) {
    const p = bez(from, through, to, i / 14);
    blob(ctx, p.x, p.y, width, width, palette);
  }
}

/**
 * Live tail sway, -1..1, set once per frame in `drawCat` from pose.tailPhase.
 * A module-level value (like `SP`) so every tail call site sways without each
 * one having to thread the phase through.
 */
let TAIL_SWAY = 0;
/** Sway amplitude multiplier — damped right down while the cat is asleep. */
let TAIL_ENERGY = 1;

function drawTail(ctx: Ctx, root: Pt, control: Pt, tip: Pt, puff = false): void {
  // A cat's tail is never truly still. Push the curve's control point and tip
  // along the normal of the root->tip axis, so the whole tail arcs and uncurls
  // instead of just wagging its very end.
  const dx = tip.x - root.x;
  const dy = tip.y - root.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const amp = 2.9 * SP.tail * TAIL_ENERGY * TAIL_SWAY;
  control = { x: control.x + nx * amp, y: control.y + ny * amp };
  tip = { x: tip.x + nx * amp * 1.4, y: tip.y + ny * amp * 1.4 };

  // Wide or plume-tailed breeds push the curve outward; keep every control
  // point inside the sprite so the tail can never be clipped by the canvas.
  const margin = 3.2 * SP.tail;
  const clamp = (p: Pt): Pt => ({
    x: Math.max(margin, Math.min(48 - margin, p.x)),
    y: Math.max(margin, Math.min(48 - margin, p.y)),
  });
  root = clamp(root);
  control = clamp(control);
  tip = clamp(tip);
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const p = bez(root, control, tip, t);
    // Plume tails stay thick to the tip; slim tails taper hard.
    const taper = SP.tail > 1.25 ? 0.55 : 1.15;
    const width = ((puff ? 3.1 : 2.5) - t * (puff ? 0.8 : taper)) * SP.tail;
    blob(ctx, p.x, p.y, width, width, FUR);
  }
  blob(ctx, tip.x, tip.y, (puff ? 2.3 : 1.5) * SP.tail, (puff ? 2.3 : 1.5) * SP.tail, [FUR[1]]);
}

function drawEar(ctx: Ctx, cx: number, baseY: number, direction: number, state: EarState): void {
  if (state === "flat" || state === "back") {
    const sign = direction || 1;
    tri(ctx, { x: cx - 3, y: baseY }, { x: cx + 3, y: baseY + 1 }, { x: cx + sign * 4.6, y: baseY - 1.6 }, FUR[2]);
    return;
  }
  // Clamp to the headroom above the skull: the siamese's tall ears (1.4x) were
  // having their tips sliced off by the top of the sprite on many poses.
  const height = Math.min(baseY - 1.5, (state === "perk" ? 7 : 6.2) * SP.ear);
  const halfW = 3.4 * (SP.ear > 1.15 ? 1.08 : 1); // tall ears widen a little too
  const tipX = cx + direction * 0.8;
  tri(ctx, { x: cx - halfW, y: baseY + 1.2 }, { x: cx + halfW, y: baseY + 1.2 }, { x: tipX, y: baseY - height }, FUR[2]);
  tri(ctx, { x: cx - 1.9, y: baseY + 0.4 }, { x: cx + 2, y: baseY + 0.4 }, { x: tipX, y: baseY - height + 2 }, EAR_DARK);
  px(ctx, tipX - 0.4, baseY - height + 2.4, 1, 1.6, EAR_LIGHT);
  // Long-haired breeds get soft lynx tufts: short, thick and swept outward
  // from the ear base so they read as fur, never as antennae.
  if (SP.tufts) {
    const out = direction >= 0 ? 1 : -1;
    blob(ctx, cx + out * 2.4, baseY - height * 0.22, 1.5, 1.2, [FUR[0], FUR[1]]);
    blob(ctx, cx + out * 3.4, baseY - height * 0.44, 1.15, 0.95, [FUR[0], FUR[1]]);
    blob(ctx, cx - out * 1.9, baseY - height * 0.3, 1.2, 1, [FUR[0], FUR[1]]);
  }
}

function clampPupil(v: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, v));
}

/**
 * Big glossy chibi eye: colour iris ramp, large dark pupil, two highlights.
 * The pupil moves with pose.pupilX/Y (cursor tracking), clamped inside.
 */
/**
 * Long upper lashes on the OUTER corner of an eye. `outward` is +1 when the
 * outer side lies to the right of the eye and -1 when it lies to the left, so
 * the two eyes mirror each other properly in the front view.
 */
function drawLashes(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, outward: number): void {
  const d = outward >= 0 ? 1 : -1;
  const lash = (fx: number, fy: number, tx: number, ty: number, w: number) => {
    stroke(
      ctx,
      { x: cx + d * rx * fx, y: cy - ry * fy },
      { x: cx + d * rx * ((fx + tx) / 2), y: cy - ry * ((fy + ty) / 2 + 0.12) },
      { x: cx + d * rx * tx, y: cy - ry * ty },
      w,
      FUR[3],
    );
  };
  // Three lashes fanning up and outward: longest at the top, shortest at the
  // outer corner — the classic doe-eyed silhouette at this tiny scale.
  lash(0.45, 0.88, 0.95, 1.52, 0.42);
  lash(0.8, 0.72, 1.35, 1.2, 0.42);
  lash(1.0, 0.4, 1.6, 0.7, 0.38);
}

function drawEye(ctx: Ctx, cx: number, cy: number, pose: PoseSpec, side = false, outward = 1): void {
  const state = pose.eyes;
  // Deliberately oversized chibi eyes — they are the single biggest driver of
  // how cute the cat reads, and at desktop-pet scale they need the extra size
  // to stay expressive.
  const rx = (side ? 3.75 : 4.5) * SP.eye;
  const ry = (side ? 4.65 : 5.4) * SP.eye;

  // Closed/happy lids scale with the larger eyes so a blink doesn't look like
  // the eyes shrank.
  if (state === "closed") {
    stroke(ctx, { x: cx - 3.4, y: cy + 0.3 }, { x: cx, y: cy + 2.2 }, { x: cx + 3.4, y: cy + 0.3 }, 0.75, FUR[3]);
    if (EYELASHES) drawLashes(ctx, cx, cy, rx, ry * 0.5, outward);
    return;
  }
  if (state === "happy") {
    stroke(ctx, { x: cx - 3.5, y: cy + 1.1 }, { x: cx, y: cy - 2.2 }, { x: cx + 3.5, y: cy + 1.1 }, 0.8, FUR[3]);
    if (EYELASHES) drawLashes(ctx, cx, cy, rx, ry * 0.5, outward);
    return;
  }

  const wide = state === "wide" || state === "surprised";
  const focus = state === "focus";
  const half = state === "half";
  const panic = state === "panic";
  const sad = state === "sad";
  const angry = state === "angry";
  // Panic reads through the shrunken pupil, not a bulging eye — only a touch
  // larger than "wide", or the face stops looking like the same cat.
  const eRx = rx + (wide ? 0.5 : 0) + (panic ? 0.45 : 0);
  const eRy = focus
    ? ry * 0.55
    : half
      ? ry * 0.72
      : sad
        ? ry * 0.92
        : angry
          ? ry * 0.62 // narrowed glare
          : ry + (wide ? 0.6 : 0) + (panic ? 0.5 : 0);
  // Sad eyes gaze slightly upward, which is most of what makes them read as
  // pleading rather than merely droopy.
  const offsetY = state === "up" ? -1.1 : state === "down" ? 1.1 : sad ? -0.5 : 0;

  blob(ctx, cx, cy + offsetY, eRx, eRy, [EYE_LIGHT, EYE_MID, EYE_DARK]);

  // Big prominent pupil: sized as a fraction of the iris so it stays large and
  // glossy at every eye shape, leaving only a thin bright rim of colour.
  const fx = panic ? 0.42 : focus ? 0.86 : wide ? 0.66 : 0.82;
  const fy = panic ? 0.46 : focus ? 0.92 : wide ? 0.76 : 0.86;
  const pRx = eRx * fx;
  const pRy = eRy * fy;
  const pxOff = clampPupil(pose.pupilX, Math.max(0, eRx - pRx));
  const pyOff = clampPupil(pose.pupilY * 0.55 + offsetY * 0.7, Math.max(0, eRy - pRy));
  blob(ctx, cx + pxOff, cy + offsetY + pyOff, pRx, pRy, [EYE_PUPIL]);

  // Double highlight = the glossy chibi sparkle (kept large so the big pupils
  // still read as bright and friendly, never flat or staring).
  blob(ctx, cx + pxOff - pRx * 0.35, cy + offsetY + pyOff - pRy * 0.4, 1.35, 1.5, [EYE_SHINE]);
  blob(ctx, cx + pxOff + pRx * 0.3, cy + offsetY + pyOff + pRy * 0.35, 0.75, 0.8, [EYE_SHINE]);

  if (half) {
    // Relaxed upper lid.
    px(ctx, cx - eRx, cy + offsetY - eRy, eRx * 2, eRy * 0.85, FUR[1]);
    stroke(ctx, { x: cx - eRx, y: cy + offsetY - eRy * 0.15 }, { x: cx, y: cy + offsetY - eRy * 0.05 }, { x: cx + eRx, y: cy + offsetY - eRy * 0.15 }, 0.5, FUR[3]);
  }
  if (sad) {
    // Upper lid slanting DOWN toward the outer corner. `side` mirrors which way
    // is "outer", and this slant is what separates sad from merely sleepy.
    const outer = side ? -1 : 1;
    const inner = -outer;
    stroke(
      ctx,
      { x: cx + outer * eRx, y: cy + offsetY - eRy * 0.25 },
      { x: cx, y: cy + offsetY - eRy * 0.95 },
      { x: cx + inner * eRx, y: cy + offsetY - eRy * 1.05 },
      0.85,
      FUR[3],
    );
    // Lid fill above the slant so the eye reads as genuinely hooded.
    tri(
      ctx,
      { x: cx + outer * eRx, y: cy + offsetY - eRy * 0.3 },
      { x: cx + inner * eRx, y: cy + offsetY - eRy * 1.1 },
      { x: cx + outer * eRx, y: cy + offsetY - eRy * 1.3 },
      FUR[1],
    );
  }
  // Lashes ride on top of the eye so they stay visible over the iris.
  if (EYELASHES) drawLashes(ctx, cx, cy + offsetY, eRx, eRy, outward);
  if (angry) {
    // Brow slanting DOWN toward the INNER corner — the opposite slant to sad.
    // That inward V plus the narrowed eye is the whole glare.
    const outer = side ? -1 : 1;
    const inner = -outer;
    stroke(
      ctx,
      { x: cx + inner * eRx, y: cy + offsetY - eRy * 0.15 },
      { x: cx, y: cy + offsetY - eRy * 0.9 },
      { x: cx + outer * eRx, y: cy + offsetY - eRy * 1.15 },
      0.9,
      FUR[3],
    );
    tri(
      ctx,
      { x: cx + inner * eRx, y: cy + offsetY - eRy * 0.2 },
      { x: cx + outer * eRx, y: cy + offsetY - eRy * 1.2 },
      { x: cx + inner * eRx, y: cy + offsetY - eRy * 1.4 },
      FUR[1],
    );
  }
}

function drawMouth(ctx: Ctx, hx: number, my: number, mouth: MouthState): void {
  switch (mouth) {
    case "yawn":
      // A deliberately oversized oval so the pre-sleep yawn reads clearly at
      // desktop-pet scale, with a tongue and tiny upper fangs for cuteness.
      blob(ctx, hx, my + 1.2, 3.3, 3.8, [FUR[3]]);
      blob(ctx, hx, my + 3.1, 2.2, 1.25, [TONGUE]);
      tri(ctx, { x: hx - 2.2, y: my - 1.2 }, { x: hx - 0.8, y: my - 1.2 }, { x: hx - 1.5, y: my + 0.2 }, EYE_SHINE);
      tri(ctx, { x: hx + 0.8, y: my - 1.2 }, { x: hx + 2.2, y: my - 1.2 }, { x: hx + 1.5, y: my + 0.2 }, EYE_SHINE);
      break;
    case "open":
      blob(ctx, hx, my + 0.6, 1.9, 1.7, [FUR[3]]);
      blob(ctx, hx, my + 1.3, 1.1, 0.8, [TONGUE]);
      break;
    case "teeth":
      // Angry grimace: a wide open mouth with a row of bared white fangs on
      // top and a hint of tongue below — cross, but still a cartoon cat.
      blob(ctx, hx, my + 1.0, 2.9, 2.1, [FUR[3]]);
      blob(ctx, hx, my + 2.2, 1.6, 0.7, [TONGUE]);
      for (const dx of [-2.0, -0.7, 0.7, 2.0]) {
        tri(ctx, { x: hx + dx - 0.55, y: my - 0.8 }, { x: hx + dx + 0.55, y: my - 0.8 }, { x: hx + dx, y: my + 0.6 }, EYE_SHINE);
      }
      break;
    case "frown":
      stroke(ctx, { x: hx - 1.8, y: my + 1 }, { x: hx, y: my - 0.4 }, { x: hx + 1.8, y: my + 1 }, 0.45, MOUTH);
      break;
    case "smile":
      stroke(ctx, { x: hx - 2.4, y: my - 0.6 }, { x: hx, y: my + 1.2 }, { x: hx + 2.4, y: my - 0.6 }, 0.5, MOUTH);
      break;
    default:
      // Tiny contented "ω" smile — the default friendly face.
      stroke(ctx, { x: hx - 1.8, y: my - 0.3 }, { x: hx - 0.9, y: my + 0.7 }, { x: hx, y: my - 0.1 }, 0.4, MOUTH);
      stroke(ctx, { x: hx, y: my - 0.1 }, { x: hx + 0.9, y: my + 0.7 }, { x: hx + 1.8, y: my - 0.3 }, 0.4, MOUTH);
  }
}

// ---- accessories ---------------------------------------------------------
function ring(ctx: Ctx, cx: number, cy: number, r: number, width: number, color: string): void {
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    blob(ctx, cx + Math.cos(a) * r, cy + Math.sin(a) * r, width, width, [color]);
  }
}

function ellipseRing(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, width: number, color: string): void {
  for (let i = 0; i < 30; i++) {
    const a = (i / 30) * Math.PI * 2;
    blob(ctx, cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, width, width, [color]);
  }
}

// ---- seasonal costumes ---------------------------------------------------
// Each takes the head centre-x and the y of the top of the skull, plus the
// head half-width, so front/side/back views can all share one implementation.

/** Floppy red santa hat with a white brim and a pompom. */
function drawSantaHat(ctx: Ctx, hx: number, topY: number, w: number, dir = 1): void {
  const tipX = hx + dir * w * 0.95;
  const tipY = topY - w * 0.95;
  tri(ctx, { x: hx - w * 0.86, y: topY + 0.6 }, { x: hx + w * 0.86, y: topY + 0.6 }, { x: hx + dir * w * 0.3, y: topY - w * 0.72 }, SANTA_RED);
  // Slumping tip that flops toward `dir`.
  curvedLimb(ctx, { x: hx + dir * w * 0.28, y: topY - w * 0.68 }, { x: hx + dir * w * 0.85, y: tipY + 1.4 }, { x: tipX, y: tipY }, 1.5, [SANTA_RED, SANTA_RED_DARK]);
  px(ctx, hx - w * 0.95, topY + 0.2, w * 1.9, 2.1, SANTA_TRIM);
  blob(ctx, tipX, tipY, 2, 1.9, [SANTA_TRIM]);
}

/** Pointed witch hat: wide brim, tall bent cone, gold buckle band. */
function drawWitchHat(ctx: Ctx, hx: number, topY: number, w: number, dir = 1): void {
  blob(ctx, hx, topY + 1, w * 1.55, 1.7, [WITCH_PURPLE, WITCH_PURPLE_DARK]);
  tri(ctx, { x: hx - w * 0.78, y: topY + 1 }, { x: hx + w * 0.78, y: topY + 1 }, { x: hx + dir * w * 0.55, y: topY - w * 1.35 }, WITCH_PURPLE);
  // Bent tip for character.
  tri(
    ctx,
    { x: hx + dir * w * 0.34, y: topY - w * 0.95 },
    { x: hx + dir * w * 0.72, y: topY - w * 0.95 },
    { x: hx + dir * w * 1.15, y: topY - w * 1.55 },
    WITCH_PURPLE_DARK,
  );
  px(ctx, hx - w * 0.62, topY - 1.6, w * 1.3, 1.8, WITCH_PURPLE_DARK);
  px(ctx, hx + dir * w * 0.1 - 1, topY - 1.5, 2.2, 1.6, WITCH_BUCKLE);
}

/** Striped party cone with a pompom. */
function drawPartyHat(ctx: Ctx, hx: number, topY: number, w: number, dir = 1): void {
  const tipX = hx + dir * w * 0.22;
  const tipY = topY - w * 1.05;
  tri(ctx, { x: hx - w * 0.6, y: topY + 0.8 }, { x: hx + w * 0.6, y: topY + 0.8 }, { x: tipX, y: tipY }, PARTY_A);
  for (let i = 1; i <= 2; i++) {
    const t = i / 3;
    const halfW = w * 0.6 * (1 - t);
    px(ctx, hx - halfW + (tipX - hx) * t, topY + 0.8 - (topY + 0.8 - tipY) * t, halfW * 2, 1.1, PARTY_B);
  }
  blob(ctx, tipX, tipY, 1.7, 1.6, [PARTY_B]);
}

/** Ring of little flowers sitting on the head. */
function drawFlowerCrown(ctx: Ctx, hx: number, topY: number, w: number): void {
  for (let i = -2; i <= 2; i++) {
    const fx = hx + i * w * 0.42;
    const fy = topY + 0.9 + Math.abs(i) * 0.75;
    const petal = i % 2 === 0 ? FLOWER_PINK : FLOWER_WHITE;
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * Math.PI * 2;
      blob(ctx, fx + Math.cos(a) * 1.25, fy + Math.sin(a) * 1.1, 0.95, 0.9, [petal]);
    }
    blob(ctx, fx, fy, 0.7, 0.65, [FLOWER_CENTRE]);
  }
  blob(ctx, hx - w * 0.95, topY + 2.4, 1.3, 0.8, [LEAF]);
  blob(ctx, hx + w * 0.95, topY + 2.4, 1.3, 0.8, [LEAF]);
}

/** Knitted scarf wrapped round the neck with a hanging end. */
function drawScarf(ctx: Ctx, hx: number, collarY: number, w: number, dir = 1): void {
  stroke(ctx, { x: hx - w * 0.9, y: collarY - 0.4 }, { x: hx, y: collarY + 1.6 }, { x: hx + w * 0.9, y: collarY - 0.4 }, 1.5, SCARF_DARK);
  stroke(ctx, { x: hx - w * 0.82, y: collarY - 0.7 }, { x: hx, y: collarY + 1 }, { x: hx + w * 0.82, y: collarY - 0.7 }, 0.85, SCARF);
  // Hanging tail with a couple of knit rows.
  const tx = hx + dir * w * 0.5;
  px(ctx, tx - 1.4, collarY + 0.8, 2.8, 6.5, SCARF);
  px(ctx, tx - 1.4, collarY + 3, 2.8, 0.8, SCARF_DARK);
  px(ctx, tx - 1.4, collarY + 5.4, 2.8, 0.8, SCARF_DARK);
}

/** Draw whichever seasonal costume is active. Returns true if it drew one. */
function seasonalAccessory(ctx: Ctx, hx: number, hy: number, hrx: number, hry: number, dir = 1): boolean {
  const topY = hy - hry + 1.4;
  const collarY = hy + hry - 1.2;
  // Big-headed breeds leave little room above the skull; cap each hat's height
  // to the available headroom so a tall crown is never clipped by the canvas.
  const headroom = Math.max(3.5, topY - 2.5);
  switch (accessory) {
    case "santaHat":
      drawSantaHat(ctx, hx, topY, Math.min(hrx * 0.78, headroom / 0.95), dir);
      return true;
    case "witchHat":
      drawWitchHat(ctx, hx, topY, Math.min(hrx * 0.72, headroom / 1.55), dir);
      return true;
    case "partyHat":
      drawPartyHat(ctx, hx, topY, Math.min(hrx * 0.7, headroom / 1.05), dir);
      return true;
    case "flowerCrown":
      drawFlowerCrown(ctx, hx, topY, hrx * 0.7);
      return true;
    case "scarf":
      drawScarf(ctx, hx, collarY, hrx * 0.8, dir);
      return true;
    default:
      return false;
  }
}

function frontAccessory(ctx: Ctx, hx: number, hy: number, hrx: number, hry: number): void {
  if (seasonalAccessory(ctx, hx, hy, hrx, hry, 1)) return;
  if (accessory === "sunglasses") {
    // Aviator shape: lens, bridge and temple are one continuous rim rather than
    // three separate floating pieces — the old version left a visible gap of
    // bare fur between each lens and its own bridge/temple.
    const cy = hy - 0.4;
    const lensRX = 4.6, lensRY = 3.4;
    for (const d of [-1, 1] as const) {
      const lensX = hx + d * 5.2;
      blob(ctx, lensX, cy, lensRX, lensRY, [SHADE_LIGHT, SHADE_LENS]);
      ellipseRing(ctx, lensX, cy, lensRX, lensRY, 0.7, SUNGLASS_RIM);
      // Diagonal glare streak reading as a glass reflection, not a flat patch.
      stroke(ctx, { x: lensX - 2.6, y: cy - 1.9 }, { x: lensX - 1, y: cy - 1.2 }, { x: lensX - 1.8, y: cy - 0.2 }, 0.5, GLASS_GLINT);
      // Temple: a real arm from the lens rim out toward the ear, angled back
      // slightly (as real glasses arms do) so it reads as an arm rather than a
      // second rim thickening. Starts exactly on the lens's own outer edge so
      // there is no seam between rim and arm.
      stroke(ctx, { x: lensX + d * lensRX, y: cy }, { x: hx + d * hrx * 0.72, y: cy - 0.6 }, { x: hx + d * hrx * 0.94, y: cy - 1 }, 0.55, SUNGLASS_RIM);
    }
    // Bridge sits AT lens-centre height so it visibly meets both rims, not
    // above them where it used to read as a disconnected eyebrow arc.
    px(ctx, hx - 1.2, cy - 0.45, 2.4, 0.9, SUNGLASS_RIM);
  } else if (accessory === "glasses") {
    for (const d of [-1, 1] as const) ring(ctx, hx + d * 5.4, hy - 0.5, 4.4, 0.5, GLASS_RIM);
    px(ctx, hx - 1.4, hy - 1.2, 2.8, 0.8, GLASS_RIM);
    px(ctx, hx - hrx + 0.6, hy - 1.4, 1.8, 0.7, GLASS_RIM);
    px(ctx, hx + hrx - 2.4, hy - 1.4, 1.8, 0.7, GLASS_RIM);
    px(ctx, hx - 8, hy - 3, 1.6, 0.7, GLASS_GLINT);
  } else if (accessory === "headphones") {
    stroke(ctx, { x: hx - hrx + 0.8, y: hy }, { x: hx, y: hy - hry - 4 }, { x: hx + hrx - 0.8, y: hy }, 1.5, PHONES_DARK);
    stroke(ctx, { x: hx - hrx + 0.8, y: hy }, { x: hx, y: hy - hry - 4 }, { x: hx + hrx - 0.8, y: hy }, 0.75, PHONES);
    for (const d of [-1, 1] as const) {
      const cupX = hx + d * (hrx - 0.2);
      blob(ctx, cupX, hy + 1.3, 2.8, 4, [PHONES, PHONES_DARK]);
      blob(ctx, cupX, hy + 1.3, 1.5, 2.5, [PHONES_DARK]);
      px(ctx, cupX - 0.5, hy - 1, 1, 2.4, GLASS_GLINT);
    }
  } else if (accessory === "bandana") {
    const collarY = hy + hry - 1.4;
    stroke(ctx, { x: hx - 7.2, y: collarY }, { x: hx, y: collarY + 1.4 }, { x: hx + 7.2, y: collarY }, 1.3, BANDANA_DARK);
    stroke(ctx, { x: hx - 6.8, y: collarY - 0.2 }, { x: hx, y: collarY + 0.9 }, { x: hx + 6.8, y: collarY - 0.2 }, 0.75, BANDANA);
    tri(ctx, { x: hx - 5, y: collarY + 0.5 }, { x: hx + 5, y: collarY + 0.5 }, { x: hx, y: collarY + 8 }, BANDANA);
    tri(ctx, { x: hx, y: collarY + 3 }, { x: hx + 5, y: collarY + 0.5 }, { x: hx + 1.5, y: collarY + 6.5 }, BANDANA_DARK);
    blob(ctx, hx + 7.1, collarY + 0.4, 1.5, 1.4, [BANDANA, BANDANA_DARK]);
  } else if (accessory === "watch") {
    const wx = hx + 5.2;
    px(ctx, wx - 1.7, 36.2, 3.4, 5.6, WATCH_STRAP);
    blob(ctx, wx, 38.8, 2.2, 2, [WATCH_FACE, WATCH_STRAP]);
    px(ctx, wx - 0.45, 37.7, 0.7, 1.4, EYE_SHINE);
  } else if (accessory === "hat") {
    const baseY = hy - hry + 1.2;
    // Cap the crown to the headroom above the skull; a fixed height clipped
    // straight through the top of the sprite on taller-headed breeds.
    const crownH = Math.max(3, Math.min(6.2, baseY - 1.6));
    px(ctx, hx - 6.2, baseY - crownH, 12.4, crownH, HAT);
    px(ctx, hx - 6.2, baseY - 1.8, 12.4, 1.5, BANDANA);
    px(ctx, hx - 8.8, baseY - 0.5, 17.6, 2, HAT_DARK);
    px(ctx, hx - 4.8, baseY - crownH + 0.8, 2, 0.8, GLASS_GLINT);
  } else if (accessory === "cap") {
    const topY = hy - hry + 0.8;
    blob(ctx, hx - 0.8, topY, 8, 4.2, [CAP_LIGHT, CAP]);
    px(ctx, hx - 8.4, topY + 1.4, 16, 1.8, CAP);
    px(ctx, hx + 5.5, topY + 2.5, 6.3, 1.4, CAP);
    px(ctx, hx - 1, topY - 3.2, 1, 2, CAP_LIGHT);
  }
}

function sideAccessory(ctx: Ctx, hx: number, hy: number, hrx: number, hry: number, watchAt: Pt): void {
  // Costumes flop backwards in profile (the cat faces right).
  if (seasonalAccessory(ctx, hx, hy, hrx, hry, -1)) return;
  if (accessory === "sunglasses") {
    blob(ctx, hx + 3.8, hy - 0.6, 4.25, 3.25, [SHADE_LIGHT, SHADE_LENS]);
    ellipseRing(ctx, hx + 3.8, hy - 0.6, 4.2, 3.2, 0.55, SUNGLASS_RIM);
    stroke(ctx, { x: hx - hrx + 1, y: hy - 1.6 }, { x: hx - 3, y: hy - 2 }, { x: hx + 0.2, y: hy - 1.1 }, 0.65, SUNGLASS_RIM);
    px(ctx, hx + 1.4, hy - 2.5, 2.2, 0.65, GLASS_GLINT);
  } else if (accessory === "glasses") {
    ring(ctx, hx + 3.6, hy - 0.8, 4, 0.5, GLASS_RIM);
    px(ctx, hx - hrx + 1, hy - 1.4, 5.4, 0.7, GLASS_RIM);
    px(ctx, hx + 1.4, hy - 3, 1.6, 0.7, GLASS_GLINT);
  } else if (accessory === "headphones") {
    // Profile headband stays behind the visible ear and never crosses the eye.
    stroke(ctx, { x: hx - 6.2, y: hy + 0.8 }, { x: hx - 5.4, y: hy - hry - 2.8 }, { x: hx + 1.4, y: hy - hry + 0.6 }, 1.45, PHONES_DARK);
    stroke(ctx, { x: hx - 6.2, y: hy + 0.8 }, { x: hx - 5.4, y: hy - hry - 2.8 }, { x: hx + 1.4, y: hy - hry + 0.6 }, 0.7, PHONES);
    blob(ctx, hx - 5.2, hy + 2, 2.8, 3.9, [PHONES, PHONES_DARK]);
    blob(ctx, hx - 5.2, hy + 2, 1.45, 2.5, [PHONES_DARK]);
    px(ctx, hx - 5.7, hy - 0.2, 1, 2.4, GLASS_GLINT);
  } else if (accessory === "bandana") {
    const collar = { x: hx - hrx * 0.48, y: hy + hry * 0.58 };
    stroke(ctx, { x: collar.x - 3.6, y: collar.y - 1 }, collar, { x: collar.x + 4.2, y: collar.y + 1 }, 1.25, BANDANA_DARK);
    stroke(ctx, { x: collar.x - 3.3, y: collar.y - 1.2 }, collar, { x: collar.x + 4, y: collar.y + 0.7 }, 0.7, BANDANA);
    tri(ctx, { x: collar.x - 2.4, y: collar.y }, { x: collar.x + 3.7, y: collar.y + 0.8 }, { x: collar.x - 1, y: collar.y + 7.5 }, BANDANA);
    blob(ctx, collar.x - 3.7, collar.y - 0.4, 1.4, 1.3, [BANDANA, BANDANA_DARK]);
  } else if (accessory === "watch") {
    px(ctx, watchAt.x - 1.5, watchAt.y - 2.6, 3, 5.2, WATCH_STRAP);
    blob(ctx, watchAt.x, watchAt.y, 2.1, 1.9, [WATCH_FACE, WATCH_STRAP]);
    px(ctx, watchAt.x - 0.4, watchAt.y - 1, 0.7, 1.3, EYE_SHINE);
  } else if (accessory === "hat") {
    const baseY = hy - hry + 1.2;
    const crownH = Math.max(3, Math.min(6, baseY - 1.6));
    px(ctx, hx - 5.4, baseY - crownH, 10.8, crownH, HAT);
    px(ctx, hx - 5.4, baseY - 1.8, 10.8, 1.4, BANDANA);
    px(ctx, hx - 8, baseY - 0.5, 16, 1.9, HAT_DARK);
    px(ctx, hx - 3.8, baseY - crownH + 0.8, 1.8, 0.8, GLASS_GLINT);
  } else if (accessory === "cap") {
    const topY = hy - hry + 1;
    blob(ctx, hx - 1.8, topY, 7.2, 3.9, [CAP_LIGHT, CAP]);
    px(ctx, hx - 7.5, topY + 1.3, 13.6, 1.7, CAP);
    px(ctx, hx + 3.8, topY + 2.1, 7.4, 1.4, CAP);
  }
}

// ---- props / decorations -------------------------------------------------
function drawNotebook(ctx: Ctx): void {
  px(ctx, 15.5, 37.2, 12.4, 6.8, PAPER_DARK);
  px(ctx, 16, 37.7, 11.4, 5.8, PAPER);
  for (let i = 0; i < 3; i++) px(ctx, 17.4, 39 + i * 1.6, 8.6, 0.5, INK);
  for (let i = 0; i < 4; i++) px(ctx, 16.2, 38.2 + i * 1.4, 0.6, 0.6, PAPER_DARK); // spiral
  // Pencil held by the right paw.
  px(ctx, 27.2, 38.6, 3.6, 1, PENCIL);
  tri(ctx, { x: 30.8, y: 38.5 }, { x: 30.8, y: 39.7 }, { x: 32, y: 39.1 }, INK);
}

/**
 * Chunky mechanical keyboard with a properly violent typing action: the paws
 * travel far, the struck keycap visibly bottoms out, and impact marks and a
 * popped-loose key sell the effort.
 */
function drawKeyboard(ctx: Ctx, legPhase: number): void {
  const leftDown = legPhase < 0.5;
  const KEY_W = 2.9;
  const KEY_H = 1.7;
  const COLS = 5;
  const x0 = 13.6;
  const y0 = 39.2;

  // Deck: front lip + body, wider and deeper than before.
  px(ctx, x0 - 0.8, y0 + 3.9, 21.6, 1.3, KEYS_BASE);
  px(ctx, x0 - 0.4, y0 - 0.5, 20.8, 4.6, KEYS_BASE);

  // Which key each paw is hammering.
  const leftKey = leftDown ? 1 : 0;
  const rightKey = leftDown ? 3 : 4;

  for (let r = 0; r < 2; r++) {
    for (let k = 0; k < COLS; k++) {
      const kx = x0 + k * (KEY_W + 0.9);
      const struck = r === 1 && ((leftDown && k === leftKey) || (!leftDown && k === rightKey));
      const ky = y0 + r * (KEY_H + 0.7) + (struck ? 0.9 : 0);
      // A struck key sinks and darkens; the rest keep a bright cap + shadow.
      px(ctx, kx, ky + KEY_H - 0.4, KEY_W, 0.6, KEYS_BASE);
      px(ctx, kx, ky, KEY_W, KEY_H, struck ? KEYS_PRESSED : KEYS_CAP);
      if (!struck) px(ctx, kx + 0.3, ky + 0.2, KEY_W - 0.6, 0.5, KEYS_HILITE);
    }
  }

  // Paws: big vertical travel so the slam reads even at desktop-pet size.
  const HIGH = 33.6;
  const LOW = 39.4;
  const lp = { x: x0 + leftKey * (KEY_W + 0.9) + KEY_W / 2, y: leftDown ? LOW : HIGH };
  const rp = { x: x0 + rightKey * (KEY_W + 0.9) + KEY_W / 2, y: leftDown ? HIGH : LOW };
  for (const [p, down] of [
    [lp, leftDown],
    [rp, !leftDown],
  ] as const) {
    // Foreleg trailing up out of frame toward the shoulders.
    curvedLimb(ctx, { x: p.x, y: p.y - 5.5 }, { x: p.x + 0.6, y: p.y - 2.6 }, { x: p.x, y: p.y }, 1.7);
    blob(ctx, p.x, p.y, 2.9, 1.9, FUR);
    if (down) {
      // Impact: speed lines flaring off the strike plus a puff of dust.
      for (const s of [-1, 1] as const) {
        px(ctx, p.x + s * 3.4, p.y - 1.4, 1.8, 0.5, KEYS_HILITE);
        px(ctx, p.x + s * 4.2, p.y + 0.4, 1.3, 0.45, KEYS_HILITE);
      }
    } else {
      // Motion trail under the lifted paw.
      px(ctx, p.x - 0.5, p.y + 2.6, 1, 2.2, KEYS_HILITE);
      px(ctx, p.x + 1.4, p.y + 3.4, 0.8, 1.5, KEYS_HILITE);
    }
  }

  // A keycap knocked clean off, tumbling above the deck.
  const flyX = leftDown ? 31.5 : 15.5;
  px(ctx, flyX, 33.4, 2.2, 1.3, KEYS_CAP);
  px(ctx, flyX + 0.4, 32.2, 1.1, 0.5, KEYS_HILITE);
}

/** A tiny handheld mic, gripped in one paw and held up to the muzzle. */
function drawMic(ctx: Ctx, sway: number): void {
  const x = 30.5 + sway;
  blob(ctx, x, 27.5, 2.2, 2.2, [MIC_HEAD, MIC_RING]);   // ball grille
  px(ctx, x - 0.5, 29.2, 1.2, 4.4, MIC_BODY);            // handle
  px(ctx, x - 1.1, 28.6, 2.4, 0.7, MIC_RING);            // collar
  blob(ctx, x - 0.2, 33.6, 2.3, 1.6, FUR);               // paw gripping it
}

/**
 * The Quick Tools laptop: an open lid glowing at the cat, paws resting on the
 * deck. `legPhase` drifts a scanline down the screen and shifts the paws a
 * hair, so an open panel doesn't leave the cat looking like a frozen sprite.
 */
/**
 * Small water bowl in front of the sitting cat, under its chin. `phase` 0..1
 * drives a gentle ripple on the water surface plus, at the lick's deepest
 * point, a tiny splash-droplet — enough motion to read as actual drinking.
 */
function drawBowl(ctx: Ctx, phase: number): void {
  const cx = 24;
  const rimY = 41.6;
  const rw = 7.2; // rim half-width
  // Bowl body: a squat trapezoid with a lighter rim and a shaded base.
  px(ctx, cx - rw + 1, rimY + 1.2, rw * 2 - 2, 3.4, BOWL_BODY);
  px(ctx, cx - rw + 2, rimY + 4.2, rw * 2 - 4, 1.2, BOWL_SHADE);
  blob(ctx, cx, rimY + 0.6, rw, 1.7, [BOWL_RIM]);
  // Water: an inner ellipse whose surface bobs with the ripple phase.
  const ripple = Math.sin(phase * Math.PI * 2);
  blob(ctx, cx, rimY + 0.7 + ripple * 0.25, rw - 1.6, 1.1, [WATER]);
  // Highlight arcs slide across the surface so the water visibly moves.
  px(ctx, cx - 2.4 + ripple * 1.6, rimY + 0.3, 2.6, 0.5, WATER_LIGHT);
  px(ctx, cx + 1.2 - ripple * 1.2, rimY + 1.0, 1.6, 0.4, WATER_LIGHT);
  // Splash droplet at the deepest lick.
  if (ripple > 0.55) blob(ctx, cx + 3.2, rimY - 1.4 - ripple, 0.55, 0.55, [WATER_LIGHT]);
}

function drawLaptop(ctx: Ctx, legPhase: number): void {
  const DECK_Y = 40.4;
  const W = 23;
  const x0 = 24 - W / 2;
  const lidH = 9.6;
  const lidTop = DECK_Y - 0.6 - lidH;

  // ---- lid: outer shell, bezel, then the screen itself ----
  px(ctx, x0 + 0.8, lidTop, W - 1.6, lidH, LAPTOP_BODY);
  // Thin lighter edge along the top catches the light and separates the lid
  // from the dark screen beneath it.
  px(ctx, x0 + 0.8, lidTop, W - 1.6, 0.6, "#5e6474");
  px(ctx, x0 + 1.7, lidTop + 0.9, W - 3.4, lidH - 2, LAPTOP_BEZEL);
  const scrX = x0 + 2.3;
  const scrY = lidTop + 1.5;
  const scrW = W - 4.6;
  const scrH = lidH - 3.2;
  px(ctx, scrX, scrY, scrW, scrH, LAPTOP_SCREEN);

  // Code-like content: a left gutter plus ragged indented lines, which reads as
  // "working" far better than evenly spaced bars.
  px(ctx, scrX + 0.6, scrY + 0.6, 0.5, scrH - 1.2, "#2c5566");
  const lines = [5.6, 3.4, 6.8, 2.6, 4.8];
  for (let i = 0; i < lines.length; i++) {
    const ly = scrY + 1 + i * 1.25;
    if (ly > scrY + scrH - 1.2) break;
    px(ctx, scrX + 1.8 + (i % 2) * 1.2, ly, lines[i], 0.55, LAPTOP_LINE);
  }
  // A single travelling caret/scanline gives it life without churning the cache.
  const scan = scrY + (((legPhase % 1) + 1) % 1) * (scrH - 0.6);
  px(ctx, scrX + 0.6, scan, scrW - 1.2, 0.45, LAPTOP_GLOW);

  // ---- hinge + deck ----
  px(ctx, x0 + 0.4, DECK_Y - 0.7, W - 0.8, 0.7, LAPTOP_DARK);
  px(ctx, x0, DECK_Y, W, 2.8, LAPTOP_BODY);
  px(ctx, x0 - 0.6, DECK_Y + 2.8, W + 1.2, 1, LAPTOP_DARK);
  // Real (if tiny) keyboard: two rows of keys reads as a laptop; one row of
  // dashes reads as a smudge.
  for (let r = 0; r < 2; r++) {
    for (let k = 0; k < 8; k++) {
      px(ctx, x0 + 1.6 + k * 2.5, DECK_Y + 0.45 + r * 1.05, 1.9, 0.72, LAPTOP_DARK);
    }
  }
  px(ctx, 21.9, DECK_Y + 2.75, 4.2, 0.5, LAPTOP_DARK); // trackpad lip

  // Paws resting on the deck edge, breathing with the phase.
  const lift = Math.sin(legPhase * Math.PI * 2) * 0.4;
  blob(ctx, x0 + 2.6, DECK_Y - 0.5 + lift, 2.4, 1.6, FUR);
  blob(ctx, x0 + W - 2.6, DECK_Y - 0.5 - lift, 2.4, 1.6, FUR);
}

/**
 * A pocket calculator held in both paws for Calc & Time mode.
 *
 * Deliberately smaller and squarer than the work laptop so the two modes are
 * distinguishable at a glance. `legPhase` marches the LCD digits and lights a
 * different key each beat, so an open panel never looks like a frozen sprite.
 */
function drawCalculator(ctx: Ctx, legPhase: number): void {
  const W = 15;
  const H = 17;
  const x0 = 24 - W / 2;
  const y0 = 41.8 - H;

  // Case: body, darker base lip, and a lighter top edge catching the light.
  px(ctx, x0, y0, W, H, CALC_BODY);
  px(ctx, x0, y0, W, 0.6, "#6c7486");
  px(ctx, x0, y0 + H - 1, W, 1, CALC_DARK);

  // LCD, inset in a dark bezel.
  const lcdY = y0 + 1.6;
  px(ctx, x0 + 1.2, lcdY - 0.5, W - 2.4, 4.4, CALC_DARK);
  px(ctx, x0 + 1.8, lcdY, W - 3.6, 3.2, CALC_LCD);
  // Right-aligned digit blocks that shuffle with the phase, so it reads as a
  // running total rather than a static texture.
  const step = Math.floor(((legPhase % 1) + 1) % 1 * 4);
  for (let d = 0; d < 4; d++) {
    const h = d <= step ? 1.9 : 1.2;
    px(ctx, x0 + W - 3.2 - d * 2.1, lcdY + 0.6 + (1.9 - h), 1.4, h, CALC_DIGIT);
  }

  // Keypad: 4x4 grid, with one key lit per beat like a press travelling over it.
  const lit = Math.floor(((legPhase % 1) + 1) % 1 * 16);
  const kx = x0 + 1.6;
  const ky = y0 + 6.6;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const i = r * 4 + c;
      px(ctx, kx + c * 3, ky + r * 2.4, 2.2, 1.7, i === lit ? CALC_KEY_HI : CALC_KEY);
    }
  }

  // Paws gripping either side, breathing with the phase.
  const lift = Math.sin(legPhase * Math.PI * 2) * 0.35;
  blob(ctx, x0 - 0.6, y0 + H - 5 + lift, 2.3, 1.6, FUR);
  blob(ctx, x0 + W + 0.6, y0 + H - 5 - lift, 2.3, 1.6, FUR);
}

/** Design units the cat sinks by so the overhead placard has clear space. */
const PLACARD_CAT_DROP = 7.5;

/**
 * A placard held OVERHEAD in both paws, clear of the face. `legPhase` waves it.
 * Text is abstract ink bars, not glyphs — at 48 design units a real word is a
 * few pixels tall and reads as noise; the message goes in the bubble instead.
 *
 * Drawn AFTER the face (see drawFront) so the raised forelegs pass in front of
 * the head rather than being painted over by it.
 */
function drawPlacard(ctx: Ctx, legPhase: number, headTopY: number): void {
  const wave = Math.sin(legPhase * Math.PI * 2) * 1.4;
  const cxp = 24 + wave;
  const boardW = 21, boardH = 7.4;
  // Sit the board just above the skull, with a small gap so they never merge.
  // Clamped so a tall-eared breed can never push it off the top of the canvas.
  const bottomY = Math.max(boardH + 1, headTopY - 1.4);
  const topY = bottomY - boardH;
  const left = cxp - boardW / 2;

  // Forelegs reach up either side of the head to the board's lower corners.
  for (const d of [-1, 1] as const) {
    const gripX = cxp + d * (boardW / 2 - 2.6);
    const gripY = bottomY + 0.8;
    curvedLimb(ctx, { x: 24 + d * 6.5, y: 32 }, { x: 24 + d * 9.5, y: 22 }, { x: gripX, y: gripY }, 1.55);
    blob(ctx, gripX, gripY, 2.1, 1.7, FUR);
  }

  px(ctx, left - 0.6, topY - 0.6, boardW + 1.2, boardH + 1.2, PLACARD_EDGE);
  px(ctx, left, topY, boardW, boardH, PLACARD_BOARD);
  px(ctx, left + 2.4, topY + 2.2, boardW - 4.8, 1.4, PLACARD_INK);
  px(ctx, left + 4.6, topY + 5.1, boardW - 9.2, 1.2, PLACARD_INK);
}

function drawBook(ctx: Ctx): void {
  tri(ctx, { x: 24, y: 36 }, { x: 16.5, y: 37.6 }, { x: 16.5, y: 42.6 }, PAPER);
  tri(ctx, { x: 24, y: 36 }, { x: 16.5, y: 42.6 }, { x: 24, y: 41.4 }, PAPER);
  tri(ctx, { x: 24, y: 36 }, { x: 31.5, y: 37.6 }, { x: 31.5, y: 42.6 }, PAPER);
  tri(ctx, { x: 24, y: 36 }, { x: 31.5, y: 42.6 }, { x: 24, y: 41.4 }, PAPER);
  px(ctx, 23.6, 36.2, 0.9, 5.4, PAPER_DARK);
  for (let i = 0; i < 2; i++) {
    px(ctx, 18, 38.4 + i * 1.5, 4.6, 0.45, INK);
    px(ctx, 25.5, 38.4 + i * 1.5, 4.6, 0.45, INK);
  }
}

function drawMusicNotes(ctx: Ctx, hx: number, hy: number, phase: number): void {
  const bob = Math.sin(phase * Math.PI * 2) * 1.3;
  const note = (x: number, y: number, color: string) => {
    blob(ctx, x, y + 2.2, 1.05, 0.85, [color]);
    px(ctx, x + 0.8, y - 2.4, 0.6, 4.8, color);
    px(ctx, x + 0.8, y - 2.4, 2, 0.7, color);
  };
  note(hx + 13.2, hy - 8 + bob, HEART);
  note(hx - 14, hy - 3 - bob, ZCOL);
}

function drawHearts(ctx: Ctx, x: number, y: number): void {
  blob(ctx, x, y, 1.2, 1.2, [HEART]);
  blob(ctx, x + 2.1, y, 1.2, 1.2, [HEART]);
  tri(ctx, { x: x - 1.2, y: y + 0.4 }, { x: x + 3.3, y: y + 0.4 }, { x: x + 1, y: y + 3 }, HEART);
}

function drawZzz(ctx: Ctx, x: number, y: number): void {
  px(ctx, x, y, 4, 0.8, ZCOL);
  px(ctx, x + 2.2, y + 1, 1, 0.8, ZCOL);
  px(ctx, x + 1.2, y + 2, 1, 0.8, ZCOL);
  px(ctx, x, y + 3, 4, 0.8, ZCOL);
}

function drawSteam(ctx: Ctx, x: number, y: number): void {
  // Anchored below the top edge: the puffs sit above the head, which on a
  // tall/perked-ear pose put them off the top of the sprite entirely.
  const top = Math.max(y, 1.2);
  blob(ctx, x, top + 3, 1.4, 1.4, [STEAM]);
  blob(ctx, x + 3.4, top + 1.6, 1.7, 1.7, [STEAM]);
  blob(ctx, x + 6.6, top + 3.4, 1.2, 1.2, [STEAM]);
}

/**
 * Coat markings drawn over the body/head. Every pattern here is meant to be
 * obvious at desktop-pet size — thick, high-contrast shapes rather than the
 * near-invisible one-pixel hints these used to be.
 */
function drawStripes(ctx: Ctx, cx: number, cy: number, vertical = false): void {
  switch (pattern) {
    case "tabby": {
      // Bold mackerel stripes: thicker, more of them, in the contrast colour.
      if (vertical) {
        for (const off of [-4.6, -2.3, 0, 2.3, 4.6]) px(ctx, cx + off, cy - 4.2, 1.5, 5.4, MARK[0]);
        for (const off of [-3.5, 3.5]) px(ctx, cx + off, cy + 1.4, 1.4, 2.6, MARK[1]);
      } else {
        for (const off of [-5.4, -2.7, 0, 2.7, 5.4]) px(ctx, cx + off, cy - 3.8, 1.6, 4.4, MARK[0]);
      }
      break;
    }
    case "spotted": {
      // Scattered rosettes, staggered so they don't line up into stripes.
      const spots = vertical
        ? [[-4.2, -3.2], [0.4, -4.6], [4.2, -2.4], [-2.6, 0.8], [2.8, 1.4], [0, 3.4]]
        : [[-5.2, -2.6], [-1.4, -3.8], [2.6, -2.2], [-3.4, 0.9], [1.6, 1.6], [5, 0.2]];
      for (const [ox, oy] of spots) blob(ctx, cx + ox, cy + oy, 1.5, 1.35, MARK);
      break;
    }
    case "calico": {
      // Irregular two-tone patches: one dark, one ginger, plus small speckles.
      blob(ctx, cx - 3.4, cy - 2.6, 3.4, 2.9, MARK);
      blob(ctx, cx + 3.2, cy + 1.2, 3.0, 2.6, MARK2);
      blob(ctx, cx + 2.2, cy - 3.4, 2.1, 1.8, MARK2);
      blob(ctx, cx - 2.0, cy + 2.6, 1.9, 1.6, MARK);
      break;
    }
    case "bicolour": {
      // A single large off-centre patch, like a classic cow-cat.
      blob(ctx, cx - 3.0, cy - 1.4, 4.4, 4.0, MARK);
      blob(ctx, cx + 1.4, cy + 2.6, 2.4, 1.9, MARK);
      break;
    }
    default:
      break; // solid / tuxedo / socks carry no body markings
  }
}

// ==== FRONT VIEW (chibi: huge head, big eyes) =============================
function drawFrontFace(ctx: Ctx, hx: number, hy: number, pose: PoseSpec, threeQuarter = false): void {
  const hrx = (threeQuarter ? 11.2 : 12.3) * SP.head;
  const hry = (threeQuarter ? 10.2 : 11) * SP.head;
  // Lean the whole head unit — skull, ears and face move together, so it reads
  // as the cat turning to look rather than its features sliding around.
  hx += pose.headTurnX * HEAD_LEAN_X;
  hy += pose.headTurnY * HEAD_LEAN_Y;

  drawEar(ctx, hx - hrx * 0.67, hy - hry + 3, -1, pose.ears);
  drawEar(ctx, hx + hrx * 0.67, hy - hry + 3, 1, pose.ears);
  blob(ctx, hx, hy, hrx, hry, FUR);
  // Soft cheek shading + tiny cheek fluff jags.
  blob(ctx, hx - hrx * 0.5, hy + hry * 0.51, 4.2, 2.8, [FUR[1], FUR[2]]);
  blob(ctx, hx + hrx * 0.5, hy + hry * 0.51, 4.2, 2.8, [FUR[1], FUR[2]]);
  tri(ctx, { x: hx - hrx - 0.3, y: hy + 3 }, { x: hx - hrx + 1.4, y: hy + 2 }, { x: hx - hrx + 1.4, y: hy + 4.4 }, FUR[1]);
  tri(ctx, { x: hx + hrx + 0.3, y: hy + 3 }, { x: hx + hrx - 1.4, y: hy + 2 }, { x: hx + hrx - 1.4, y: hy + 4.4 }, FUR[1]);
  // Long-haired breeds get a fluffy cheek mane framing the face.
  if (SP.tufts) {
    for (const s of [-1, 1] as const) {
      for (let i = 0; i < 4; i++) {
        const a = 0.28 + i * 0.24;
        blob(ctx, hx + s * hrx * Math.cos(a) * 1.02, hy + hry * Math.sin(a) * 0.98, 1.9, 1.6, [FUR[0], FUR[1]]);
      }
    }
  }
  drawStripes(ctx, hx, hy - hry * 0.59, true);

  // Widened alongside the larger eyes so they stay two distinct eyes rather
  // than merging into one band on narrow-headed breeds.
  const eyeGap = (threeQuarter ? 5.0 : 5.8) * SP.head;
  // Outer corners point away from the muzzle, so the lashes mirror.
  drawEye(ctx, hx - eyeGap, hy - 0.5, pose, false, -1);
  drawEye(ctx, hx + (threeQuarter ? eyeGap + 1 : eyeGap), hy - 0.5, pose, false, 1);

  blob(ctx, hx, hy + 4.7 * SP.head, 0.9, 0.7, [NOSE]);
  drawMouth(ctx, hx, hy + 6.4 * SP.head, pose.mouth);

  if (pose.eyes !== "closed") {
    // Very subtle short whiskers.
    px(ctx, hx - hrx - 1.6, hy + 2.6, 2, 0.5, WHISKER);
    px(ctx, hx - hrx - 1.2, hy + 4.4, 1.7, 0.5, WHISKER);
    px(ctx, hx + hrx - 0.4, hy + 2.6, 2, 0.5, WHISKER);
    px(ctx, hx + hrx - 0.5, hy + 4.4, 1.7, 0.5, WHISKER);
  }
  if (pose.blush) {
    blob(ctx, hx - hrx * 0.62, hy + 3.8 * SP.head, 1.9, 1, [BLUSH]);
    blob(ctx, hx + hrx * 0.62, hy + 3.8 * SP.head, 1.9, 1, [BLUSH]);
  }
  frontAccessory(ctx, hx, hy, hrx, hry);
  if (pose.steam) drawSteam(ctx, hx - 2, hy - hry - 7);
}

function drawFrontPaws(ctx: Ctx, pose: PoseSpec, by: number): void {
  // These props draw their own forepaws (on a deck, or gripping a handle).
  if (
    pose.prop === "keyboard" ||
    pose.prop === "laptop" ||
    pose.prop === "placard" ||
    pose.prop === "calculator"
  )
    return;
  if (pose.gesture === "cheer") {
    for (const d of [-1, 1] as const) {
      curvedLimb(ctx, { x: 24 + d * 6, y: by }, { x: 24 + d * 10, y: by - 6 }, { x: 24 + d * 11, y: by - 12 }, 1.7);
      blob(ctx, 24 + d * 11, by - 12, 2.2, 1.9, FUR);
    }
    return;
  }
  if (pose.gesture === "clap") {
    // Both paws overhead and TOGETHER: with "cheer" (apart) on the alternate
    // frame this reads as an urgent little clap. Tiny impact ticks sell the hit.
    for (const d of [-1, 1] as const) {
      curvedLimb(ctx, { x: 24 + d * 6, y: by }, { x: 24 + d * 8.5, y: by - 7 }, { x: 24 + d * 1.8, y: by - 12.5 }, 1.7);
      blob(ctx, 24 + d * 1.8, by - 12.5, 2.2, 1.9, FUR);
    }
    px(ctx, 24 - 4.6, by - 15.2, 1.3, 0.55, EYE_SHINE);
    px(ctx, 24 + 3.3, by - 15.2, 1.3, 0.55, EYE_SHINE);
    px(ctx, 24 - 0.6, by - 16.4, 1.2, 0.55, EYE_SHINE);
    return;
  }
  if (pose.gesture === "knead") {
    const leftDown = pose.legPhase < 0.5;
    for (const d of [-1, 1] as const) {
      const down = d === -1 ? leftDown : !leftDown;
      const fy = down ? 43.2 : 41.2;
      curvedLimb(ctx, { x: 24 + d * 4.5, y: by }, { x: 24 + d * 5.4, y: 40 }, { x: 24 + d * 5.6, y: fy }, 1.7);
      blob(ctx, 24 + d * 5.6, fy, 2.5, 1.6, FUR);
      if (down) px(ctx, 24 + d * 5.6 - 1, fy + 1, 2, 0.8, PAW_GLEAM);
    }
    return;
  }
  if (pose.gesture === "pawUp" || pose.gesture === "groom" || pose.gesture === "scratch" || pose.gesture === "swat") {
    const leftRaised = pose.legPhase < 0.5;
    const d = leftRaised ? -1 : 1;
    const target =
      pose.gesture === "scratch" ? { x: 24 + d * 9, y: 22 } : pose.gesture === "swat" ? { x: 24 + d * 8, y: 17 } : { x: 24 + d * 6.5, y: 27 };
    curvedLimb(ctx, { x: 24 + d * 5, y: by }, { x: 24 + d * 8, y: 33 }, target, 1.7);
    blob(ctx, target.x, target.y, 2.2, 1.8, FUR);
    const g = -d;
    curvedLimb(ctx, { x: 24 + g * 4.5, y: by }, { x: 24 + g * 4.5, y: 40 }, { x: 24 + g * 4.5, y: 43.2 }, 1.7);
    blob(ctx, 24 + g * 4.5, 43.2, 2.8, 1.6, FUR);
    return;
  }
  for (const d of [-1, 1] as const) {
    // Foreleg down to the paw. The paws sit on a fixed ground line while the
    // torso height varies by species (a leggy siamese rides higher on a
    // negative bodyDrop), which left them floating clear of the body. The limb
    // starts inside the torso, so it only becomes visible across the gap it fills.
    curvedLimb(ctx, { x: 24 + d * 4.4, y: by }, { x: 24 + d * 4.4, y: 40 }, { x: 24 + d * 4.4, y: 43 }, 1.7);
    if (SOCKED) {
      // White boots: draw the whole front paw pale, not a two-pixel gleam.
      blob(ctx, 24 + d * 4.4, 43, 3, 1.9, SOCK);
      blob(ctx, 24 + d * 4.4, 41.4, 2.3, 1.2, SOCK);
    } else {
      blob(ctx, 24 + d * 4.4, 43, 3, 1.9, FUR);
      px(ctx, 24 + d * 4.4 - 1.4, 44, 1, 0.8, PAW_GLEAM);
      px(ctx, 24 + d * 4.4 + 0.4, 44, 1, 0.8, PAW_GLEAM);
    }
  }
}

function drawHangingFront(ctx: Ctx, pose: PoseSpec): void {
  const sway = Math.sin(pose.legPhase * Math.PI * 2) * 1.2;
  const one = pose.gesture === "hangOne";
  const pulling = pose.gesture === "pull";
  const pawY = pulling ? 7 : 3;
  if (!one) {
    blob(ctx, 18.5 + sway, pawY, 2.8, 1.7, FUR);
    curvedLimb(ctx, { x: 18.5 + sway, y: pawY }, { x: 18.5 + sway, y: 10 }, { x: 19.5 + sway, y: 16 }, 1.6);
  } else {
    curvedLimb(ctx, { x: 17.5 + sway, y: 18 }, { x: 13 + sway, y: 21 }, { x: 12 + sway, y: 26 }, 1.55);
  }
  blob(ctx, 29.5 + sway, pawY, 2.8, 1.7, FUR);
  curvedLimb(ctx, { x: 29.5 + sway, y: pawY }, { x: 29.5 + sway, y: 10 }, { x: 28.5 + sway, y: 16 }, 1.6);
  // Body dangles under the big head.
  blob(ctx, 24 + sway, 34, 7.6, 8.2, FUR);
  drawTail(ctx, { x: 18 + sway, y: 37 }, { x: 10 + sway, y: 39 }, { x: 11.5 + sway, y: 27 });
  for (const d of [-1, 1] as const) {
    curvedLimb(ctx, { x: 24 + d * 4 + sway, y: 39 }, { x: 24 + d * 4.6 + sway, y: 42 }, { x: 24 + d * 4.4 + sway, y: 44.2 }, 1.5);
    blob(ctx, 24 + d * 4.4 + sway, 44.2, 2.2, 1.3, FUR);
  }
  drawFrontFace(ctx, 24 + sway, 20 + pose.headBob, pose);
}

function drawFront(ctx: Ctx, pose: PoseSpec): void {
  if (pose.body === "hang") {
    drawHangingFront(ctx, pose);
    return;
  }

  const hx = 24;
  let hy = 15.5 + pose.headBob;
  let by = 34;
  let brx = 9;
  let bry = 8.8;
  if (pose.body === "loaf") { hy = 18 + pose.headBob; by = 38.5; brx = 12.5; bry = 6; }
  if (pose.body === "dangle") { hy = 14 + pose.headBob; by = 32; brx = 7.6; bry = 8; }
  // The placard is held OVERHEAD, and the head normally reaches design-unit 4.5
  // — leaving no room above it. Drop the whole cat so the board has clear space
  // and does not sit on the face.
  if (pose.prop === "placard") {
    hy += PLACARD_CAT_DROP;
    by += PLACARD_CAT_DROP * 0.5;
  }
  // Species proportions: torso mass and how high the body rides on the legs.
  brx *= SP.bodyW;
  bry *= SP.bodyH;
  if (pose.body !== "dangle") by += SP.bodyDrop;
  hy += SP.bodyDrop * 0.55;
  // The placard drop plus a heavy breed's own bodyDrop pushed chonk straight
  // through the bottom of the sprite. Clamp once the real torso size is known.
  if (pose.prop === "placard") by = Math.min(by, 48 - 1.5 - bry);

  // Long curved tail.
  if (pose.body !== "dangle") {
    if (pose.tail === "wrap" || pose.tail === "tuck") drawTail(ctx, { x: 31, y: 40 }, { x: 38.5, y: 45.5 }, { x: 16.5, y: 44.4 });
    else if (pose.tail === "down") drawTail(ctx, { x: 31.5, y: 39 }, { x: 37, y: 43 }, { x: 40, y: 40 });
    else drawTail(ctx, { x: 31.5, y: 39 }, { x: 41.5, y: 34 }, { x: 38.5, y: 21.5 }, pose.tail === "puff");
  } else {
    drawTail(ctx, { x: 17.5, y: 36 }, { x: 10, y: 39 }, { x: 11.5, y: 26 });
  }

  // Compact soft body + chest.
  blob(ctx, hx, by, brx, bry, BODY);
  blob(ctx, hx, by + 0.6, Math.max(3.6, brx - 3.4), Math.max(2.8, bry - 2.6), CHEST);
  drawStripes(ctx, hx, by + 2, true);
  // Neck: bridges head and torso so they always read as one animal — essential
  // for colour-point breeds where the two masses are different colours.
  //
  // Drawn for EVERY body including dangle. It used to be skipped while dangling
  // (the scruff is pinched, so the neck looked odd), but head lean then pulled
  // the skull clear of the torso and opened a visible gap. A narrower bridge
  // keeps the pinched-scruff read while guaranteeing the silhouette connects.
  {
    const dangling = pose.body === "dangle";
    const headBottom = hy + 11 * SP.head;
    const bodyTop = by - bry;
    // Span the full head->body distance plus overlap at each end, so the bridge
    // cannot fall short however far the head has leaned.
    const midY = (headBottom + bodyTop) / 2;
    const halfSpan = Math.abs(headBottom - bodyTop) / 2 + 2.6;
    blob(ctx, hx, midY, Math.max(dangling ? 3.2 : 4.8, brx * (dangling ? 0.42 : 0.62)), Math.max(3.4, halfSpan), FUR);
  }
  // Long-haired neck ruff spilling over the chest.
  if (SP.ruff && pose.body !== "dangle" && pose.body !== "loaf") {
    for (let i = -3; i <= 3; i++) {
      blob(ctx, hx + i * 2.3, by - bry * 0.72 + Math.abs(i) * 0.55, 2.5, 2.1, [FUR[0], FUR[1]]);
    }
  }

  if (pose.body === "loaf") {
    // Petting lowers the head and flattens the torso. This dedicated ruff
    // overlaps both silhouettes, preventing even a one-pixel transparent gap
    // as headBob changes between the petting and purring frames.
    blob(ctx, hx, 31.2 + pose.headBob * 0.15, 7.2, 4.8, [FUR[0], FUR[1], FUR[2]]);
    blob(ctx, hx, 32.3 + pose.headBob * 0.1, 4.5, 3.4, [CHEST[0], CHEST[1]]);
  }

  if (pose.body === "dangle") {
    for (const x of [19.5, 23, 26.5, 29.5]) {
      curvedLimb(ctx, { x, y: by + 3 }, { x: x + Math.sin(pose.legPhase * Math.PI * 2), y: 40 }, { x, y: 44 }, 1.4);
      blob(ctx, x, 44, 2, 1.3, FUR);
    }
  } else if (pose.body === "loaf") {
    blob(ctx, 19, 43, 3.4, 1.7, FUR);
    blob(ctx, 29, 43, 3.4, 1.7, FUR);
  } else {
    drawFrontPaws(ctx, pose, by + 2);
  }

  // Props sit in front of the body, under the chin.
  if (pose.prop === "notebook") drawNotebook(ctx);
  else if (pose.prop === "keyboard") drawKeyboard(ctx, pose.legPhase);
  else if (pose.prop === "mic") drawMic(ctx, Math.sin(pose.legPhase * Math.PI * 2) * 1.6);
  else if (pose.prop === "laptop") drawLaptop(ctx, pose.legPhase);
  else if (pose.prop === "calculator") drawCalculator(ctx, pose.legPhase);
  else if (pose.prop === "book") drawBook(ctx);
  else if (pose.prop === "bowl") drawBowl(ctx, pose.legPhase);

  drawFrontFace(ctx, hx, hy, pose);
  // After the face: the raised forelegs must pass IN FRONT of the head, and the
  // board sits above it, so both would be overpainted if drawn with the props.
  if (pose.prop === "placard") {
    drawPlacard(ctx, pose.legPhase, hy - 11 * SP.head + pose.headTurnY * HEAD_LEAN_Y);
  }
  if (pose.notes) drawMusicNotes(ctx, hx, hy, pose.legPhase);
  if (pose.hearts) drawHearts(ctx, 37, 5);
  if (pose.zzz) drawZzz(ctx, 36, 6);
}

// ==== SIDE VIEW (chibi) ===================================================
function legMotion(phase: number, stride = 1): { x: number; lift: number } {
  const p = phase - Math.floor(phase);
  const reach = 2 * stride;
  if (p < 0.55) return { x: reach - (p / 0.55) * reach * 2, lift: 0 };
  const t = (p - 0.55) / 0.45;
  return { x: -reach + t * reach * 2, lift: Math.sin(t * Math.PI) * (2.4 + stride * 0.8) };
}

function sideLeg(ctx: Ctx, hipX: number, hipY: number, phase: number, near: boolean, stride = 1): void {
  const motion = legMotion(phase, stride);
  const foot = { x: hipX + motion.x, y: FEET_Y - motion.lift };
  const palette = near ? FUR : FAR_FUR;
  curvedLimb(ctx, { x: hipX, y: hipY }, { x: hipX + motion.x * 0.4, y: hipY + 3 }, foot, near ? 1.8 : 1.5, palette);
  if (SOCKED) {
    // Matching white boot on the side profile, dimmed on the far legs so the
    // near/far depth cue survives.
    blob(ctx, foot.x + 0.6, foot.y, 2.5, 1.5, near ? SOCK : [SOCK[2] ?? SOCK[0]]);
    blob(ctx, foot.x + 0.4, foot.y - 1.4, 1.8, 1.1, near ? SOCK : [SOCK[2] ?? SOCK[0]]);
  } else {
    blob(ctx, foot.x + 0.6, foot.y, 2.5, 1.5, palette);
    if (near) px(ctx, foot.x - 0.4, foot.y + 1, 1.8, 0.8, PAW_GLEAM);
  }
}

function drawSideTail(ctx: Ctx, pose: PoseSpec, root: Pt): void {
  switch (pose.tail) {
    case "down":
      drawTail(ctx, root, { x: root.x - 6, y: root.y + 7 }, { x: root.x - 10, y: 41 });
      break;
    case "flick":
      drawTail(ctx, root, { x: root.x - 9, y: root.y - 6 }, { x: root.x - 9.5, y: 15 });
      break;
    case "tuck":
    case "wrap":
      drawTail(ctx, root, { x: root.x - 1, y: 44 }, { x: root.x + 10, y: 43.4 });
      break;
    case "puff":
      drawTail(ctx, root, { x: root.x - 9, y: root.y - 7 }, { x: root.x - 5.5, y: 13 }, true);
      break;
    default:
      // Long elegant curve rising behind the back (reference silhouette).
      drawTail(ctx, root, { x: root.x - 8.5, y: root.y - 9 }, { x: root.x - 2.5, y: 12.5 });
  }
}

function drawSide(ctx: Ctx, pose: PoseSpec): void {
  const gait = Math.sin(pose.legPhase * Math.PI * 2);
  let bx = 17.5;
  let by = 34.5 - Math.max(0, gait) * 0.6;
  let brx = 9.6;
  let bry = 7;
  let hx = 31;
  let hy = 21.5 + pose.headBob - Math.max(0, gait) * 0.4;
  let hrx = 10.2;
  let hry = 9.6;

  if (pose.gesture === "wiggle") bx -= Math.sin(pose.legPhase * Math.PI * 2) * 1.3;
  if (pose.body === "crouch") { by = 37; bry = 5.4; brx = 11; hx = 32; hy = 24 + pose.headBob; }
  if (pose.body === "air") { bx = 16.5; by = 31; brx = 11; bry = 5.8; hx = 33; hy = 19 + pose.headBob; }
  if (pose.body === "lie") { bx = 19; by = 40; brx = 12.5; bry = 4.2; hx = 33; hy = 32 + pose.headBob; hrx = 9; hry = 8.4; }
  if (pose.body === "sit") { bx = 20.5; by = 34.5; brx = 8.3; bry = 9.2; hx = 27.5; hy = 20 + pose.headBob; }
  if (pose.body === "stretch") {
    // The real cat stretch is a play-bow: chest sinks to the floor, hips stay
    // high, the spine arches, and the front legs reach a long way forward.
    // `legPhase` drives how deep the bow is, 0 = standing, 1 = fully folded.
    const reach = Math.max(0, Math.min(1, pose.legPhase));
    bx = 15 + reach * 1.5;
    by = 32.5 - reach * 1.5; // hips ride UP as the chest goes down
    brx = 11.5;
    bry = 5.8;
    // Kept deliberately conservative: the head is the widest, tallest mass on
    // the cat, so pushing it much further forward/down runs the skull off the
    // bottom-right of the sprite on big-headed breeds (chonk, kitten).
    hx = 33 + reach * 2;
    hy = 30 + reach * 5 + pose.headBob;
  }

  // Species proportions. The torso grows/shrinks, the whole cat rides lower on
  // short legs, and the head scales with the breed's head trait.
  brx *= SP.bodyW;
  bry *= SP.bodyH;
  hrx *= SP.head;
  hry *= SP.head;
  // `bodyDrop` models SHORT LEGS, so it only applies while the cat is up on
  // them. A lying cat is already on the floor; adding the drop there pushed
  // low-slung breeds (chonk, kitten) straight through the bottom of the sprite.
  if (pose.body !== "lie") {
    by += SP.bodyDrop;
    hy += SP.bodyDrop;
  }
  // Keep the muzzle from drifting off a smaller/larger skull.
  hx += (SP.head - 1) * 2.2;

  // Head lean is added BEFORE the clamps below, so those clamps genuinely run
  // last and bound the final head position. It previously came after them, and
  // the lean escaped the stretch clamp entirely — invisible while the lean
  // maxed out at 1.15 units and the margin absorbed it, but the moment the
  // range grew to +-2 the bowing muzzle ran off the right edge on kitten and
  // fluffy. Still ahead of the shoulder->jaw sweep derived below, so the neck
  // follows and the head never looks detached.
  hx += pose.headTurnX * HEAD_LEAN_X;
  hy += pose.headTurnY * HEAD_LEAN_Y;

  if (pose.body === "stretch") {
    // The bow pushes the head down and forward, and breed scaling (bigger
    // skulls, lower bodies) is applied above — so clamp once the real head
    // size AND lean are known, or chonk/kitten run off the bottom-right corner.
    const margin = 2;
    hy = Math.min(hy, 48 - margin - hry);
    hx = Math.min(hx, 48 - margin - hrx);
    hx = Math.max(hx, margin + hrx);
  }
  if (pose.body === "lie") {
    // Low-slung breeds (chonk, kitten) carry a large bodyDrop that pushed the
    // lying silhouette through the bottom of the sprite.
    by = Math.min(by, 48 - 1.5 - bry);
  }

  // Curled-up sleeping ball.
  if (pose.body === "lie" && pose.eyes === "closed") {
    const breath = Math.max(0, pose.headBob) * 0.45;
    // Rounded ribcage and haunch make a recognisable curled sleeping cat. The
    // curl scales with the breed so a chonk sleeps rounder than a kitten.
    const cw = SP.bodyW;
    const ch = SP.bodyH;
    blob(ctx, 25, 37.6 - breath, 12.8 * cw, (7.5 + breath * 0.25) * ch, BODY);
    blob(ctx, 31, 37.2 - breath, 7.2 * cw, 7.2 * ch, BODY);
    blob(ctx, 16, 36.5 - breath * 0.35, 7.5 * SP.head, 6.5 * SP.head, FUR);
    // Two relaxed ears, a resting muzzle, closed eye and tucked forepaws.
    const earY = 32.2 - breath * 0.35;
    tri(ctx, { x: 11.5, y: earY + 0.8 }, { x: 15.2, y: earY + 0.8 }, { x: 13.2, y: earY - 3 }, FUR[2]);
    tri(ctx, { x: 12.5, y: earY }, { x: 14.3, y: earY }, { x: 13.2, y: earY - 2 }, EAR_DARK);
    tri(ctx, { x: 16, y: earY + 0.4 }, { x: 19.8, y: earY + 0.4 }, { x: 18.1, y: earY - 3.3 }, FUR[2]);
    tri(ctx, { x: 17, y: earY - 0.2 }, { x: 18.9, y: earY - 0.2 }, { x: 18.1, y: earY - 2.2 }, EAR_DARK);
    blob(ctx, 10.2, 38 - breath * 0.35, 2.6, 2, FUR);
    blob(ctx, 8.7, 37.5 - breath * 0.35, 0.7, 0.6, [NOSE]);
    stroke(ctx, { x: 12.2, y: 35.8 - breath * 0.35 }, { x: 14, y: 37 - breath * 0.35 }, { x: 15.8, y: 35.8 - breath * 0.35 }, 0.55, FUR[3]);
    blob(ctx, 14.5, 41.6, 4.8, 1.7, FUR);
    // Tail wraps across the front like a soft blanket instead of disappearing
    // behind an indistinct oval.
    drawTail(ctx, { x: 33, y: 39.2 }, { x: 29, y: 45.2 }, { x: 15, y: 42 }, false);
    if (pose.zzz) {
      drawZzz(ctx, 9.5, 25.5 - breath);
      px(ctx, 15.2, 24 - breath, 2.4, 0.7, ZCOL);
    }
    return;
  }

  drawSideTail(ctx, pose, { x: bx - brx + 2.5, y: by - 2 });

  const hipY = by + bry - 3;
  // Far legs.
  if (pose.body === "air") {
    sideLeg(ctx, bx - 4, hipY, 0.2, false);
    sideLeg(ctx, bx + 6, hipY, 0.75, false);
  } else if (pose.body !== "lie" && pose.body !== "sit") {
    sideLeg(ctx, bx - 4.5, hipY, pose.legPhase + 0.5, false, pose.stride);
    sideLeg(ctx, bx + 6, hipY, pose.legPhase, false, pose.stride);
  }

  // Soft compact body: haunch + chest, sized by the breed's torso traits.
  // During a stretch the two ends pull apart vertically — raised haunches at
  // the back, chest pressed to the floor at the front — and a curved spine
  // bridges them, which is what makes the bow read as a real stretch rather
  // than a flat oval.
  const bow = pose.body === "stretch" ? Math.max(0, Math.min(1, pose.legPhase)) : 0;
  const haunchY = by - bow * 2.6;
  const chestY = by + 0.4 + bow * 6.2;
  blob(ctx, bx - 3, haunchY, 7.2 * SP.bodyW, bry + bow * 1.2, BODY);
  blob(ctx, bx + 4, chestY, 6.5 * SP.bodyW, bry - 0.4 - bow * 1.4, BODY);
  if (bow > 0.05) {
    // Arched back sweeping from the raised hips down to the sunken shoulders.
    curvedLimb(
      ctx,
      { x: bx - 4, y: haunchY - bry * 0.5 },
      { x: bx + 1, y: haunchY - bry * 0.5 - bow * 1.8 },
      { x: bx + 8.5, y: chestY - bry * 0.35 },
      3.1 + bow * 0.6,
      BODY,
    );
  }
  blob(ctx, bx + 1, by - 1.6 + bow * 3, brx - 2.5, Math.max(2.6, bry - 2.6), CHEST);
  drawStripes(ctx, bx, by - 1 + bow * 2);
  // Long-haired breeds carry a plush ruff over the shoulders in profile.
  if (SP.ruff) {
    for (let i = -2; i <= 2; i++) {
      blob(ctx, bx + 5.5 + i * 1.5, by - bry * 0.55 + Math.abs(i) * 0.5, 2.6, 2.2, [FUR[0], FUR[1]]);
    }
  }

  if (pose.body === "sit") {
    blob(ctx, bx - 2.5, 40.5, 7, 5, FUR);
    blob(ctx, bx + 5.5, 43.2, 3.6, 1.9, FUR);
    px(ctx, bx + 4.5, 44.2, 2.6, 0.8, PAW_GLEAM);
  } else if (pose.body === "lie") {
    blob(ctx, 30, 43.4, 4.4, 1.7, FUR);
  } else if (pose.body === "stretch") {
    // Front legs reach a long way forward and go flat, paws splayed out ahead
    // of the muzzle — the give-away shape of a proper stretch.
    const reach = Math.max(0, Math.min(1, pose.legPhase));
    const shoulderX = bx + 8;
    const shoulderY = chestY - 1.2;
    for (const [dx, w] of [
      [0, 1.85],
      [3.2, 1.6],
    ] as const) {
      // Clamped so the outstretched paws stay inside the sprite on wide breeds.
      const pawX = Math.min(41.5, 32.5 + dx + reach * 4);
      curvedLimb(
        ctx,
        { x: shoulderX + dx * 0.5, y: shoulderY },
        { x: (shoulderX + pawX) / 2, y: shoulderY + 2.4 + reach * 1.6 },
        { x: pawX, y: FEET_Y - 0.4 },
        w,
      );
      blob(ctx, pawX + 0.8, FEET_Y - 0.3, 2.6 + reach * 0.8, 1.5, FUR);
      if (reach > 0.5) px(ctx, pawX - 0.2, FEET_Y + 0.7, 2, 0.8, PAW_GLEAM);
    }
  } else {
    sideLeg(ctx, bx - 3.5, hipY, pose.body === "air" ? 0.65 : pose.legPhase, true, pose.stride);
    if (pose.gesture === "pawUp" || pose.gesture === "swat") {
      const high = pose.gesture === "swat";
      curvedLimb(ctx, { x: bx + 6, y: by + 1 }, { x: bx + 10, y: by - (high ? 5 : 1) }, { x: bx + 13, y: high ? 21 : 28 }, 1.7);
      blob(ctx, bx + 13, high ? 21 : 28, 2.2, 1.8, FUR);
    } else {
      sideLeg(ctx, bx + 6, hipY, pose.body === "air" ? 0.1 : pose.legPhase + 0.5, true, pose.stride);
    }
  }

  // Broad shoulder-to-jaw sweep. The previous circular connector formed a
  // thin vertical stalk in profile; this overlapping sloped mass reads as a
  // real feline shoulder, chest and short neck while keeping the chibi head.
  const shoulder = { x: bx + brx * 0.5, y: by - 0.2 };
  const jawBase = { x: hx - hrx * 0.42, y: hy + hry * 0.42 };
  curvedLimb(
    ctx,
    shoulder,
    { x: (shoulder.x + jawBase.x) / 2 - 0.8, y: (shoulder.y + jawBase.y) / 2 },
    jawBase,
    pose.body === "sit" ? 5.5 : 5.1,
    [FUR[0], FUR[1], FUR[2]],
  );
  blob(ctx, shoulder.x - 0.8, shoulder.y + 0.8, 5.8, 6.2, [FUR[0], FUR[1], FUR[2]]);
  drawEar(ctx, hx - 4.2, hy - hry + 2.6, -1, pose.ears);
  drawEar(ctx, hx + 4.2, hy - hry + 2.6, 1, pose.ears);
  blob(ctx, hx, hy, hrx, hry, FUR);
  // Tiny muzzle bump + nose + smile.
  blob(ctx, hx + hrx - 2, hy + 3, 2.8, 2.2, FUR);
  blob(ctx, hx + hrx - 0.6, hy + 2.4, 0.8, 0.65, [NOSE]);
  stroke(ctx, { x: hx + hrx - 2.6, y: hy + 4.4 }, { x: hx + hrx - 1.4, y: hy + 5.2 }, { x: hx + hrx - 0.2, y: hy + 4.2 }, 0.4, MOUTH);

  drawEye(ctx, hx + 3.3, hy - 0.8, pose, true, 1);
  if (pose.eyes !== "closed") px(ctx, hx + hrx - 0.6, hy + 4.6, 1.9, 0.5, WHISKER);
  if (pose.blush) blob(ctx, hx + 2.2, hy + 4.4, 1.7, 0.9, [BLUSH]);
  sideAccessory(ctx, hx, hy, hrx, hry, { x: bx + 6, y: pose.body === "sit" ? 39.3 : 38.5 });
  if (pose.steam) drawSteam(ctx, hx - 3, hy - hry - 6);
  if (pose.hearts) drawHearts(ctx, hx + 3, hy - hry - 5);
}

// ==== BACK VIEW ===========================================================
function drawBack(ctx: Ctx, pose: PoseSpec): void {
  if (pose.body === "climb") {
    const sway = Math.sin(pose.legPhase * Math.PI * 2) * 1.4;
    drawTail(ctx, { x: 24 + sway, y: 38 }, { x: 31 + sway, y: 34 }, { x: 30 + sway, y: 21 });
    blob(ctx, 24 + sway, 31, 8, 10.5, FUR);
    drawEar(ctx, 17.5 + sway, 9.5, -1, pose.ears);
    drawEar(ctx, 30.5 + sway, 9.5, 1, pose.ears);
    blob(ctx, 24 + sway, 14.5 + pose.headBob, 10.5, 9.4, FUR);
    const phase = pose.legPhase < 0.5 ? 0 : 1;
    const paws = phase === 0 ? [{ x: 15, y: 18 }, { x: 33, y: 25 }, { x: 17, y: 38 }, { x: 31, y: 42.6 }] : [{ x: 15, y: 25 }, { x: 33, y: 18 }, { x: 17, y: 42.6 }, { x: 31, y: 38 }];
    // Hind legs. Whichever hind paw is at the bottom of the climb cycle reaches
    // past the torso ellipse, so without a limb it renders as a floating blob.
    for (const paw of paws.slice(2)) {
      curvedLimb(ctx, { x: 24 + sway, y: 34 }, { x: (24 + paw.x) / 2 + sway, y: (34 + paw.y) / 2 }, { x: paw.x + sway, y: paw.y }, 1.6);
    }
    for (const paw of paws) blob(ctx, paw.x + sway, paw.y, 2.6, 1.7, FUR);
    return;
  }
  const drop = SP.bodyDrop;
  drawTail(ctx, { x: 28, y: 39 + drop }, { x: 37.5, y: 37 + drop }, { x: 36.5, y: 23 }, pose.tail === "puff");
  blob(ctx, 24, 35.5 + drop, 10 * SP.bodyW, 8.6 * SP.bodyH, BODY);
  blob(ctx, 19, 39 + drop, 6.2 * SP.bodyW, 5.2 * SP.bodyH, BODY);
  blob(ctx, 29, 39 + drop, 6.2 * SP.bodyW, 5.2 * SP.bodyH, BODY);
  blob(ctx, 18.5, 43.4, 3.6, 1.8, FUR);
  blob(ctx, 29.5, 43.4, 3.6, 1.8, FUR);
  const hs = SP.head;
  drawEar(ctx, 24 - 7.5 * hs, 8.8 + drop * 0.55, -1, pose.ears);
  drawEar(ctx, 24 + 7.5 * hs, 8.8 + drop * 0.55, 1, pose.ears);
  blob(ctx, 24, 15.5 + pose.headBob + drop * 0.55, 11.6 * hs, 10.4 * hs, FUR);
  blob(ctx, 24, 31 + drop, 6, 6.6, CHEST);
  drawStripes(ctx, 24, 33 + drop, true);
  if (seasonalAccessory(ctx, 24, 15.5 + pose.headBob + drop * 0.55, 11.6 * hs, 10.4 * hs, 1)) return;
  if (accessory === "headphones") {
    stroke(ctx, { x: 13, y: 15.5 }, { x: 24, y: 1.8 }, { x: 35, y: 15.5 }, 1.45, PHONES_DARK);
    stroke(ctx, { x: 13, y: 15.5 }, { x: 24, y: 1.8 }, { x: 35, y: 15.5 }, 0.7, PHONES);
    blob(ctx, 12.8, 17, 2.7, 3.8, [PHONES, PHONES_DARK]);
    blob(ctx, 35.2, 17, 2.7, 3.8, [PHONES, PHONES_DARK]);
  } else if (accessory === "bandana") {
    stroke(ctx, { x: 16.5, y: 24 }, { x: 24, y: 26 }, { x: 31.5, y: 24 }, 1.25, BANDANA_DARK);
    stroke(ctx, { x: 17, y: 23.7 }, { x: 24, y: 25.5 }, { x: 31, y: 23.7 }, 0.7, BANDANA);
    tri(ctx, { x: 19, y: 25 }, { x: 27, y: 25 }, { x: 22, y: 32 }, BANDANA);
  } else if (accessory === "hat") {
    px(ctx, 18, 1.2, 12, 6.2, HAT);
    px(ctx, 18, 5.5, 12, 1.4, BANDANA);
    px(ctx, 15.5, 6.8, 17, 2, HAT_DARK);
  } else if (accessory === "cap") {
    blob(ctx, 23, 6, 8, 4.2, [CAP_LIGHT, CAP]);
    px(ctx, 15, 7.3, 16, 1.8, CAP);
  }
}

// ==== THREE-QUARTER =======================================================
function drawThreeQuarter(ctx: Ctx, pose: PoseSpec): void {
  const drop = SP.bodyDrop;
  const hx = 26.5;
  const hy = 16.5 + pose.headBob + drop * 0.55;
  const by = 36 + drop;
  const brx = 8.8 * SP.bodyW;
  const bry = 7.6 * SP.bodyH;
  drawTail(ctx, { x: 16, y: 39 + drop }, { x: 7.5, y: 38 + drop }, { x: 9.5, y: 24 }, pose.tail === "puff");
  blob(ctx, 23, by, brx, bry, BODY);
  blob(ctx, 19.5, 40 + drop, 6 * SP.bodyW, 4.6 * SP.bodyH, BODY);
  // Forelegs down to the paws, for the same reason as the front view: the paws
  // sit on a fixed ground line the raised torso of a leggy breed cannot reach.
  for (const pawX of [18.5, 28]) {
    curvedLimb(ctx, { x: pawX, y: by }, { x: pawX, y: 41 }, { x: pawX, y: 43.4 }, 1.6);
    blob(ctx, pawX, 43.4, 3.2, 1.7, FUR);
  }
  // Neck bridge, same as the front view: the head sits higher here than the
  // torso reaches, so without it the silhouette breaks into two floating masses
  // mid-turn. Drawn before the face so the muzzle overlaps it.
  {
    const headBottom = hy + 10.2 * SP.head;
    const bodyTop = by - bry;
    const midY = (headBottom + bodyTop) / 2;
    const halfSpan = Math.abs(headBottom - bodyTop) / 2 + 2.6;
    blob(ctx, (hx + 23) / 2, midY, Math.max(4.8, brx * 0.62), Math.max(3.4, halfSpan), FUR);
  }
  drawFrontFace(ctx, hx, hy, pose, true);
}

// ---- assembly ------------------------------------------------------------
/** Cold blanch for panic, muted blue-grey for sad. */
const TINT_TARGET: Record<Exclude<CatTint, "none">, { colour: string; amount: number }> = {
  // Deliberately light: enough that the coat visibly cools, not so much that
  // the cat stops looking like itself.
  panic: { colour: "#dcecff", amount: 0.16 },
  sad: { colour: "#6c7796", amount: 0.16 },
};

/**
 * Wash the coat palettes for an emotional state, returning a restore function.
 * The palettes are module-level mutables shared by every draw helper, so this
 * swaps them for the frame rather than threading a tint through ~40 call sites.
 */
function applyTint(tint: CatTint): (() => void) | null {
  if (tint === "none") return null;
  const { colour, amount } = TINT_TARGET[tint];
  const saved = { FUR, FAR_FUR, CHEST, BODY };
  const wash = (pal: string[]) => pal.map((c) => mixHex(c, colour, amount));
  const bodyWasFur = BODY === FUR;
  FUR = wash(saved.FUR);
  FAR_FUR = wash(saved.FAR_FUR);
  CHEST = wash(saved.CHEST);
  // Colour-point breeds keep a separate BODY; everything else aliases FUR, and
  // re-washing the same array twice would double the shift.
  BODY = bodyWasFur ? FUR : wash(saved.BODY);
  return () => {
    FUR = saved.FUR;
    FAR_FUR = saved.FAR_FUR;
    CHEST = saved.CHEST;
    BODY = saved.BODY;
  };
}

function drawCat(pose: PoseSpec): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = ART;
  canvas.height = ART;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, ART, ART);
  // Resolve the tail's live sway for this frame. A sleeping cat's tail only
  // barely stirs; a curled/tucked tail moves less than a raised one.
  TAIL_SWAY = Math.sin((pose.tailPhase / TAIL_PHASE_STEPS) * Math.PI * 2);
  TAIL_ENERGY =
    pose.eyes === "closed" && (pose.body === "lie" || pose.body === "loaf")
      ? 0.3
      : pose.tail === "wrap" || pose.tail === "tuck"
        ? 0.5
        : pose.tail === "flick"
          ? 1.35
          : 1;
  const restoreTint = applyTint(pose.tint);
  try {
    if (pose.view === "side") drawSide(ctx, pose);
    else if (pose.view === "back") drawBack(ctx, pose);
    else if (pose.view === "threeQuarter") drawThreeQuarter(ctx, pose);
    else drawFront(ctx, pose);
  } finally {
    // Must restore even if a draw helper throws, or every later frame renders
    // with the washed palette.
    restoreTint?.();
  }
  return canvas;
}

/**
 * Bounded LRU of rasterised frames.
 *
 * This MUST stay capped. The pose space is far larger than it looks: ~200 base
 * animation frames multiply by live pupil positions and the tail phase, giving
 * thousands of reachable poses. An unbounded cache grew to hundreds of MB of
 * canvas backing store over a session and eventually wedged the webview.
 *
 * A miss is cheap (one 96x96 procedural draw), so a modest cap costs almost
 * nothing: the working set for any given moment is a handful of frames.
 */
/**
 * Measured: a cache hit costs ~0.001ms, a miss ~2.7ms to rasterise. At 60fps
 * (16.7ms budget) the occasional miss is fine, so this only needs to cover the
 * working set — one animation's tweened frames across the current tail/pupil
 * range.
 *
 * The browser's GPU-backed allocation per small canvas is substantially larger
 * than its raw RGBA payload. Runtime profiling therefore keeps this default in
 * line with the measured high-quality cap rather than allowing 1024 separate
 * GPU surfaces.
 */
// Mutable so the app can shrink it on weak machines (each entry is a
// ART x ART x 4-byte canvas surface — at 128px that is ~64KB apiece, so 1024
// entries is ~64MB of GPU-backed memory. Low-spec machines set this far lower).
let CACHE_LIMIT = 192;
const frameCache = new Map<string, HTMLCanvasElement>();

/** Evict the oldest entries until the cache is within `limit`. */
function trimCache(limit: number): void {
  const excess = frameCache.size - limit;
  if (excess <= 0) return;
  let n = 0;
  for (const [k, c] of frameCache) {
    if (n++ >= excess) break;
    c.width = 0; // release the backing store; dropping the ref alone lingers
    c.height = 0;
    frameCache.delete(k);
  }
}

/** Adjust the cache cap at runtime and evict immediately if now over it. */
export function setSpriteCacheLimit(limit: number): void {
  CACHE_LIMIT = Math.max(64, Math.floor(limit));
  trimCache(CACHE_LIMIT);
}

/** Signature of the current palette/species/accessory; part of every key. */
let appearanceKey = "default";
/**
 * Bumped whenever appearance changes. The renderer folds this into its
 * "did anything change since the last frame?" check so an accessory swap still
 * forces a redraw even though the pose is identical.
 */
let appearanceEpoch = 0;
export function spriteEpoch(): number {
  return appearanceEpoch;
}

function keyFor(pose: PoseSpec): string {
  return [
    appearanceKey,
    pose.view,
    pose.body,
    pose.legPhase.toFixed(2),
    pose.eyes,
    pose.ears,
    pose.tail,
    pose.tailPhase,
    pose.headBob,
    pose.stride,
    pose.gesture,
    pose.pupilX,
    pose.pupilY,
    pose.headTurnX,
    pose.headTurnY,
    pose.mouth,
    pose.tint,
    pose.prop,
    pose.notes ? 1 : 0,
    pose.blush ? 1 : 0,
    pose.steam ? 1 : 0,
    pose.hearts ? 1 : 0,
    pose.zzz ? 1 : 0,
  ].join("|");
}

export function renderFrame(pose: PoseSpec): HTMLCanvasElement {
  const key = keyFor(pose);
  const cached = frameCache.get(key);
  if (cached) {
    // Re-insert to mark as most-recently-used (Map preserves insertion order).
    frameCache.delete(key);
    frameCache.set(key, cached);
    return cached;
  }
  const canvas = drawCat(pose);
  frameCache.set(key, canvas);
  trimCache(CACHE_LIMIT);
  return canvas;
}

/** The cap itself, so the regression test asserts the real bound not a copy. */
export function spriteCacheLimit(): number {
  return CACHE_LIMIT;
}

/** Current number of cached frames (used by the cache-bound regression test). */
export function spriteCacheSize(): number {
  return frameCache.size;
}

export function clearSpriteCache(): void {
  for (const c of frameCache.values()) {
    c.width = 0;
    c.height = 0;
  }
  frameCache.clear();
}

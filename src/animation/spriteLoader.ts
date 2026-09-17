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
/**
 * Design space is 48 units; S is the design-unit -> pixel scale for the frame
 * being drawn. It follows the size the frame will be SHOWN at (see drawCat):
 * drawing at 128 and nearest-scaling to 88 dropped every third row and column,
 * so outlines came and went and the pixels looked unevenly sized.
 */
export let S = ART / 48;

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
  | "angry"
  // ---- emotion engine (Paper) ----
  /** Relaxed, lids lowered and lower lids lifted: the slow-blink "I like you". */
  | "soft"
  /** Heavy, flat upper lids - the side-eye and the smug "really?". */
  | "smug"
  /** Lids closing from above AND below: a suspicious slit. */
  | "narrow"
  /** Open, with a wet shine along the lower lid: about to cry. */
  | "watery"
  /** Big pupils: captivated (a butterfly at the nose) or adoring. */
  | "dilated"
  /** Star highlights: excited, victorious. */
  | "sparkle";

/**
 * Brows, drawn as short strokes above the eyes (front views). Separate from
 * the eye state so a feeling can combine them: worried brows over watery
 * eyes, one raised brow over a smug lid.
 */
export type BrowState = "none" | "worried" | "sad" | "angry" | "raised" | "soft";

/**
 * Whole-sprite colour shift. Part of the cache key, so keep the set small.
 * `panic` adds a warm exertion flush; `sad` desaturates it slightly.
 */
export type CatTint = "none" | "panic" | "sad";
/**
 * `down`: both ears lowered out to the sides (sad "airplane" ears).
 * `forward`: perked and tipped in (curious). `asym`: one perked, one back
 * (confused, suspicious) - the one state where the two ears differ.
 */
export type EarState = "up" | "back" | "perk" | "flat" | "down" | "forward" | "asym";
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
  | "clap"
  // ---- gesture controller (Paper): one-paw and paw-to-face gestures ----
  | "victory"
  | "waveA"
  | "waveB"
  | "highFive"
  | "thumbsUp"
  | "point"
  | "shrug"
  | "facepalm"
  | "wipe"
  | "cover"
  | "chin"
  | "salute"
  | "pawHeart"
  | "dismiss"
  | "stompUp"
  | "stompDown"
  | "reachL"
  | "reachR"
  /** Behind the Edgy gestures setting, off by default (see emotion/gestures.ts). */
  | "middle";
export type MouthState = "none" | "smile" | "open" | "yawn" | "frown" | "teeth" | "smirk" | "wobble" | "tongue" | "grin" | "o" | "flat";
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
  // ---- emotion engine (Paper). All discrete or quantised: each is a cache key. ----
  /** Head roll in degrees, a multiple of HEAD_TILT_STEP within ±HEAD_TILT_MAX. Front views. */
  headTilt: number;
  brow: BrowState;
  /** Crying, 0..TEAR_STAGES: 0 none, 1 watery, 2-3 a tear forming, 4-6 falling. */
  tears: number;
  sweat: boolean;
  /** The little popping-vein mark of real irritation. */
  anger: boolean;
  sparkle: boolean;
}

/** Head tilt is quantised to this many degrees (a cache multiplier). */
export const HEAD_TILT_STEP = 2;
/** Beyond this a cat's head stops looking attached. */
export const HEAD_TILT_MAX = 16;
export const TEAR_STAGES = 6;

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
  headTilt: 0,
  brow: "none",
  tears: 0,
  sweat: false,
  anger: false,
  sparkle: false,
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
  | "earStuds"
  | "faceMask"
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
/** Tears and sweat: a light fill inside a deeper edge, so they read on white fur and black fur alike. */
const TEAR = "#a8e0ff";
const TEAR_EDGE = "#3f8fd4";
const ANGER_MARK = "#ff4d5e";
const SPARKLE = "#ffe27a";
/** Paw pads, shown when a palm faces out (high five, wave). */
const PAD = "#f0a0b4";
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
const GLASS_RIM = "#c9a15e";
const GLASS_GLINT = "#bcd3e8";
const BANDANA = "#e34f62";
const BANDANA_DARK = "#7b2635";
const WATCH_STRAP = "#3c465b";
const WATCH_FACE = "#72e2eb";
const HAT = "#654329";
const HAT_DARK = "#2d2018";
const CAP = "#496fc5";
const STUD = "#e9b949";
const STUD_DARK = "#a77c1e";
const MASK_FACE = "#cfe6f2";
const MASK_FOLD = "#9dc0d4";
const MASK_EDGE = "#eaf4fa";
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
  // Read back below: a software canvas. At 256 px and up Chromium puts 2D
  // canvases on the GPU, and each getImageData became a GPU readback.
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
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
/**
 * The skull ellipse drawFrontFace actually draws, before species scaling.
 *
 * Named here rather than buried in the drawing code because the anchors have
 * to report the same numbers; the two drifting apart is what put an eyewear
 * costume a third too small on the face.
 */
export const FRONT_SKULL_RX = 12.3;
export const FRONT_SKULL_RY = 11;
export const TQ_SKULL_RX = 11.2;
export const TQ_SKULL_RY = 10.2;

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


/** Each ear's state: `asym` perks the left ear and lays the right one back. */
function earPair(state: EarState): [EarState, EarState] {
  return state === "asym" ? ["perk", "back"] : [state, state];
}

function drawEar(ctx: Ctx, cx: number, baseY: number, direction: number, state: EarState): void {
  if (state === "asym") state = "perk"; // views that draw one ear, or both the same way
  if (state === "flat" || state === "back") {
    const sign = direction || 1;
    tri(ctx, { x: cx - 3, y: baseY }, { x: cx + 3, y: baseY + 1 }, { x: cx + sign * 4.6, y: baseY - 1.6 }, FUR[2]);
    return;
  }
  if (state === "down") {
    // Sad "airplane" ears: lowered out to the sides, tips below the base line,
    // inner ear still showing so they read as ears and not as a flat head.
    const sign = direction || 1;
    const tip = { x: cx + sign * 6.2, y: baseY + 1.8 };
    tri(ctx, { x: cx - 2.6 * sign, y: baseY - 0.6 }, { x: cx + 1.2 * sign, y: baseY + 2.4 }, tip, FUR[2]);
    tri(ctx, { x: cx - 0.8 * sign, y: baseY + 0.3 }, { x: cx + 1 * sign, y: baseY + 1.8 }, { x: tip.x - sign * 1.4, y: tip.y - 0.4 }, EAR_DARK);
    return;
  }
  // Clamp to the headroom above the skull: the siamese's tall ears (1.4x) were
  // having their tips sliced off by the top of the sprite on many poses.
  const tall = state === "perk" || state === "forward";
  const height = Math.min(baseY - 1.5, (tall ? 7 : 6.2) * SP.ear);
  const halfW = 3.4 * (SP.ear > 1.15 ? 1.08 : 1); // tall ears widen a little too
  // Curious ears tip IN toward the thing being watched; normal ones flare out.
  const tipX = cx + direction * (state === "forward" ? -0.9 : 0.8);
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

/**
 * The skull being drawn, so eyelids can be filled with the head's OWN shading.
 * Filled with one flat fur tone, a lid showed as a pale bar across a shaded
 * forehead. Set by the face painters for the duration of the face.
 */
let LID_HEAD: { cx: number; cy: number; rx: number; ry: number } | null = null;

/** A lid rectangle (design units) in the head's shading. */
function skinRect(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  if (!LID_HEAD) {
    px(ctx, x, y, w, h, FUR[1]);
    return;
  }
  const { cx, cy, rx, ry } = LID_HEAD;
  const x0 = Math.round(x * S), y0 = Math.round(y * S);
  const x1 = x0 + Math.max(1, Math.round(w * S)), y1 = y0 + Math.max(1, Math.round(h * S));
  for (let py = y0; py < y1; py++) {
    for (let pxl = x0; pxl < x1; pxl++) {
      ctx.fillStyle = tone((pxl + 0.5 - cx * S) / (rx * S), (py + 0.5 - cy * S) / (ry * S), FUR);
      ctx.fillRect(pxl, py, 1, 1);
    }
  }
}

/** A lid triangle in the head's shading. */
function skinTri(ctx: Ctx, a: Pt, b: Pt, c: Pt): void {
  if (!LID_HEAD) {
    tri(ctx, a, b, c, FUR[1]);
    return;
  }
  const { cx, cy, rx, ry } = LID_HEAD;
  const A = { x: a.x * S, y: a.y * S }, B = { x: b.x * S, y: b.y * S }, C = { x: c.x * S, y: c.y * S };
  const d = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y);
  if (d === 0) return;
  for (let y = Math.floor(Math.min(A.y, B.y, C.y)); y <= Math.ceil(Math.max(A.y, B.y, C.y)); y++) {
    for (let x = Math.floor(Math.min(A.x, B.x, C.x)); x <= Math.ceil(Math.max(A.x, B.x, C.x)); x++) {
      const wa = ((B.y - C.y) * (x + 0.5 - C.x) + (C.x - B.x) * (y + 0.5 - C.y)) / d;
      const wb = ((C.y - A.y) * (x + 0.5 - C.x) + (A.x - C.x) * (y + 0.5 - C.y)) / d;
      if (wa >= -0.02 && wb >= -0.02 && 1 - wa - wb >= -0.02) {
        ctx.fillStyle = tone((x + 0.5 - cx * S) / (rx * S), (y + 0.5 - cy * S) / (ry * S), FUR);
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
}

/** Brows must show on any coat: dark strokes on light fur, light strokes on dark fur. */
function browColour(): string {
  const [r, g, b] = hexToRgb(FUR[1]);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum < 0.4 ? mixHex(FUR[1], "#ffffff", 0.55) : FUR[3];
}

/**
 * One brow over an eye centred at (cx, cy) with vertical radius ry. `outward`
 * is +1 when the eye's outer corner is to the right. `raised` lifts only the
 * right brow and presses the left one down - the one-eyebrow "really?".
 */
function drawBrow(ctx: Ctx, cx: number, cy: number, ry: number, outward: number, state: BrowState): void {
  if (state === "none") return;
  const out = outward >= 0 ? 1 : -1;
  const w = 3.2;
  const base = cy - ry - 1.5;
  // Rise of the inner end and the outer end above `base` (negative = lower).
  let inner = 0;
  let outer = 0;
  let arch = 0.5;
  if (state === "worried") { inner = 1.3; outer = -0.4; arch = 0.2; }
  else if (state === "sad") { inner = 1.8; outer = -0.9; arch = 0; }
  else if (state === "angry") { inner = -1.4; outer = 0.7; arch = -0.1; }
  else if (state === "soft") { inner = 0.1; outer = 0.1; arch = 0.7; }
  else if (state === "raised") {
    // The whole joke is the height difference, so it is big.
    if (out > 0) { inner = 1.7; outer = 2.3; arch = 1.7; } // the raised one
    else { inner = -0.7; outer = -0.3; arch = 0; } // pressed down over a squint
  }
  const colour = browColour();
  const from = { x: cx - out * w * 0.55, y: base - inner };
  const to = { x: cx + out * w * 0.5, y: base - outer };
  stroke(ctx, from, { x: cx, y: (from.y + to.y) / 2 - arch }, to, state === "raised" && out > 0 ? 0.6 : 0.5, colour);
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

/** A four-point star highlight - the excited / victorious eye. */
function starGlint(ctx: Ctx, x: number, y: number, r: number): void {
  px(ctx, x - r, y - 0.25, r * 2, 0.5, EYE_SHINE);
  px(ctx, x - 0.25, y - r, 0.5, r * 2, EYE_SHINE);
  blob(ctx, x, y, r * 0.42, r * 0.42, [EYE_SHINE]);
}

function drawEye(ctx: Ctx, cx: number, cy: number, pose: PoseSpec, side = false, outward = 1, squint = 1): void {
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
  const soft = state === "soft";
  const smug = state === "smug";
  const narrow = state === "narrow";
  const watery = state === "watery";
  const dilated = state === "dilated";
  const sparkle = state === "sparkle";
  // Panic reads through the shrunken pupil, not a bulging eye — only a touch
  // larger than "wide", or the face stops looking like the same cat.
  const eRx = rx + (wide ? 0.5 : 0) + (panic ? 0.45 : 0) + (sparkle ? 0.25 : 0);
  const eRy =
    (focus
      ? ry * 0.55
      : half
        ? ry * 0.72
        : sad
          ? ry * 0.92
          : angry
            ? ry * 0.62 // narrowed glare
            : ry + (wide ? 0.6 : 0) + (panic ? 0.5 : 0) + (sparkle ? 0.3 : 0)) * squint;
  // Sad eyes gaze slightly upward, which is most of what makes them read as
  // pleading rather than merely droopy.
  const offsetY = state === "up" ? -1.1 : state === "down" ? 1.1 : sad ? -0.5 : 0;

  blob(ctx, cx, cy + offsetY, eRx, eRy, [EYE_LIGHT, EYE_MID, EYE_DARK]);

  // Big prominent pupil: sized as a fraction of the iris so it stays large and
  // glossy at every eye shape, leaving only a thin bright rim of colour.
  // Pupil size carries a lot of feeling: blown wide when captivated, pinched
  // to a slit when suspicious or scared.
  const fx = panic ? 0.42 : dilated ? 0.94 : narrow ? 0.6 : focus ? 0.86 : wide ? 0.66 : 0.82;
  const fy = panic ? 0.46 : dilated ? 0.95 : narrow ? 0.8 : focus ? 0.92 : wide ? 0.76 : 0.86;
  const pRx = eRx * fx;
  const pRy = eRy * fy;
  const pxOff = clampPupil(pose.pupilX, Math.max(0, eRx - pRx));
  const pyOff = clampPupil(pose.pupilY * 0.55 + offsetY * 0.7, Math.max(0, eRy - pRy));
  blob(ctx, cx + pxOff, cy + offsetY + pyOff, pRx, pRy, [EYE_PUPIL]);

  // Double highlight = the glossy chibi sparkle (kept large so the big pupils
  // still read as bright and friendly, never flat or staring).
  if (sparkle) {
    starGlint(ctx, cx + pxOff - pRx * 0.3, cy + offsetY + pyOff - pRy * 0.36, 1.9);
    blob(ctx, cx + pxOff + pRx * 0.32, cy + offsetY + pyOff + pRy * 0.38, 0.7, 0.75, [EYE_SHINE]);
  } else {
    blob(ctx, cx + pxOff - pRx * 0.35, cy + offsetY + pyOff - pRy * 0.4, 1.35, 1.5, [EYE_SHINE]);
    blob(ctx, cx + pxOff + pRx * 0.3, cy + offsetY + pyOff + pRy * 0.35, 0.75, 0.8, [EYE_SHINE]);
  }
  if (watery || (pose.tears > 0 && !half)) {
    // A third, trembling glint and a wet line welling up along the lower lid.
    blob(ctx, cx + pxOff + pRx * 0.42, cy + offsetY + pyOff - pRy * 0.05, 0.55, 0.6, [EYE_SHINE]);
    stroke(
      ctx,
      { x: cx - eRx * 0.85, y: cy + offsetY + eRy * 0.62 },
      { x: cx, y: cy + offsetY + eRy * 1.02 },
      { x: cx + eRx * 0.85, y: cy + offsetY + eRy * 0.62 },
      0.42,
      TEAR,
    );
  }

  const lidLine = (y: number, slant = 0) =>
    stroke(ctx, { x: cx - eRx, y: y - slant }, { x: cx, y }, { x: cx + eRx, y: y + slant }, 0.5, FUR[3]);
  if (soft) {
    // Upper lid lowered, lower lid lifted by the cheeks: a relaxed half-smile of an eye.
    skinRect(ctx, cx - eRx, cy + offsetY - eRy, eRx * 2, eRy * 0.78);
    lidLine(cy + offsetY - eRy * 0.22);
    skinRect(ctx, cx - eRx, cy + offsetY + eRy * 0.5, eRx * 2, eRy * 0.55);
    stroke(ctx, { x: cx - eRx * 0.8, y: cy + offsetY + eRy * 0.62 }, { x: cx, y: cy + offsetY + eRy * 0.3 }, { x: cx + eRx * 0.8, y: cy + offsetY + eRy * 0.62 }, 0.4, FUR[3]);
  }
  if (smug) {
    // A heavy, level upper lid down to the middle of the eye.
    skinRect(ctx, cx - eRx, cy + offsetY - eRy, eRx * 2, eRy * 1.02);
    lidLine(cy + offsetY + eRy * 0.02, side ? -0.25 : outward * 0.25);
  }
  if (narrow) {
    // Lids closing from above and below leave a slit.
    skinRect(ctx, cx - eRx, cy + offsetY - eRy, eRx * 2, eRy * 0.72);
    skinRect(ctx, cx - eRx, cy + offsetY + eRy * 0.42, eRx * 2, eRy * 0.62);
    lidLine(cy + offsetY - eRy * 0.28);
    lidLine(cy + offsetY + eRy * 0.42);
  }

  if (half) {
    // Relaxed upper lid.
    skinRect(ctx, cx - eRx, cy + offsetY - eRy, eRx * 2, eRy * 0.85);
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
    skinTri(ctx,
      { x: cx + outer * eRx, y: cy + offsetY - eRy * 0.3 },
      { x: cx + inner * eRx, y: cy + offsetY - eRy * 1.1 },
      { x: cx + outer * eRx, y: cy + offsetY - eRy * 1.3 });
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
    skinTri(ctx,
      { x: cx + inner * eRx, y: cy + offsetY - eRy * 0.2 },
      { x: cx + outer * eRx, y: cy + offsetY - eRy * 1.2 },
      { x: cx + inner * eRx, y: cy + offsetY - eRy * 1.4 });
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
    case "smirk":
      // One corner up, one flat: the savage little "mm-hm". Wide, with a
      // dimple, because at desktop size a subtle smirk is no smirk at all.
      stroke(ctx, { x: hx - 2.3, y: my + 0.4 }, { x: hx + 0.4, y: my + 1.1 }, { x: hx + 2.9, y: my - 1.1 }, 0.5, MOUTH);
      px(ctx, hx + 2.8, my - 1.6, 0.55, 0.6, MOUTH);
      break;
    case "wobble":
      // The trembling crying mouth: a small downturned zigzag.
      stroke(ctx, { x: hx - 2.1, y: my + 1.1 }, { x: hx - 1.4, y: my + 0.1 }, { x: hx - 0.6, y: my + 0.7 }, 0.4, MOUTH);
      stroke(ctx, { x: hx - 0.6, y: my + 0.7 }, { x: hx + 0.1, y: my + 0.1 }, { x: hx + 0.8, y: my + 0.7 }, 0.4, MOUTH);
      stroke(ctx, { x: hx + 0.8, y: my + 0.7 }, { x: hx + 1.5, y: my + 0.1 }, { x: hx + 2.1, y: my + 1.1 }, 0.4, MOUTH);
      break;
    case "tongue":
      // The ω with a tongue poking out: a cheeky blep.
      stroke(ctx, { x: hx - 1.8, y: my - 0.3 }, { x: hx - 0.9, y: my + 0.7 }, { x: hx, y: my - 0.1 }, 0.4, MOUTH);
      stroke(ctx, { x: hx, y: my - 0.1 }, { x: hx + 0.9, y: my + 0.7 }, { x: hx + 1.8, y: my - 0.3 }, 0.4, MOUTH);
      blob(ctx, hx + 0.2, my + 1.35, 0.95, 1.05, [TONGUE]);
      px(ctx, hx + 0.1, my + 0.9, 0.35, 0.9, "#c85a70");
      break;
    case "grin":
      // Wide open delight, corners up.
      blob(ctx, hx, my + 0.9, 2.7, 1.7, [FUR[3]]);
      px(ctx, hx - 2.7, my - 0.3, 5.4, 1.1, FUR[1]); // flatten the top into a D
      blob(ctx, hx, my + 1.8, 1.5, 0.75, [TONGUE]);
      stroke(ctx, { x: hx - 3.1, y: my - 0.4 }, { x: hx - 2.7, y: my + 0.5 }, { x: hx - 2.3, y: my + 0.8 }, 0.4, MOUTH);
      stroke(ctx, { x: hx + 3.1, y: my - 0.4 }, { x: hx + 2.7, y: my + 0.5 }, { x: hx + 2.3, y: my + 0.8 }, 0.4, MOUTH);
      break;
    case "o":
      blob(ctx, hx, my + 0.8, 1.05, 1.2, [FUR[3]]);
      break;
    case "flat":
      px(ctx, hx - 1.7, my + 0.3, 3.4, 0.45, MOUTH);
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

// ---- sunglasses and headphones ------------------------------------------

const SHADE_FRAME = "#15161b";
const SHADE_FRAME_HI = "#2e3038";
const SHADE_RIVET = "#cfd4dc";
// Dark at the brow, easing to violet at the cheek - the gradient in the
// reference. Each band is its own polygon, so the alpha is laid down once.
const SHADE_TOP = "rgba(16, 14, 24, 0.93)";
const SHADE_MID = "rgba(40, 32, 62, 0.89)";
const SHADE_LOW = "rgba(96, 80, 132, 0.84)";
const SHADE_GLINT = "rgba(255, 255, 255, 0.26)";

const HP_BAND = "#e8dcdd";
const HP_BAND_HI = "#f8f2f2";
const HP_BAND_SH = "#bca9ab";
const HP_CUP = "#ece2e3";
const HP_CUP_SH = "#c3b1b3";
const HP_CUSHION = "#a39092";
const HP_METAL = "#d4ccce";

/** Fill a polygon given as a top edge and a bottom edge sampled across x. */
function fillBand(ctx: Ctx, xs: number[], top: (x: number) => number, bottom: (x: number) => number, colour: string): void {
  ctx.fillStyle = colour;
  const pts: Pt[] = [
    ...xs.map((x) => ({ x, y: top(x) })),
    ...xs.slice().reverse().map((x) => ({ x, y: bottom(x) })),
  ];
  const sx = pts.map((p) => p.x * S);
  const sy = pts.map((p) => p.y * S);
  const y0 = Math.floor(Math.min(...sy));
  const y1 = Math.ceil(Math.max(...sy));
  // Scanline, half-open, so the three lens bands meet without a seam or an
  // overlap - an overlap would double the alpha into a dark stripe.
  for (let py = y0; py <= y1; py++) {
    const scan = py + 0.5;
    const cross: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      const ay = sy[i];
      const by = sy[j];
      if ((ay <= scan && by > scan) || (by <= scan && ay > scan)) {
        cross.push(sx[i] + ((scan - ay) / (by - ay)) * (sx[j] - sx[i]));
      }
    }
    cross.sort((a, b) => a - b);
    for (let k = 0; k + 1 < cross.length; k += 2) {
      const from = Math.round(cross[k]);
      const to = Math.round(cross[k + 1]);
      if (to > from) ctx.fillRect(from, py, to - from, 1);
    }
  }
}

/**
 * Flat-top shield sunglasses, both eyes behind one lens.
 *
 * The lens runs from a straight brow down to a rounded lower edge that lifts
 * into a V at the nose bridge, the way the reference does - and stays clear of
 * the nose, which is 4.7 head-units below centre. Wide enough to cover an eye
 * at its widest (5.8 + 5 units out) on every breed.
 */
function drawShades(ctx: Ctx, hx: number, hy: number, hrx: number): void {
  const hs = SP.head;
  const half = Math.min(11.2 * hs, hrx * 0.93);
  const top = hy - 6.3 * hs;
  const lc = 5.6 * hs;
  const low = hy + 5.0 * hs;
  const bottom = (x: number): number => {
    const d = Math.abs(x - hx);
    return d < lc
      ? low - 3.6 * hs * ((lc - d) / lc) ** 2
      : low - 3.2 * hs * ((d - lc) / (half - lc)) ** 2;
  };
  const xs: number[] = [];
  for (let i = 0; i <= 24; i++) xs.push(hx - half + (2 * half * i) / 24);
  const bandA = top + 4.3 * hs;
  const bandB = hy + 1.2 * hs;
  fillBand(ctx, xs, () => top, () => bandA, SHADE_TOP);
  fillBand(ctx, xs, () => bandA, (x) => Math.min(bottom(x), bandB), SHADE_MID);
  fillBand(ctx, xs, () => bandB, bottom, SHADE_LOW);
  // A glint on the left lens: the cue that says glass, not a painted patch.
  stroke(ctx, { x: hx - half * 0.74, y: top + 1.4 }, { x: hx - half * 0.66, y: top + 2.6 }, { x: hx - half * 0.5, y: top + 4 }, 0.5, SHADE_GLINT);
  // Heavy matte brow bar, rivets at the corners, arms back to the ears.
  px(ctx, hx - half - 0.3, top - 0.9 * hs, half * 2 + 0.6, 1.45 * hs, SHADE_FRAME);
  px(ctx, hx - half - 0.3, top - 0.9 * hs, half * 2 + 0.6, 0.35 * hs, SHADE_FRAME_HI);
  for (const d of [-1, 1] as const) {
    blob(ctx, hx + d * (half - 0.9), top - 0.2 * hs, 0.45, 0.45, [SHADE_RIVET]);
    stroke(
      ctx,
      { x: hx + d * half, y: top - 0.2 },
      { x: hx + d * (half + 0.6), y: top - 0.5 },
      { x: hx + d * hrx * 0.99, y: top - 0.7 },
      0.85,
      SHADE_FRAME,
    );
  }
}

/** The same shield in profile: one lens over the visible eye. */
function drawShadesSide(ctx: Ctx, hx: number, hy: number, hrx: number): void {
  const hs = SP.head;
  const back = hx - 0.2 * hs;
  const front = hx + 7.9 * hs;
  const top = hy - 6.0 * hs;
  const low = hy + 3.9 * hs;
  const bottom = (x: number): number => low - 2.2 * hs * ((x - (hx + 3.3)) / (front - hx - 3.3)) ** 2;
  const xs: number[] = [];
  for (let i = 0; i <= 12; i++) xs.push(back + ((front - back) * i) / 12);
  const bandA = top + 4.0 * hs;
  const bandB = hy + 1.0 * hs;
  fillBand(ctx, xs, () => top, () => bandA, SHADE_TOP);
  fillBand(ctx, xs, () => bandA, (x) => Math.min(bottom(x), bandB), SHADE_MID);
  fillBand(ctx, xs, () => bandB, bottom, SHADE_LOW);
  stroke(ctx, { x: back + 2, y: top + 1.2 }, { x: back + 2.6, y: top + 2.4 }, { x: back + 3.4, y: top + 3.8 }, 0.5, SHADE_GLINT);
  px(ctx, back - 0.2, top - 0.9 * hs, front - back + 0.4, 1.45 * hs, SHADE_FRAME);
  px(ctx, back - 0.2, top - 0.9 * hs, front - back + 0.4, 0.35 * hs, SHADE_FRAME_HI);
  blob(ctx, front - 0.8, top - 0.2 * hs, 0.45, 0.45, [SHADE_RIVET]);
  stroke(ctx, { x: back, y: top - 0.2 }, { x: back - 2, y: top - 0.5 }, { x: hx - hrx + 1.2, y: top - 0.4 }, 0.85, SHADE_FRAME);
}

/** One over-ear cup: shell, a darker cushion on the head side, a slider above. */
function hpCup(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, inward: number): void {
  blob(ctx, cx, cy, rx, ry, [HP_CUP, HP_CUP, HP_CUP_SH]);
  // The cushion shows as a darker crescent on the side facing the head.
  blob(ctx, cx + inward * rx * 0.46, cy, rx * 0.5, ry * 0.84, [HP_CUSHION]);
  blob(ctx, cx - inward * rx * 0.22, cy - ry * 0.3, rx * 0.34, ry * 0.3, [HP_BAND_HI]);
  px(ctx, cx - 0.55, cy - ry - 1.3, 1.1, 1.6, HP_METAL);
}

/** Padded band over the top of the head, from cup to cup. */
function hpBand(ctx: Ctx, from: Pt, peak: Pt, to: Pt): void {
  stroke(ctx, from, peak, to, 2.1, HP_BAND_SH);
  stroke(ctx, from, peak, to, 1.5, HP_BAND);
  // Thick enough to join up: at 0.5 the stroke broke into a row of beads.
  stroke(ctx, { x: from.x, y: from.y - 0.5 }, { x: peak.x, y: peak.y - 0.55 }, { x: to.x, y: to.y - 0.5 }, 0.8, HP_BAND_HI);
}

/** Over-ear headphones seen from the front or from behind - the same shape. */
function drawHeadphones(ctx: Ctx, hx: number, hy: number, hrx: number, hry: number): void {
  const cupY = hy + 1.4;
  hpBand(ctx, { x: hx - hrx + 0.6, y: cupY - 4 }, { x: hx, y: hy - hry - 4.4 }, { x: hx + hrx - 0.6, y: cupY - 4 });
  for (const d of [-1, 1] as const) hpCup(ctx, hx + d * (hrx - 0.1), cupY, 3.3, 4.5, -d);
}

/**
 * Two gold studs up the outer edge of one ear.
 *
 * Gold, not steel: against grey fur a steel stud disappears entirely.
 */
function drawEarStuds(ctx: Ctx, earX: number, baseY: number, dir: number, spread: number): void {
  const outerX = earX + dir * spread;
  const tipX = earX + dir * 0.8;
  const tipY = baseY - 6.4 * SP.ear;
  for (const f of [0.3, 0.55] as const) {
    blob(ctx, outerX + (tipX - outerX) * f, baseY + 1.2 + (tipY - baseY - 1.2) * f, 0.95, 0.95, [STUD, STUD_DARK]);
  }
}

function frontAccessory(ctx: Ctx, hx: number, hy: number, hrx: number, hry: number): void {
  if (seasonalAccessory(ctx, hx, hy, hrx, hry, 1)) return;
  if (accessory === "sunglasses") {
    drawShades(ctx, hx, hy, hrx);
  } else if (accessory === "glasses") {
    for (const d of [-1, 1] as const) ring(ctx, hx + d * 5.4, hy - 0.5, 4.4, 0.5, GLASS_RIM);
    px(ctx, hx - 1.4, hy - 1.2, 2.8, 0.8, GLASS_RIM);
    px(ctx, hx - hrx + 0.6, hy - 1.4, 1.8, 0.7, GLASS_RIM);
    px(ctx, hx + hrx - 2.4, hy - 1.4, 1.8, 0.7, GLASS_RIM);
    px(ctx, hx - 8, hy - 3, 1.6, 0.7, GLASS_GLINT);
  } else if (accessory === "headphones") {
    drawHeadphones(ctx, hx, hy, hrx, hry);
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
  } else if (accessory === "earStuds") {
    const earX = hrx * 0.67;
    const earBase = hy - hry + 3;
    drawEarStuds(ctx, hx - earX, earBase, -1, 3.4);
    drawEarStuds(ctx, hx + earX, earBase, 1, 3.4);
  } else if (accessory === "faceMask") {
    const cy = hy + 5.0 * SP.head;
    const rx = hrx * 0.62;
    const ry = hry * 0.40;
    blob(ctx, hx, cy, rx, ry, [MASK_EDGE, MASK_FACE, MASK_FOLD]);
    for (const f of [-0.18, 0.22] as const) {
      px(ctx, hx - rx * 0.74, cy + ry * f, rx * 1.48, 0.5, MASK_FOLD);
    }
    px(ctx, hx - rx * 0.9, cy - ry * 0.88, rx * 1.8, 0.7, MASK_EDGE);
    // Loops routed outside the cheeks; through them they crossed the eyes.
    for (const d of [-1, 1] as const) {
      stroke(
        ctx,
        { x: hx + d * rx * 0.94, y: cy - ry * 0.4 },
        { x: hx + d * (hrx + 1.2), y: cy - ry * 1.2 },
        { x: hx + d * (hrx - 0.6), y: hy - hry * 0.3 },
        0.5,
        MASK_EDGE,
      );
    }
  }
}

function sideAccessory(ctx: Ctx, hx: number, hy: number, hrx: number, hry: number, watchAt: Pt): void {
  // Costumes flop backwards in profile (the cat faces right).
  if (seasonalAccessory(ctx, hx, hy, hrx, hry, -1)) return;
  if (accessory === "sunglasses") {
    drawShadesSide(ctx, hx, hy, hrx);
  } else if (accessory === "glasses") {
    ring(ctx, hx + 3.6, hy - 0.8, 4, 0.5, GLASS_RIM);
    px(ctx, hx - hrx + 1, hy - 1.4, 5.4, 0.7, GLASS_RIM);
    px(ctx, hx + 1.4, hy - 3, 1.6, 0.7, GLASS_GLINT);
  } else if (accessory === "headphones") {
    // Profile band stays behind the visible ear and never crosses the eye; the
    // near cup sits over the side of the head, shell facing out.
    hpBand(ctx, { x: hx - 5.2, y: hy - 2.2 }, { x: hx - 5.0, y: hy - hry - 3.2 }, { x: hx + 1.6, y: hy - hry + 0.6 });
    blob(ctx, hx - 5.2, hy + 2, 3.4, 4.6, [HP_CUP, HP_CUP, HP_CUP_SH]);
    blob(ctx, hx - 5.2, hy + 2, 2.0, 3.0, [HP_CUP_SH]);
    blob(ctx, hx - 5.2, hy + 2, 1.4, 2.3, [HP_CUP]);
    blob(ctx, hx - 6.0, hy + 0.4, 0.9, 1.1, [HP_BAND_HI]);
    px(ctx, hx - 5.75, hy - 3.9, 1.1, 1.6, HP_METAL);
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
  } else if (accessory === "earStuds") {
    drawEarStuds(ctx, hx + 4.2, hy - hry + 2.6, 1, 3.2);
  } else if (accessory === "faceMask") {
    const cx = hx + hrx * 0.52;
    const cy = hy + 3.0 * SP.head;
    blob(ctx, cx, cy, hrx * 0.46, hry * 0.40, [MASK_EDGE, MASK_FACE, MASK_FOLD]);
    px(ctx, cx - hrx * 0.34, cy, hrx * 0.68, 0.5, MASK_FOLD);
    stroke(
      ctx,
      { x: cx - hrx * 0.4, y: cy - hry * 0.3 },
      { x: hx - 1, y: hy + 1 },
      { x: hx - 4.2, y: hy - hry + 4.4 },
      0.5,
      MASK_EDGE,
    );
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

/** A drop: round at the bottom, pointed at the top, a deeper edge so it shows on any coat. */
function teardrop(ctx: Ctx, x: number, y: number, r: number): void {
  blob(ctx, x, y, r + 0.35, r + 0.4, [TEAR_EDGE]);
  tri(ctx, { x: x - r - 0.2, y: y - r * 0.3 }, { x: x + r + 0.2, y: y - r * 0.3 }, { x, y: y - r * 2.3 - 0.5 }, TEAR_EDGE);
  blob(ctx, x, y, r, r + 0.05, [TEAR]);
  tri(ctx, { x: x - r * 0.75, y: y - r * 0.3 }, { x: x + r * 0.75, y: y - r * 0.3 }, { x, y: y - r * 2 }, TEAR);
  px(ctx, x - r * 0.45, y - r * 0.25, 0.45, 0.45, EYE_SHINE);
}

/**
 * Tears from the outer lower corner of each eye (`corners`), by stage:
 * 2-3 a bead gathering on the lid, 4-6 the drop sliding down the cheek with
 * a faint wet trail, and at 6 the next bead already forming. Stage 1 (watery)
 * is drawn by drawEye. Drawn in head space, so the tears follow the head.
 */
function drawTears(ctx: Ctx, corners: Pt[], stage: number): void {
  if (stage < 2) return;
  for (const c of corners) {
    if (stage === 2) teardrop(ctx, c.x, c.y + 0.3, 0.55);
    else if (stage === 3) teardrop(ctx, c.x, c.y + 0.5, 0.85);
    else {
      const fall = [2.4, 4.6, 6.6][Math.min(2, stage - 4)];
      px(ctx, c.x - 0.2, c.y + 0.4, 0.45, Math.max(0.5, fall - 1.4), TEAR);
      teardrop(ctx, c.x + 0.15, c.y + fall, 0.8);
      if (stage >= 6) teardrop(ctx, c.x, c.y + 0.3, 0.5);
    }
  }
}

/** Nervous sweat drop at the temple. */
function drawSweat(ctx: Ctx, x: number, y: number): void {
  teardrop(ctx, x, y, 0.95);
}

/** The manga "popping vein" of real irritation: four bent strokes around a gap. */
function drawAngerMark(ctx: Ctx, x: number, y: number): void {
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    px(ctx, x + sx * 0.5 - (sx < 0 ? 1.1 : 0), y + sy * 1.4 - 0.25, 1.1, 0.55, ANGER_MARK);
    px(ctx, x + sx * 1.4 - 0.25, y + sy * 0.5 - (sy < 0 ? 1.1 : 0), 0.55, 1.1, ANGER_MARK);
  }
}

function drawSparkles(ctx: Ctx, x: number, y: number): void {
  const star = (cx: number, cy: number, r: number) => {
    px(ctx, cx - r, cy - 0.25, r * 2, 0.5, SPARKLE);
    px(ctx, cx - 0.25, cy - r, 0.5, r * 2, SPARKLE);
    blob(ctx, cx, cy, 0.45, 0.45, [EYE_SHINE]);
  };
  star(x, y, 1.7);
  star(x + 3.2, y + 3.6, 1.1);
}

/**
 * Draw the head unit rotated by `pose.headTilt` about the neck.
 *
 * The primitives fill whole pixels at integer positions, so a canvas rotation
 * applied to them directly leaves hairline seams between the rotated pixels.
 * Instead the head (ears, face, the costume's face layer, accessories, tears)
 * is painted upright into a scratch canvas and composited rotated with
 * nearest-neighbour sampling - the same crisp result as the rest of the art.
 * No tilt, no scratch canvas: the old single-pass path.
 */
let tiltCanvas: HTMLCanvasElement | null = null;
function withHeadTilt(ctx: Ctx, pose: PoseSpec, pivot: Pt, draw: (c: Ctx) => void): void {
  const deg = pose.headTilt;
  if (!deg || typeof document === "undefined") {
    draw(ctx);
    return;
  }
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  tiltCanvas ??= document.createElement("canvas");
  if (tiltCanvas.width !== w || tiltCanvas.height !== h) {
    tiltCanvas.width = w;
    tiltCanvas.height = h;
  }
  const t = tiltCanvas.getContext("2d", { willReadFrequently: true });
  if (!t) {
    draw(ctx);
    return;
  }
  t.clearRect(0, 0, w, h);
  t.imageSmoothingEnabled = false;
  draw(t);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(pivot.x * S, pivot.y * S);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.translate(-pivot.x * S, -pivot.y * S);
  ctx.drawImage(tiltCanvas, 0, 0);
  ctx.restore();
}

/** Where a point on the upright head lands once the head is tilted about `pivot`. */
export function tiltPoint(pose: PoseSpec, pivot: Pt, p: Pt): Pt {
  if (!pose.headTilt) return p;
  const a = (pose.headTilt * Math.PI) / 180;
  const dx = p.x - pivot.x;
  const dy = p.y - pivot.y;
  return { x: pivot.x + dx * Math.cos(a) - dy * Math.sin(a), y: pivot.y + dx * Math.sin(a) + dy * Math.cos(a) };
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
/** One body mass, in 48-unit design space. */
export interface BodyEllipse {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

/**
 * Where the torso and head actually are for a pose.
 *
 * The single source of truth for both the renderer and the costume overlay: a
 * garment has to sit on the ellipse that is really drawn, and the torso moves a
 * long way between poses (standing 34.5 with half-height 7.0, lying 40.0 with
 * half-height 4.2) and again between species (chonk is 1.3x wide and rides 2.4
 * units lower than classic). A second copy of this arithmetic would agree today
 * and drift the first time a pose is tuned.
 *
 * Head lean and the sprite-edge clamps are applied by the draw functions AFTER
 * this, so `head` is the head's resting place for the pose rather than its
 * final leaned position. That is what a hat or a pair of spectacles wants:
 * following the lean would make them swim against the face.
 */
export interface BodyAnchors {
  torso: BodyEllipse;
  /**
   * Where the neck meets the jaw - what a collar attaches to.
   *
   * Deliberately smaller than the drawn skull and deliberately free of the
   * head lean, because a collar sits on the shoulders and does not swing when
   * the cat looks around.
   */
  head: BodyEllipse;
  /**
   * The skull as the renderer actually draws it, lean included.
   *
   * Anything WORN on the head - a visor, a hat, headphones - goes on this one.
   * Sized off `head` instead, a visor came out a third too small and stayed
   * put while the face moved out from under it.
   */
  skull: BodyEllipse;
  /**
   * Which way the chest points, +1 for the usual right-facing profile.
   *
   * The curled sleeping cat is drawn mirrored, so anything with a front and a
   * back - a jacket's lapel, a collar - has to know, or it ends up on the tail.
   */
  faces: 1 | -1;
}

/**
 * How far the head is displaced by the current look direction.
 *
 * Shared by the drawing paths and the anchors so a hat cannot drift off a
 * head that has leaned away from it.
 */
function headLean(pose: PoseSpec): { dx: number; dy: number } {
  return { dx: pose.headTurnX * HEAD_LEAN_X, dy: pose.headTurnY * HEAD_LEAN_Y };
}

function frontAnchors(pose: PoseSpec): BodyAnchors {
  // Hanging off a window edge is drawn by drawHangingFront, which builds its
  // own body and applies no species scaling. Matching it exactly here is what
  // puts a costume on the swinging torso rather than on the standing one.
  if (pose.body === "hang") {
    const sway = Math.sin(pose.legPhase * Math.PI * 2) * 1.2;
    const lean = headLean(pose);
    return {
      torso: { x: 24 + sway, y: 34, rx: 7.6, ry: 8.2 },
      head: { x: 24 + sway, y: 20 + pose.headBob, rx: 8.4 * SP.head, ry: 7.6 * SP.head },
      skull: {
        x: 24 + sway + lean.dx,
        y: 20 + pose.headBob + lean.dy,
        rx: FRONT_SKULL_RX * SP.head,
        ry: FRONT_SKULL_RY * SP.head,
      },
      faces: 1,
    };
  }
  let hy = 15.5 + pose.headBob;
  let by = 34;
  let brx = 9;
  let bry = 8.8;
  if (pose.body === "loaf") { hy = 18 + pose.headBob; by = 38.5; brx = 12.5; bry = 6; }
  if (pose.body === "dangle") { hy = 14 + pose.headBob; by = 32; brx = 7.6; bry = 8; }
  if (pose.prop === "placard") {
    hy += PLACARD_CAT_DROP;
    by += PLACARD_CAT_DROP * 0.5;
  }
  brx *= SP.bodyW;
  bry *= SP.bodyH;
  if (pose.body !== "dangle") by += SP.bodyDrop;
  hy += SP.bodyDrop * 0.55;
  if (pose.prop === "placard") by = Math.min(by, 48 - 1.5 - bry);
  const lean = headLean(pose);
  return {
    torso: { x: 24, y: by, rx: brx, ry: bry },
    head: { x: 24, y: hy, rx: 8.4 * SP.head, ry: 7.6 * SP.head },
    skull: {
      x: 24 + lean.dx,
      y: hy + lean.dy,
      rx: FRONT_SKULL_RX * SP.head,
      ry: FRONT_SKULL_RY * SP.head,
    },
    faces: 1,
  };
}

/**
 * The back view, which until now borrowed the front anchors.
 *
 * It draws a wider body than the front does, and its climbing branch is a
 * completely separate silhouette that sways. Reporting the front's numbers put
 * a costume next to the cat rather than on it, and the climb - the pose you
 * get when the cat is stuck at the top of a window - was never painted at all.
 */
function backAnchors(pose: PoseSpec): BodyAnchors {
  if (pose.body === "climb") {
    const sway = Math.sin(pose.legPhase * Math.PI * 2) * 1.4;
    // The climbing branch applies no species scaling, so neither does this.
    return {
      torso: { x: 24 + sway, y: 31, rx: 8, ry: 10.5 },
      head: { x: 24 + sway, y: 14.5 + pose.headBob, rx: 8.4, ry: 7.6 },
      skull: { x: 24 + sway, y: 14.5 + pose.headBob, rx: 10.5, ry: 9.4 },
      faces: 1,
    };
  }
  const drop = SP.bodyDrop;
  const hy = 15.5 + pose.headBob + drop * 0.55;
  return {
    torso: { x: 24, y: 35.5 + drop, rx: 10 * SP.bodyW, ry: 8.6 * SP.bodyH },
    head: { x: 24, y: hy, rx: 8.4 * SP.head, ry: 7.6 * SP.head },
    skull: { x: 24, y: hy, rx: 11.6 * SP.head, ry: 10.4 * SP.head },
    faces: 1,
  };
}

function sideAnchors(pose: PoseSpec): BodyAnchors {
  // The curled sleeping cat is drawn by its own branch in drawSide, with its
  // own geometry and facing LEFT. Reporting the generic "lie" ellipse here
  // would put a costume somewhere the body is not.
  if (pose.body === "lie" && pose.eyes === "closed") {
    const breath = Math.max(0, pose.headBob) * 0.45;
    const head = { x: 16, y: 36.5 - breath * 0.35, rx: 7.5 * SP.head, ry: 6.5 * SP.head };
    return {
      torso: {
        x: 25,
        y: 37.6 - breath,
        rx: 12.8 * SP.bodyW,
        ry: (7.5 + breath * 0.25) * SP.bodyH,
      },
      head,
      // The curled cat's head IS drawn at these radii, and a sleeping cat is
      // not looking anywhere, so the lean does not apply.
      skull: head,
      faces: -1,
    };
  }

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
    const reach = Math.max(0, Math.min(1, pose.legPhase));
    bx = 15 + reach * 1.5;
    by = 32.5 - reach * 1.5;
    brx = 11.5;
    bry = 5.8;
    hx = 33 + reach * 2;
    hy = 30 + reach * 5 + pose.headBob;
  }

  brx *= SP.bodyW;
  bry *= SP.bodyH;
  hrx *= SP.head;
  hry *= SP.head;
  if (pose.body !== "lie") {
    by += SP.bodyDrop;
    hy += SP.bodyDrop;
  }
  hx += (SP.head - 1) * 2.2;

  // Lean, then the clamps - in that order, so the clamps genuinely run last
  // and bound the final head position. This used to live in drawSide, which
  // meant the costume overlay read a head position the renderer had already
  // moved on from.
  const lean = headLean(pose);
  hx += lean.dx;
  hy += lean.dy;
  if (pose.body === "stretch") {
    // The bow pushes the head down and forward, and breed scaling (bigger
    // skulls, lower bodies) is applied above - so clamp once the real head
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

  const head = { x: hx, y: hy, rx: hrx, ry: hry };
  return {
    torso: { x: bx, y: by, rx: brx, ry: bry },
    // In profile the drawn skull and the neck attachment are the same ellipse,
    // so unlike the front view there is nothing to separate here.
    head,
    skull: head,
    faces: 1,
  };
}

/**
 * Torso and head for whichever view the pose is in. Back and three-quarter
 * share the front body; only the face differs, and a costume anchored to the
 * torso does not care about the face.
 */
/**
 * The turning cat is its own drawing path with its own body, offset left of
 * centre and differently proportioned from the front view.
 */
function threeQuarterAnchors(pose: PoseSpec): BodyAnchors {
  const drop = SP.bodyDrop;
  const hy = 16.5 + pose.headBob + drop * 0.55;
  const lean = headLean(pose);
  return {
    torso: { x: 23, y: 36 + drop, rx: 8.8 * SP.bodyW, ry: 7.6 * SP.bodyH },
    head: { x: 26.5, y: hy, rx: 8.4 * SP.head, ry: 7.6 * SP.head },
    skull: {
      // Mid-turn the far eye is drawn a unit further out than the near one,
      // so the skull's centre shifts with it.
      x: 26.5 + 0.5 + lean.dx,
      y: hy + lean.dy,
      rx: TQ_SKULL_RX * SP.head,
      ry: TQ_SKULL_RY * SP.head,
    },
    faces: 1,
  };
}

export function bodyAnchors(pose: PoseSpec): BodyAnchors {
  if (pose.view === "side") return sideAnchors(pose);
  if (pose.view === "back") return backAnchors(pose);
  if (pose.view === "threeQuarter") return threeQuarterAnchors(pose);
  return frontAnchors(pose);
}

/** A point in 48-unit design space. */
export interface LimbPoint {
  x: number;
  y: number;
}

/**
 * One foreleg, as the renderer actually draws it.
 *
 * Shared with the costume system so a sleeve sits on the arm rather than near
 * it. `paw` is where the paw blob lands, which is also where a sleeve must
 * stop.
 */
export interface FrontLimb {
  from: LimbPoint;
  ctrl: LimbPoint;
  to: LimbPoint;
  /** A paw ON the face (facepalm, wiping a tear): drawn after the head, not under it. */
  overFace?: boolean;
  /** What the paw's toes are doing at `to`. */
  digits?: PawDigits;
  /** +1 / -1: which way a single pointing toe points. */
  digitDir?: number;
}

/** Toe shapes that turn a round paw into a readable hand sign. */
export type PawDigits = "v" | "up" | "one" | "thumb" | "open";

/** The one-paw and paw-to-face gestures the gesture controller adds. */
const PAW_GESTURES: ReadonlySet<Gesture> = new Set<Gesture>([
  "victory", "waveA", "waveB", "highFive", "thumbsUp", "point", "shrug", "facepalm", "wipe", "cover", "chin",
  "salute", "pawHeart", "dismiss", "stompUp", "stompDown", "reachL", "reachR", "middle",
]);

/**
 * Where a costume may paint, relative to the rest of the cat.
 *
 * "torso" runs after the body but BEFORE the forelegs and any prop, so a
 * keyboard, a laptop and the paws themselves stay in front of the clothing.
 * "limbs" runs after the forelegs, which is the only place a sleeve can go.
 */
export type CostumeLayer = "torso" | "limbs" | "face";

export type CostumePainter = (ctx: Ctx, pose: PoseSpec, layer: CostumeLayer) => void;

/**
 * What a costume covers, declared by the costume itself so the emotion system
 * never checks for a particular costume: with the ears under a cowl the head
 * and tail do more of the acting, and an ear or brow change nobody can see is
 * not drawn (one sprite fewer in the cache).
 */
export interface CostumeTraits {
  /** Draws its own fixed ears (a cowl, a helmet). */
  hidesEars?: boolean;
  /** Something over the brow line (a visor, a hood rim). */
  hidesBrows?: boolean;
  /** Eyes behind lenses or a visor: they read weaker. */
  coversEyes?: boolean;
}

/** Where the head turns when it tilts, for art composited over the finished frame. */
export function headTiltPivot(pose: PoseSpec): Pt | null {
  if (!pose.headTilt || (pose.view !== "front" && pose.view !== "threeQuarter")) return null;
  const head = bodyAnchors(pose).head;
  return headPivot(pose, head.x, head.y, pose.view === "threeQuarter");
}

/**
 * Paint anything worn on the head, after the face is drawn.
 *
 * A third seam beyond "torso" and "limbs": the face is the LAST thing every
 * front-facing path draws, so eyewear painted at either of the other two ends
 * up beneath the eyes it is meant to cover.
 */

let costumePainter: CostumePainter | null = null;
/**
 * Part of the frame cache key. Without it a cached sprite drawn while one
 * costume was active would be handed back for another - a jacket that cannot
 * be taken off, or a naked cat that refuses to get dressed.
 */
let costumeCacheKey = "";

export function setCostumePainter(painter: CostumePainter | null, key: string): void {
  costumePainter = painter;
  costumeCacheKey = painter ? key : "";
  clearSpriteCache();
}

function paintCostume(ctx: Ctx, pose: PoseSpec, layer: CostumeLayer): void {
  if (!costumePainter) return;
  ctx.save();
  // The raw context is in PIXELS - every drawing helper in this file converts
  // from design units itself. A painter is handed the 48-unit space instead, so
  // its numbers read the same as the geometry it gets from bodyAnchors.
  ctx.scale(S, S);
  costumePainter(ctx, pose, layer);
  ctx.restore();
}

/**
 * The foreleg paths for a pose, in draw order.
 *
 * Extracted so the costume system can put a sleeve on the same curve the
 * renderer strokes. A second copy of these numbers would agree today and drift
 * the first time a gesture is retuned.
 */
export function frontLimbs(pose: PoseSpec, by: number): FrontLimb[] {
  // These props draw their own forepaws (on a deck, or gripping a handle), so
  // there is no free-standing limb to sleeve.
  if (
    pose.prop === "keyboard" ||
    pose.prop === "laptop" ||
    pose.prop === "placard" ||
    pose.prop === "calculator"
  )
    return [];

  if (pose.gesture === "cheer") {
    return [-1, 1].map((d) => ({
      from: { x: 24 + d * 6, y: by },
      ctrl: { x: 24 + d * 10, y: by - 6 },
      to: { x: 24 + d * 11, y: by - 12 },
    }));
  }
  if (pose.gesture === "clap") {
    return [-1, 1].map((d) => ({
      from: { x: 24 + d * 6, y: by },
      ctrl: { x: 24 + d * 8.5, y: by - 7 },
      to: { x: 24 + d * 1.8, y: by - 12.5 },
    }));
  }
  if (pose.gesture === "knead") {
    const leftDown = pose.legPhase < 0.5;
    return [-1, 1].map((d) => {
      const down = d === -1 ? leftDown : !leftDown;
      const fy = down ? 43.2 : 41.2;
      return {
        from: { x: 24 + d * 4.5, y: by },
        ctrl: { x: 24 + d * 5.4, y: 40 },
        to: { x: 24 + d * 5.6, y: fy },
      };
    });
  }
  if (pose.gesture === "pawUp" || pose.gesture === "groom" || pose.gesture === "scratch" || pose.gesture === "swat") {
    const leftRaised = pose.legPhase < 0.5;
    const d = leftRaised ? -1 : 1;
    const target =
      pose.gesture === "scratch"
        ? { x: 24 + d * 9, y: 22 }
        : pose.gesture === "swat"
          ? { x: 24 + d * 8, y: 17 }
          : { x: 24 + d * 6.5, y: 27 };
    const g = -d;
    return [
      { from: { x: 24 + d * 5, y: by }, ctrl: { x: 24 + d * 8, y: 33 }, to: target },
      { from: { x: 24 + g * 4.5, y: by }, ctrl: { x: 24 + g * 4.5, y: 40 }, to: { x: 24 + g * 4.5, y: 43.2 } },
    ];
  }
  if (PAW_GESTURES.has(pose.gesture)) return gestureLimbs(pose, by);
  return [-1, 1].map((d) => ({
    from: { x: 24 + d * 4.4, y: by },
    ctrl: { x: 24 + d * 4.4, y: 40 },
    to: { x: 24 + d * 4.4, y: 43 },
  }));
}

/**
 * The point the head rolls about: the neck, just above where the neck bridge
 * meets the jaw. Shared by the renderer and by paw-to-face gestures, so a paw
 * lands on the face wherever the tilt has put it.
 */
export function headPivot(pose: PoseSpec, hx: number, hy: number, threeQuarter = false): Pt {
  const lean = headLean(pose);
  const hry = (threeQuarter ? TQ_SKULL_RY : FRONT_SKULL_RY) * SP.head;
  return { x: hx + lean.dx, y: hy + lean.dy + hry * 0.72 };
}

/**
 * Limb paths for the gesture controller's paw gestures. The right paw (as the
 * viewer sees it) makes the sign; the other rests on the ground. Targets on the
 * face are expressed relative to the drawn skull and rotated with the head, so
 * a facepalm lands on the face at any tilt.
 */
function gestureLimbs(pose: PoseSpec, by: number): FrontLimb[] {
  const anchors = frontAnchors(pose);
  const skull = anchors.skull;
  const pivot = headPivot(pose, 24, anchors.head.y);
  const face = (ox: number, oy: number): LimbPoint => tiltPoint(pose, pivot, { x: skull.x + ox, y: skull.y + oy });
  const rest = (d: number): FrontLimb => ({ from: { x: 24 + d * 4.5, y: by }, ctrl: { x: 24 + d * 4.5, y: 40 }, to: { x: 24 + d * 4.5, y: 43.2 } });
  // Raised paws arc OUT past the shoulder rather than cutting across the chest.
  const arm = (d: number, to: LimbPoint, extra: Partial<FrontLimb> = {}): FrontLimb => ({
    from: { x: 24 + d * 5, y: by },
    ctrl: { x: 24 + d * (to.y < by - 8 ? 11.5 : 8.5), y: (by + to.y) / 2 + 2 },
    to,
    ...extra,
  });
  switch (pose.gesture) {
    case "victory": return [arm(1, { x: 37.2, y: 16.5 }, { digits: "v" }), rest(-1)];
    case "middle": return [arm(1, { x: 37, y: 17.5 }, { digits: "up" }), rest(-1)];
    case "waveA": return [arm(1, { x: 36.4, y: 18 }, { digits: "open" }), rest(-1)];
    case "waveB": return [arm(1, { x: 38.4, y: 15.6 }, { digits: "open" }), rest(-1)];
    case "highFive": return [arm(1, { x: 36.2, y: 19.4 }, { digits: "open" }), rest(-1)];
    case "thumbsUp": return [arm(1, { x: 34.5, y: 28 }, { digits: "thumb" }), rest(-1)];
    case "point": return [arm(1, { x: 38.5, y: 28 }, { digits: "one", digitDir: 1 }), rest(-1)];
    case "dismiss": return [arm(1, { x: 36.8, y: by - 7.5 }, { digits: "open" }), rest(-1)];
    case "reachL": return [arm(-1, { x: 11, y: by - 10 }, { digits: "open" }), rest(1)];
    case "reachR": return [arm(1, { x: 37, y: by - 10 }, { digits: "open" }), rest(-1)];
    case "shrug": return [-1, 1].map((d) => arm(d, { x: 24 + d * 11.5, y: by - 4.5 }, { digits: "open" }));
    case "pawHeart": return [-1, 1].map((d) => arm(d, { x: 24 + d * 1.7, y: by - 5.5 }));
    case "stompUp": return [arm(1, { x: 29.5, y: 38.6 }), rest(-1)];
    case "stompDown": return [arm(1, { x: 29.5, y: 43.2 }), rest(-1)];
    case "facepalm": return [arm(1, face(4.6, -0.8), { overFace: true }), rest(-1)];
    case "wipe": return [arm(1, face(8.2, 2.4), { overFace: true }), rest(-1)];
    case "salute": return [arm(1, face(8.6, -6.4), { overFace: true, digits: "open" }), rest(-1)];
    case "chin": return [arm(1, face(2.4, 10.2), { overFace: true }), rest(-1)];
    case "cover": return [-1, 1].map((d) => arm(d, face(d * 2.3, 6.2), { overFace: true }));
    default: return [rest(-1), rest(1)];
  }
}

/** Toes: two for a V, one up, one pointing, a thumb, or an open palm with its pads. */
function drawDigits(ctx: Ctx, at: Pt, kind: PawDigits, dir = 1): void {
  const toe = (tx: number, ty: number) =>
    curvedLimb(ctx, { x: at.x + (tx - at.x) * 0.2, y: at.y - 0.6 }, { x: (at.x + tx) / 2, y: (at.y + ty) / 2 }, { x: tx, y: ty }, 0.62);
  if (kind === "v") {
    toe(at.x - 1.5, at.y - 3.9);
    toe(at.x + 1.4, at.y - 3.9);
  } else if (kind === "up") {
    toe(at.x + 0.1, at.y - 4.3);
  } else if (kind === "one") {
    toe(at.x + dir * 3.6, at.y - 0.5);
  } else if (kind === "thumb") {
    toe(at.x - 0.3, at.y - 3.5);
  } else {
    // An open palm facing out: three toes spread, pink beans on the pads.
    for (const [ox, oy] of [[-1.35, -1.75], [0, -2.25], [1.35, -1.75]] as const) {
      blob(ctx, at.x + ox, at.y + oy, 0.78, 0.8, FUR);
      blob(ctx, at.x + ox, at.y + oy + 0.1, 0.42, 0.42, [PAD]);
    }
    blob(ctx, at.x, at.y + 0.35, 1.15, 0.85, [PAD]);
  }
}

function drawGestureLimb(ctx: Ctx, limb: FrontLimb): void {
  curvedLimb(ctx, limb.from, limb.ctrl, limb.to, 1.7);
  const open = limb.digits === "open";
  blob(ctx, limb.to.x, limb.to.y, open ? 2.5 : 2.2, open ? 2.2 : 1.9, FUR);
  if (limb.digits) drawDigits(ctx, limb.to, limb.digits, limb.digitDir ?? 1);
}

/** After the face: paws that touch it, and the little heart between heart-shaped paws. */
function drawFacePaws(ctx: Ctx, pose: PoseSpec, by: number): boolean {
  if (!PAW_GESTURES.has(pose.gesture)) return false;
  let any = false;
  for (const limb of frontLimbs(pose, by)) {
    if (!limb.overFace) continue;
    drawGestureLimb(ctx, limb);
    any = true;
  }
  if (pose.gesture === "pawHeart") drawHearts(ctx, 23, by - 10.2);
  return any;
}

function drawFrontFace(ctx: Ctx, hx: number, hy: number, pose: PoseSpec, threeQuarter = false): void {
  withHeadTilt(ctx, pose, headPivot(pose, hx, hy, threeQuarter), (c) => paintFrontFace(c, hx, hy, pose, threeQuarter));
}

function paintFrontFace(ctx: Ctx, hx: number, hy: number, pose: PoseSpec, threeQuarter: boolean): void {
  const hrx = (threeQuarter ? TQ_SKULL_RX : FRONT_SKULL_RX) * SP.head;
  const hry = (threeQuarter ? TQ_SKULL_RY : FRONT_SKULL_RY) * SP.head;
  // Lean the whole head unit — skull, ears and face move together, so it reads
  // as the cat turning to look rather than its features sliding around.
  const lean = headLean(pose);
  hx += lean.dx;
  hy += lean.dy;

  const [earL, earR] = earPair(pose.ears);
  drawEar(ctx, hx - hrx * 0.67, hy - hry + 3, -1, earL);
  drawEar(ctx, hx + hrx * 0.67, hy - hry + 3, 1, earR);
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
  const leftX = hx - eyeGap;
  const rightX = hx + (threeQuarter ? eyeGap + 1 : eyeGap);
  const eyeY = hy - 0.5;
  // One raised brow narrows the OTHER eye: the lopsided "really?" look.
  const squintL = pose.brow === "raised" ? 0.8 : 1;
  // Outer corners point away from the muzzle, so the lashes mirror.
  LID_HEAD = { cx: hx, cy: hy, rx: hrx, ry: hry };
  drawEye(ctx, leftX, eyeY, pose, false, -1, squintL);
  drawEye(ctx, rightX, eyeY, pose, false, 1);
  LID_HEAD = null;
  const eyeRy = 5.4 * SP.eye;
  drawBrow(ctx, leftX, eyeY, eyeRy * squintL, -1, pose.brow);
  drawBrow(ctx, rightX, eyeY, eyeRy, 1, pose.brow);

  blob(ctx, hx, hy + 4.7 * SP.head, 0.9, 0.7, [NOSE]);
  drawMouth(ctx, hx, hy + 6.4 * SP.head, pose.mouth);

  if (pose.eyes !== "closed") {
    // Short whiskers that droop with sadness and lift with excitement - a
    // small cue, but it is one of the first things that reads on a real cat.
    const low = pose.eyes === "sad" || pose.brow === "sad" || pose.brow === "worried" || pose.tears > 0;
    const high = pose.eyes === "wide" || pose.eyes === "sparkle" || pose.eyes === "dilated";
    const dy = low ? 0.55 : high ? -0.45 : 0;
    const dl = high ? 0.5 : low ? -0.3 : 0;
    px(ctx, hx - hrx - 1.6 - dl, hy + 2.6 + dy, 2 + dl, 0.5, WHISKER);
    px(ctx, hx - hrx - 1.2 - dl, hy + 4.4 + dy * 1.4, 1.7 + dl, 0.5, WHISKER);
    px(ctx, hx + hrx - 0.4, hy + 2.6 + dy, 2 + dl, 0.5, WHISKER);
    px(ctx, hx + hrx - 0.5, hy + 4.4 + dy * 1.4, 1.7 + dl, 0.5, WHISKER);
  }
  if (pose.blush) {
    blob(ctx, hx - hrx * 0.62, hy + 3.8 * SP.head, 1.9, 1, [BLUSH]);
    blob(ctx, hx + hrx * 0.62, hy + 3.8 * SP.head, 1.9, 1, [BLUSH]);
  }
  // Tears before the costume's face layer, so a visor or cowl covers the part
  // of a tear it would really cover and the rest runs down the visible cheek.
  // Kept through a sniffle (eyes closed): a tear already falling keeps falling.
  if (pose.tears > 0 && pose.eyes !== "happy") {
    const rx = 4.5 * SP.eye;
    drawTears(
      ctx,
      [
        { x: leftX - rx * 0.62, y: eyeY + eyeRy * squintL * 0.78 },
        { x: rightX + rx * 0.62, y: eyeY + eyeRy * 0.78 },
      ],
      pose.tears,
    );
  }
  // The costume's face layer, then the accessory ON TOP of it. The other way
  // round, a cap or glasses ended up under a cowl or a visor - so a customer
  // could pick an accessory with a costume on and never see it. This is the
  // one front face seam; all three front paths come through here.
  paintCostume(ctx, pose, "face");
  frontAccessory(ctx, hx, hy, hrx, hry);
  if (pose.steam) drawSteam(ctx, hx - 2, hy - hry - 7);
  // Emotional marks ride on top of everything, costume included.
  // Placed in the clear bits of a crowded head: the sweat at the outer temple
  // above the eye, the vein on the forehead between the left ear and the middle.
  if (pose.sweat) drawSweat(ctx, hx + hrx * 0.9, hy - hry * 0.45);
  if (pose.anger) drawAngerMark(ctx, hx - hrx * 0.45, hy - hry * 0.78);
  if (pose.sparkle) drawSparkles(ctx, hx + hrx * 0.95, hy - hry * 0.72);
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
  // Paths come from frontLimbs so the costume can sleeve the same curve; the
  // paws, gleams and impact ticks below stay here because they are the cat,
  // not the limb.
  const limbs = frontLimbs(pose, by);
  if (pose.gesture === "cheer") {
    for (const limb of limbs) {
      curvedLimb(ctx, limb.from, limb.ctrl, limb.to, 1.7);
      blob(ctx, limb.to.x, limb.to.y, 2.2, 1.9, FUR);
    }
    return;
  }
  if (pose.gesture === "clap") {
    // Both paws overhead and TOGETHER: with "cheer" (apart) on the alternate
    // frame this reads as an urgent little clap. Tiny impact ticks sell the hit.
    for (const limb of limbs) {
      curvedLimb(ctx, limb.from, limb.ctrl, limb.to, 1.7);
      blob(ctx, limb.to.x, limb.to.y, 2.2, 1.9, FUR);
    }
    px(ctx, 24 - 4.6, by - 15.2, 1.3, 0.55, EYE_SHINE);
    px(ctx, 24 + 3.3, by - 15.2, 1.3, 0.55, EYE_SHINE);
    px(ctx, 24 - 0.6, by - 16.4, 1.2, 0.55, EYE_SHINE);
    return;
  }
  if (pose.gesture === "knead") {
    const leftDown = pose.legPhase < 0.5;
    limbs.forEach((limb, i) => {
      const d = i === 0 ? -1 : 1;
      const down = d === -1 ? leftDown : !leftDown;
      curvedLimb(ctx, limb.from, limb.ctrl, limb.to, 1.7);
      blob(ctx, limb.to.x, limb.to.y, 2.5, 1.6, FUR);
      if (down) px(ctx, limb.to.x - 1, limb.to.y + 1, 2, 0.8, PAW_GLEAM);
    });
    return;
  }
  if (pose.gesture === "pawUp" || pose.gesture === "groom" || pose.gesture === "scratch" || pose.gesture === "swat") {
    const [raised, resting] = limbs;
    curvedLimb(ctx, raised.from, raised.ctrl, raised.to, 1.7);
    blob(ctx, raised.to.x, raised.to.y, 2.2, 1.8, FUR);
    curvedLimb(ctx, resting.from, resting.ctrl, resting.to, 1.7);
    blob(ctx, resting.to.x, resting.to.y, 2.8, 1.6, FUR);
    return;
  }
  if (PAW_GESTURES.has(pose.gesture)) {
    // Paws on the face come later (drawFacePaws), in front of the head.
    for (const limb of limbs) if (!limb.overFace) drawGestureLimb(ctx, limb);
    if (pose.gesture === "stompDown") {
      px(ctx, 29.5 - 3.4, 42.2, 1.2, 0.5, EYE_SHINE);
      px(ctx, 29.5 + 2.4, 42.2, 1.2, 0.5, EYE_SHINE);
    }
    return;
  }
  for (const limb of limbs) {
    // Foreleg down to the paw. The paws sit on a fixed ground line while the
    // torso height varies by species (a leggy siamese rides higher on a
    // negative bodyDrop), which left them floating clear of the body. The limb
    // starts inside the torso, so it only becomes visible across the gap it fills.
    curvedLimb(ctx, limb.from, limb.ctrl, limb.to, 1.7);
    if (SOCKED) {
      // White boots: draw the whole front paw pale, not a two-pixel gleam.
      blob(ctx, limb.to.x, limb.to.y, 3, 1.9, SOCK);
      blob(ctx, limb.to.x, limb.to.y - 1.6, 2.3, 1.2, SOCK);
    } else {
      blob(ctx, limb.to.x, limb.to.y, 3, 1.9, FUR);
      px(ctx, limb.to.x - 1.4, limb.to.y + 1, 1, 0.8, PAW_GLEAM);
      px(ctx, limb.to.x + 0.4, limb.to.y + 1, 1, 0.8, PAW_GLEAM);
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
  // Straight after the body and before the hind legs, the same seam every
  // other view uses.
  paintCostume(ctx, pose, "torso");
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

  // Geometry lives in frontAnchors so the costume overlay places a garment on
  // the very same ellipse this function draws. Everything below still mutates
  // hy for lean and clamps, which is why anchors are taken first.
  const anchors = frontAnchors(pose);
  const hx = 24;
  const hy = anchors.head.y;
  const by = anchors.torso.y;
  const brx = anchors.torso.rx;
  const bry = anchors.torso.ry;

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

  // The garment goes on BEFORE the legs, and for every body - petting
  // alternates between "sit" and "loaf" frames, so painting it only in the
  // final branch made the jacket flicker off on every other petted frame.
  paintCostume(ctx, pose, "torso");
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
    // Sleeves only where drawFrontPaws actually drew forelegs to sleeve; the
    // other two branches draw paw blobs with no limb behind them.
    paintCostume(ctx, pose, "limbs");
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
  // A paw on the face (and its sleeve) goes on after the head it touches.
  if (pose.body !== "dangle" && pose.body !== "loaf" && drawFacePaws(ctx, pose, by + 2)) paintCostume(ctx, pose, "limbs");
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
  // Same source of truth as the costume overlay - see frontAnchors above.
  const anchors = sideAnchors(pose);
  const bx = anchors.torso.x;
  const by = anchors.torso.y;
  const brx = anchors.torso.rx;
  const bry = anchors.torso.ry;
  // The play-bow of a stretch, species proportions, the head lean and the
  // edge clamps all live in sideAnchors now. Re-deriving any of them here is
  // what let the renderer and the costume overlay disagree about where the
  // cat was.
  const hx = anchors.head.x;
  const hy = anchors.head.y;
  const hrx = anchors.head.rx;
  const hry = anchors.head.ry;


  // Curled-up sleeping ball.
  if (pose.body === "lie" && pose.eyes === "closed") {
    const breath = Math.max(0, pose.headBob) * 0.45;
    // Rounded ribcage and haunch make a recognisable curled sleeping cat. The
    // curl scales with the breed so a chonk sleeps rounder than a kitten.
    const cw = SP.bodyW;
    const ch = SP.bodyH;
    blob(ctx, 25, 37.6 - breath, 12.8 * cw, (7.5 + breath * 0.25) * ch, BODY);
    blob(ctx, 31, 37.2 - breath, 7.2 * cw, 7.2 * ch, BODY);
    // Clothing before the head, ears, muzzle, tucked paws and the tail that
    // wraps across the front - all of which belong in front of it.
    paintCostume(ctx, pose, "torso");
    blob(ctx, 16, 36.5 - breath * 0.35, 7.5 * SP.head, 6.5 * SP.head, FUR);
    // Two relaxed ears, a resting muzzle, closed eye and tucked forepaws.
    const earY = 32.2 - breath * 0.35;
    tri(ctx, { x: 11.5, y: earY + 0.8 }, { x: 15.2, y: earY + 0.8 }, { x: 13.2, y: earY - 3 }, FUR[2]);
    tri(ctx, { x: 12.5, y: earY }, { x: 14.3, y: earY }, { x: 13.2, y: earY - 2 }, EAR_DARK);
    tri(ctx, { x: 16, y: earY + 0.4 }, { x: 19.8, y: earY + 0.4 }, { x: 18.1, y: earY - 3.3 }, FUR[2]);
    tri(ctx, { x: 17, y: earY - 0.2 }, { x: 18.9, y: earY - 0.2 }, { x: 18.1, y: earY - 2.2 }, EAR_DARK);
    // The head seam. This branch returns early too, so a mask or a hat came
    // off whenever the cat curled up to sleep. Before the muzzle and nose, so
    // those stay in front of it.
    paintCostume(ctx, pose, "face");
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
  // Clothing goes on after the shoulder sweep - the last fur mass that would
  // otherwise be painted over it - and before the head. It is clipped to the
  // torso, so the paws and the face stay clear regardless.
  paintCostume(ctx, pose, "torso");
  drawEar(ctx, hx - 4.2, hy - hry + 2.6, -1, pose.ears);
  drawEar(ctx, hx + 4.2, hy - hry + 2.6, 1, pose.ears);
  blob(ctx, hx, hy, hrx, hry, FUR);
  // Tiny muzzle bump + nose + smile.
  blob(ctx, hx + hrx - 2, hy + 3, 2.8, 2.2, FUR);
  blob(ctx, hx + hrx - 0.6, hy + 2.4, 0.8, 0.65, [NOSE]);
  stroke(ctx, { x: hx + hrx - 2.6, y: hy + 4.4 }, { x: hx + hrx - 1.4, y: hy + 5.2 }, { x: hx + hrx - 0.2, y: hy + 4.2 }, 0.4, MOUTH);

  LID_HEAD = { cx: hx, cy: hy, rx: hrx, ry: hry };
  drawEye(ctx, hx + 3.3, hy - 0.8, pose, true, 1);
  LID_HEAD = null;
  paintCostume(ctx, pose, "face");
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
    // After the head and before the paws, matching the rest of drawBack. This
    // branch returns early, so a costume painted only at the bottom of
    // drawBack came off the moment the cat climbed - and painting it before
    // the head instead buried anything worn ON the head under the skull.
    paintCostume(ctx, pose, "torso");
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
  // AFTER the nape patch and the stripes, unlike the other views: from behind
  // those two are body markings drawn late so they sit over the head/shoulder
  // seam, and painting the costume first left a pale disc floating on the
  // jacket. The head is clear of the torso ellipse, so nothing else moves.
  paintCostume(ctx, pose, "torso");
  if (seasonalAccessory(ctx, 24, 15.5 + pose.headBob + drop * 0.55, 11.6 * hs, 10.4 * hs, 1)) return;
  if (accessory === "headphones") {
    drawHeadphones(ctx, 24, 15.5 + pose.headBob + drop * 0.55, 11.6 * hs, 10.4 * hs);
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
  } else if (accessory === "earStuds") {
    // The ears are in full view from behind, so the studs must be too.
    drawEarStuds(ctx, 24 - 7.5 * hs, 8.8 + drop * 0.55, -1, 3.4);
    drawEarStuds(ctx, 24 + 7.5 * hs, 8.8 + drop * 0.55, 1, 3.4);
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
  paintCostume(ctx, pose, "torso");
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

function drawCat(pose: PoseSpec, size: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  // Thousands of small fillRects: software raster. The desktop cat's frames
  // are under 256 px and were software already; the Look Preview's 300 px
  // frames went to the GPU, and the command traffic cost most of a core.
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return canvas;
  ctx.imageSmoothingEnabled = false;
  S = size / 48;
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
    S = ART / 48;
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

function keyFor(pose: PoseSpec, size: number): string {
  return [
    size,
    appearanceKey,
    // A frame painted while one costume was active must never be handed back
    // for another - or for none.
    costumeCacheKey,
    poseKey(pose),
  ].join("|");
}

/**
 * What makes two poses the same frame. Other frame caches (Look Preview,
 * Featured Looks) key on this too: keyed on the raw pose instead, every tick
 * of a walk was a new float and a fresh 300 px paint - 1.1 cores in the
 * preview window.
 */
export function poseKey(pose: PoseSpec): string {
  return [
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
    pose.headTilt,
    pose.brow,
    pose.tears,
    pose.sweat ? 1 : 0,
    pose.anger ? 1 : 0,
    pose.sparkle ? 1 : 0,
  ].join("|");
}

/**
 * The frame for `pose`, rasterised at `size` device pixels - the size it will
 * be shown at, so it is blitted 1:1 and never resampled. Defaults to ART.
 */
export function renderFrame(pose: PoseSpec, size = ART): HTMLCanvasElement {
  size = Math.max(16, Math.round(size));
  const key = keyFor(pose, size);
  const cached = frameCache.get(key);
  if (cached) {
    // Re-insert to mark as most-recently-used (Map preserves insertion order).
    frameCache.delete(key);
    frameCache.set(key, cached);
    return cached;
  }
  const canvas = drawCat(pose, size);
  frameCache.set(key, canvas);
  trimCache(CACHE_LIMIT);
  return canvas;
}

/**
 * One frame drawn with a given costume painter, WITHOUT touching the live
 * painter or the frame cache - for previewing a costume the cat is not
 * wearing (Settings → Featured Looks). Synchronous, so the running cat can
 * never observe the swap.
 */
export function renderFrameWith(pose: PoseSpec, painter: CostumePainter | null, size = ART): HTMLCanvasElement {
  const live = costumePainter;
  costumePainter = painter;
  try {
    return drawCat(pose, Math.max(16, Math.round(size)));
  } finally {
    costumePainter = live;
  }
}

/**
 * A frame for a preview surface (Settings, posters, the chat header), painted
 * with the live costume but kept OUT of the live cat's cache: preview frames
 * are big, and the live cat's eye-tracking and tail phases churn that cache
 * so fast that they were evicted within a minute and repainted on every open,
 * pushing the live cat's own frames out on the way. Callers cache by
 * `previewKey` (CatPreview's shared preview cache).
 */
export function renderFramePreview(pose: PoseSpec, size = ART): HTMLCanvasElement {
  return drawCat(pose, Math.max(16, Math.round(size)));
}

/** When two `renderFramePreview` calls would paint the same picture. */
export function previewKey(pose: PoseSpec, size: number): string {
  return `${keyFor(pose, Math.max(16, Math.round(size)))}|${appearanceEpoch}`;
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

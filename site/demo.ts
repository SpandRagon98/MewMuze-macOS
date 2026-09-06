/**
 * Landing-page demo.
 *
 * Imports the real in-app sprite renderer, so the hero animation can never
 * drift out of date the way a recorded GIF or screenshot would — whatever the
 * cat looks like in the product is exactly what visitors see here.
 */
import {
  configureAppearance,
  renderFrame,
  DEFAULT_APPEARANCE,
  DEFAULT_POSE,
  type CatSpecies,
  type PoseSpec,
} from "../src/animation/spriteLoader";

const SIZE = 132; // on-canvas cat height (backing pixels)

type Mode = "walk" | "sit" | "groom" | "look";

function draw(ctx: CanvasRenderingContext2D, pose: Partial<PoseSpec>, x: number, y: number, flip: boolean): void {
  const sprite = renderFrame({ ...DEFAULT_POSE, ...pose });
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (flip) {
    ctx.translate(x, 0);
    ctx.scale(-1, 1);
    ctx.translate(-x, 0);
  }
  ctx.drawImage(sprite, x - SIZE / 2, y - SIZE, SIZE, SIZE);
  ctx.restore();
}

function startHero(): void {
  const canvas = document.getElementById("catStage") as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  configureAppearance(DEFAULT_APPEARANCE);

  const W = canvas.width;
  const groundY = canvas.height - 26;
  const ledgeY = 118; // the inner "title bar" she also walks along

  let x = W * 0.28;
  let dir = 1;
  let phase = 0;
  let mode: Mode = "walk";
  let modeTimer = 0;
  let onLedge = false;
  let blinkIn = 3 + Math.random() * 4;
  let blinking = 0;
  let last = performance.now();

  const pickMode = () => {
    const r = Math.random();
    mode = r < 0.5 ? "walk" : r < 0.72 ? "sit" : r < 0.88 ? "groom" : "look";
    modeTimer = mode === "walk" ? 3 + Math.random() * 4 : 2 + Math.random() * 3;
    if (mode === "walk" && Math.random() < 0.35) {
      onLedge = !onLedge; // hop between the ledge and the floor
      dir = Math.random() < 0.5 ? -1 : 1;
    }
  };
  pickMode();

  const step = (dt: number) => {
    modeTimer -= dt;
    if (modeTimer <= 0) pickMode();
    blinkIn -= dt;
    if (blinkIn <= 0) {
      blinking = 0.16;
      blinkIn = 3 + Math.random() * 5;
    }
    if (blinking > 0) blinking -= dt;

    const y = onLedge ? ledgeY : groundY;
    ctx.clearRect(0, 0, W, canvas.height);

    // The ledge she can walk along, drawn to read as a window title bar.
    ctx.fillStyle = "#23233a";
    ctx.fillRect(60, ledgeY, W - 120, 30);
    ctx.fillStyle = "#2e2e4a";
    ctx.fillRect(60, ledgeY, W - 120, 3);
    ctx.fillStyle = "#6f6f92";
    ctx.font = "13px ui-monospace, monospace";
    ctx.fillText("• • •   notes.md", 78, ledgeY + 20);

    // Floor line.
    ctx.fillStyle = "#1b1b2b";
    ctx.fillRect(0, groundY, W, 26);

    const eyes = blinking > 0 ? "closed" : "open";

    if (mode === "walk") {
      phase = (phase + dt * 1.55) % 1;
      x += dir * 62 * dt;
      const minX = onLedge ? 92 : 70;
      const maxX = W - (onLedge ? 92 : 70);
      if (x < minX) { x = minX; dir = 1; }
      if (x > maxX) { x = maxX; dir = -1; }
      draw(ctx, { view: "side", body: "stand", legPhase: phase, stride: 1.05, tail: "up", ears: "perk", eyes }, x, y, dir < 0);
    } else if (mode === "sit") {
      draw(ctx, { view: "front", body: "sit", tail: "wrap", eyes, mouth: "smile" }, x, y, false);
    } else if (mode === "groom") {
      phase = (phase + dt * 3) % 1;
      draw(ctx, { view: "front", body: "sit", gesture: "groom", legPhase: phase < 0.5 ? 0.2 : 0.7, eyes: "half", tail: "wrap" }, x, y, false);
    } else {
      // Looks toward the visitor's cursor, tracking it with her pupils.
      draw(ctx, { view: "front", body: "sit", tail: "wrap", eyes, pupilX: pupil.x, pupilY: pupil.y }, x, y, false);
    }
  };

  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt);
    requestAnimationFrame(frame);
  };

  // Pupils follow the visitor's pointer over the hero canvas.
  const pupil = { x: 0, y: 0 };
  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    const cx = ((e.clientX - r.left) / r.width) * W;
    const cy = ((e.clientY - r.top) / r.height) * canvas.height;
    pupil.x = Math.max(-2, Math.min(2, Math.round((cx - x) / 90)));
    pupil.y = Math.max(-2, Math.min(2, Math.round((cy - (groundY - SIZE * 0.7)) / 70)));
  });

  // Paint one frame immediately so the hero is never briefly blank (and so it
  // still shows a cat in environments that throttle requestAnimationFrame).
  step(0);
  requestAnimationFrame(frame);
}

function renderBreeds(): void {
  const row = document.getElementById("breedRow");
  if (!row) return;
  const breeds: Array<[CatSpecies, string]> = [
    ["classic", "Classic"],
    ["chonk", "Chonk"],
    ["fluffy", "Fluffy"],
    ["siamese", "Siamese"],
    ["kitten", "Kitten"],
  ];
  for (const [species, label] of breeds) {
    configureAppearance({ ...DEFAULT_APPEARANCE, species });
    const sprite = renderFrame({ ...DEFAULT_POSE, view: "front", body: "sit", tail: "wrap", mouth: "smile" });
    const cell = document.createElement("div");
    cell.className = "breed";
    const c = document.createElement("canvas");
    c.width = sprite.width;
    c.height = sprite.height;
    const cctx = c.getContext("2d");
    if (cctx) {
      cctx.imageSmoothingEnabled = false;
      cctx.drawImage(sprite, 0, 0);
    }
    const name = document.createElement("span");
    name.textContent = label;
    cell.append(c, name);
    row.append(cell);
  }
  // Leave the shared renderer back on the default look for the hero.
  configureAppearance(DEFAULT_APPEARANCE);
}

renderBreeds();
startHero();

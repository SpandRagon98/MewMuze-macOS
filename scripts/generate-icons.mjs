// Generates original placeholder app/tray icons (no external assets):
// a black pixel-cat head with big green eyes, as PNGs + a Windows .ico.
// Run: node scripts/generate-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");
mkdirSync(outDir, { recursive: true });

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// Draw a cat head into an RGBA pixel buffer at the given size.
function drawIcon(size) {
  const px = new Uint8Array(size * size * 4); // RGBA, transparent by default
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const s = size / 32; // scale relative to a 32px design
  const rect = (x, y, w, h, r, g, b) => {
    for (let yy = 0; yy < h * s; yy++) for (let xx = 0; xx < w * s; xx++) set(Math.round(x * s + xx), Math.round(y * s + yy), r, g, b);
  };
  const disc = (cx, cy, rad, r, g, b) => {
    for (let y = -rad; y <= rad; y++) for (let x = -rad; x <= rad; x++)
      if (x * x + y * y <= rad * rad) set(Math.round((cx + x) * s), Math.round((cy + y) * s), r, g, b);
  };
  const fur = [18, 18, 24];
  const eye = [67, 255, 106];
  const nose = [255, 155, 179];
  // ears
  rect(6, 4, 5, 6, ...fur);
  rect(21, 4, 5, 6, ...fur);
  // head
  disc(16, 18, 12, ...fur);
  // eyes
  rect(10, 15, 4, 6, ...eye);
  rect(18, 15, 4, 6, ...eye);
  set(Math.round(13 * s), Math.round(15 * s), 234, 255, 240);
  set(Math.round(21 * s), Math.round(15 * s), 234, 255, 240);
  // nose
  rect(15, 22, 2, 2, ...nose);
  return px;
}

function encodePNG(size) {
  const px = drawIcon(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.slice(y * size * 4, (y + 1) * size * 4).forEach((v, i) => {
      raw[y * (size * 4 + 1) + 1 + i] = v;
    });
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function encodeICO(pngSizes) {
  const images = pngSizes.map((sz) => ({ sz, data: encodePNG(sz) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = [];
  const bodies = [];
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.sz >= 256 ? 0 : img.sz;
    e[1] = img.sz >= 256 ? 0 : img.sz;
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.data.length;
    entries.push(e);
    bodies.push(img.data);
  }
  return Buffer.concat([header, ...entries, ...bodies]);
}

for (const sz of [32, 128, 256]) {
  writeFileSync(join(outDir, `${sz}x${sz}.png`), encodePNG(sz));
}
writeFileSync(join(outDir, "icon.png"), encodePNG(512));
writeFileSync(join(outDir, "icon.ico"), encodeICO([16, 32, 48, 256]));
console.log("Icons written to", outDir);

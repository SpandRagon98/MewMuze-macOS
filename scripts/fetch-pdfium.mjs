// Fetches the PDFium shared library (no pure-Rust equivalent exists) into
// src-tauri/lib/. Not vendored — Tauri's build script requires the declared
// resource lib/pdfium.dll to exist BEFORE compiling, so this is a build
// prerequisite, not optional. --force re-downloads.
// Source: https://github.com/bblanchon/pdfium-binaries

import { createWriteStream } from "node:fs";
import { mkdir, rm, stat, copyFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const libDir = join(root, "src-tauri", "lib");
// Mach-O libraries are .dylib. Naming the macOS download .so meant the file
// Tauri bundles and the file `pdfium_path` looks for never matched, so PDF ->
// images was permanently "unavailable" on macOS.
const LIB_NAME =
  process.platform === "win32"
    ? "pdfium.dll"
    : process.platform === "darwin"
      ? "libpdfium.dylib"
      : "libpdfium.so";
const target = join(libDir, LIB_NAME);

// macOS gets the UNIVERSAL archive, not -x64: MewMuze ships a universal app,
// and an Intel-only dylib inside it would fail to load on Apple Silicon (and
// break the `lipo`/codesign step for the bundle).
const ASSET =
  process.platform === "win32"
    ? "pdfium-win-x64.tgz"
    : process.platform === "darwin"
      ? "pdfium-mac-univ.tgz"
      : "pdfium-linux-x64.tgz";
const URL = `https://github.com/bblanchon/pdfium-binaries/releases/latest/download/${ASSET}`;

const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

async function main() {
  const force = process.argv.includes("--force");
  if (!force && (await exists(target))) {
    console.log(`pdfium already present at ${target}`);
    return;
  }

  await mkdir(libDir, { recursive: true });
  const tgz = join(libDir, ASSET);

  console.log(`Downloading ${URL} …`);
  const res = await fetch(URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tgz));

  // `tar` ships with Windows 10+ as well as macOS/Linux, so no archive
  // dependency is needed just to unpack one file.
  const extractDir = join(libDir, "_pdfium");
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  console.log("Extracting …");
  // Relative paths: Git Bash's tar reads an absolute "C:\..." as a remote host.
  await run("tar", ["-xzf", ASSET, "-C", "_pdfium"], { cwd: libDir });

  // The archive layout is bin/pdfium.dll (Windows) or lib/libpdfium.* elsewhere.
  const wanted = process.platform === "win32" ? "pdfium.dll" : "libpdfium";
  const found = await findFile(extractDir, wanted);
  if (!found) throw new Error(`could not find ${wanted} inside ${ASSET}`);
  await copyFile(found, target);

  await rm(extractDir, { recursive: true, force: true });
  await rm(tgz, { force: true });

  const { size } = await stat(target);
  console.log(`Installed ${target} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

async function findFile(dir, needle) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = await findFile(full, needle);
      if (hit) return hit;
    } else if (entry.name === needle || entry.name.startsWith(needle)) {
      return full;
    }
  }
  return null;
}

main().catch((err) => {
  console.error(`\nfetch-pdfium failed: ${err.message}`);
  console.error("PDF -> images will be unavailable until this succeeds.");
  process.exit(1);
});

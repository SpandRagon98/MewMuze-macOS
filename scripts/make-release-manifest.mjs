#!/usr/bin/env node
/**
 * Builds the `latest.json` update manifest from the artifacts produced by
 * `npm run app:build`, so you never hand-copy a signature.
 *
 *   node scripts/make-release-manifest.mjs https://github.com/you/repo
 *   node scripts/make-release-manifest.mjs https://example.com/downloads/App_setup.exe
 *   node scripts/make-release-manifest.mjs https://mewmuze.com/downloads/paper/
 *
 * The last form is a folder on your own site: the installer is expected at
 * <folder>/<installer file name>. Writes latest.json next to the installer.
 * Upload BOTH the installer and latest.json.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = conf.version;
const product = conf.productName ?? "MewMuze";
const nsisDir = join(root, "src-tauri/target/release/bundle/nsis");

if (!existsSync(nsisDir)) {
  console.error(`No build output at ${nsisDir}. Run: npm run app:build`);
  process.exit(1);
}

// Tauri names the NSIS installer after productName ("MewMuze Paper_0.1.11_x64-setup.exe").
const installer = `${product}_${version}_x64-setup.exe`;
const sigFile = `${installer}.sig`;
if (!existsSync(join(nsisDir, sigFile))) {
  console.error(
    "No .sig file found. Sign the installer first (docs/RELEASING.md):\n" +
      `  npx tauri signer sign -f .keys/updater.key -p '""' "${join(nsisDir, installer)}"`,
  );
  process.exit(1);
}
const signature = readFileSync(join(nsisDir, sigFile), "utf8").trim();

const destination = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!destination) {
  console.error(
    "Usage: node scripts/make-release-manifest.mjs " +
      "https://github.com/<you>/<repo> | https://example.com/downloads/App_setup.exe | https://example.com/downloads/folder/",
  );
  process.exit(1);
}
const downloadUrl = /\.exe(?:\?.*)?$/i.test(destination)
  ? destination
  : /^https:\/\/github\.com\//i.test(destination)
    ? `${destination}/releases/download/v${version}/${encodeURIComponent(installer)}`
    : `${destination}/${encodeURIComponent(installer)}`;
if (!downloadUrl.startsWith("https://")) {
  console.error("The download URL must be https:// - the updater refuses anything else.");
  process.exit(1);
}

const manifest = {
  version,
  notes: `${product} ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: downloadUrl,
    },
  },
};

const out = join(nsisDir, "latest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log(`Wrote ${out}\n`);
console.log(`Upload to the v${version} release:`);
console.log(`  • ${installer}`);
console.log(`  • latest.json`);
console.log(`\nEdit "notes" in latest.json to describe the release before uploading.`);

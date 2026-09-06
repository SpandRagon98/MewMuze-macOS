#!/usr/bin/env node
/**
 * Builds the `latest.json` update manifest from the artifacts produced by
 * `npm run app:build`, so you never hand-copy a signature.
 *
 *   node scripts/make-release-manifest.mjs https://github.com/you/repo
 *   node scripts/make-release-manifest.mjs https://example.com/downloads/App_setup.exe
 *
 * Writes latest.json next to the installer. Upload BOTH the installer and this
 * file to the GitHub release tagged v<version>.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = conf.version;
const nsisDir = join(root, "src-tauri/target/release/bundle/nsis");

if (!existsSync(nsisDir)) {
  console.error(`No build output at ${nsisDir}. Run: npm run app:build`);
  process.exit(1);
}

const installer = `MewMuze_${version}_x64-setup.exe`;
const sigFile = `${installer}.sig`;
if (!existsSync(join(nsisDir, sigFile))) {
  console.error(
    "No .sig file found. The updater signature is missing — check that\n" +
      '  • bundle.createUpdaterArtifacts is true in tauri.conf.json, and\n' +
      "  • TAURI_SIGNING_PRIVATE_KEY was set when you ran the build.",
  );
  process.exit(1);
}
const signature = readFileSync(join(nsisDir, sigFile), "utf8").trim();

const destination = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!destination) {
  console.error(
    "Usage: node scripts/make-release-manifest.mjs " +
      "https://github.com/<you>/<repo> | https://example.com/downloads/App_setup.exe",
  );
  process.exit(1);
}
const downloadUrl = /\.exe(?:\?.*)?$/i.test(destination)
  ? destination
  : `${destination}/releases/download/v${version}/${encodeURIComponent(installer)}`;

const manifest = {
  version,
  notes: `MewMuze ${version}`,
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

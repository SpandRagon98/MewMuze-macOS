#!/usr/bin/env node
/**
 * The macOS update manifest for MewMuze Paper, from a signed update archive.
 *
 *   node scripts/make-macos-manifest.mjs "MewMuze Paper.app.tar.gz" https://mewmuze.com/downloads/paper/macos/ "What changed"
 *
 * Expects "<archive>.sig" next to the archive (tauri signer sign, Paper's key).
 * The archive is the universal app, so both Mac architectures point at it.
 * Writes latest.json beside the archive; publish it at
 * https://mewmuze.com/updates/paper/macos/latest.json.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [archive, folder, notes = ""] = process.argv.slice(2);
if (!archive || !folder) {
  console.error('Usage: node scripts/make-macos-manifest.mjs <archive.tar.gz> <https folder URL> ["notes"]');
  process.exit(1);
}
if (!existsSync(`${archive}.sig`)) {
  console.error(`No ${archive}.sig - sign the archive with MewMuze Paper's updater key first.`);
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const url = `${folder.replace(/\/+$/, "")}/${encodeURIComponent(basename(archive))}`;
if (!url.startsWith("https://")) {
  console.error("The download URL must be https:// - the updater refuses anything else.");
  process.exit(1);
}
const entry = { signature: readFileSync(`${archive}.sig`, "utf8").trim(), url };
const manifest = {
  version: conf.version,
  notes: notes || `${conf.productName} ${conf.version}`,
  pub_date: new Date().toISOString(),
  platforms: { "darwin-aarch64": entry, "darwin-x86_64": entry },
};
const out = join(dirname(archive), "latest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log(`Wrote ${out} (${conf.productName} ${conf.version}) -> ${url}`);

#!/usr/bin/env node
/**
 * Seller-side licence key tool.
 *
 *   node scripts/make-license.mjs init            # one-time: create the keypair
 *   node scripts/make-license.mjs "Jane" ORDER123 # mint a key for a buyer
 *
 * `init` writes .keys/license.key (SECRET — never commit or share) and prints
 * the public key to paste into src-tauri/src/license.rs.
 *
 * Minting is offline and instant, so you can paste a key into a Gumroad /
 * Lemon Squeezy delivery email, or automate it from their purchase webhook.
 */
import { generateKeyPairSync, sign, createPrivateKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const keyDir = join(root, ".keys");
const privPath = join(keyDir, "license.key");

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

if (process.argv[2] === "init") {
  if (existsSync(privPath)) {
    console.error(`Refusing to overwrite existing key: ${privPath}`);
    console.error("Delete it deliberately first if you really mean to rotate keys");
    console.error("(every licence you have already sold will stop validating).");
    process.exit(1);
  }
  mkdirSync(keyDir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(privPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  // Raw 32-byte public key = last 32 bytes of the DER SubjectPublicKeyInfo.
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  console.log("Keypair created.\n");
  console.log(`  Private key: ${privPath}  <-- SECRET, never commit`);
  console.log("\nPaste this into src-tauri/src/license.rs as LICENSE_PUBLIC_KEY_B64:\n");
  console.log(`  ${raw.toString("base64")}\n`);
  process.exit(0);
}

const name = process.argv[2];
const order = process.argv[3] ?? "";
if (!name) {
  console.error('Usage: node scripts/make-license.mjs "Buyer name or email" [order-id]');
  console.error("       node scripts/make-license.mjs init");
  process.exit(1);
}
if (!existsSync(privPath)) {
  console.error(`No licence key found at ${privPath}. Run: node scripts/make-license.mjs init`);
  process.exit(1);
}

const privateKey = createPrivateKey(readFileSync(privPath));
const payload = Buffer.from(JSON.stringify({ n: name, o: order, t: Math.floor(Date.now() / 1000) }));
const signature = sign(null, payload, privateKey);
console.log(`${b64url(payload)}.${b64url(signature)}`);

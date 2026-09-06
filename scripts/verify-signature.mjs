#!/usr/bin/env node
/**
 * Confirms a freshly-signed .sig file's key ID matches the pubkey already
 * embedded in tauri.conf.json (and therefore in every existing install).
 * Signing with the wrong key produces a signature every installed copy of
 * the app will silently reject - this catches that before publishing.
 *
 *   node scripts/verify-signature.mjs path/to/App_setup.exe.sig
 *   node scripts/verify-signature.mjs --self-test
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The 8-byte minisign key ID embedded in a base64 pubkey or signature blob. */
function keyId(minisignBlobB64) {
  const text = Buffer.from(minisignBlobB64, "base64").toString("utf8");
  const line2 = text.split("\n")[1];
  return Buffer.from(line2, "base64").subarray(2, 10).toString("hex");
}

function main(sigPath) {
  const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const pubkeyB64 = conf.plugins?.updater?.pubkey;
  if (!pubkeyB64) {
    console.error("No plugins.updater.pubkey in tauri.conf.json.");
    process.exit(1);
  }

  const sigB64 = readFileSync(sigPath, "utf8").trim();
  const pubId = keyId(pubkeyB64);
  const sigId = keyId(sigB64);

  if (pubId !== sigId) {
    console.error(`Key ID mismatch: pubkey=${pubId} signature=${sigId}`);
    console.error(
      "This signature was made with a different key than the one embedded in\n" +
        "existing installs. Every installed copy would reject this update.",
    );
    process.exit(1);
  }
  console.log(`Signature key ID matches the embedded pubkey (${pubId}).`);
}

function selfTest() {
  // A real pubkey/signature pair from this project, and the same pubkey
  // against a signature made by a different (unrelated) minisign key.
  const pubkeyB64 =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEZCREM2MjI2QkYxMDczQTkKUldTcGN4Qy9KbUxjKzFlOXYrRnhYMkZudW5CS2JDUURCTEtkcUwyUXZBRzh0RDBITUxyZVpXeDMK";
  const matchingSigB64 =
    "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTcGN4Qy9KbUxjKy9DSlo2QXZ6QllBZjdFWUl5cnlqZ2VCZnFoMUxlOFNxU0FaRlpYanVKU01xZDhGMmk0R3Z0VjIraTZZUk5LNHFud1diaHg5Y21VMmJ6RTJCei81R1FZPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg1NTYwMjc1CWZpbGU6TWV3TXV6ZV8wLjEuMl94NjQtc2V0dXAuZXhlCkdzZHp4QlNqRDE5NUtoUXQwN1RxMWpiV0tmZFBKM2t1eGJXbS80UkNlbTk4U05QTHpsWnJLV1lUdzROc2dpZFhMdmMwNFVvb3lwY3lZcEs4d1ZYV0NBPT0K";
  const mismatchedSigB64 = Buffer.from(
    "untrusted comment: signature\nRWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n",
  ).toString("base64");

  if (keyId(pubkeyB64) !== keyId(matchingSigB64)) {
    console.error("self-test FAILED: matching pair should agree");
    process.exit(1);
  }
  if (keyId(pubkeyB64) === keyId(mismatchedSigB64)) {
    console.error("self-test FAILED: unrelated key should differ");
    process.exit(1);
  }
  console.log("self-test passed");
}

const arg = process.argv[2];
if (arg === "--self-test") selfTest();
else if (arg) main(arg);
else {
  console.error("Usage: node verify-signature.mjs <path-to-.sig-file> | --self-test");
  process.exit(1);
}

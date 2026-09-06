# Releasing & selling MewMuze

Everything here is a one-time setup except "Cutting a release", which you'll
repeat for each version.

> **Secrets live in `.keys/` and are gitignored.** Back them up somewhere safe
> (a password manager). Losing `updater.key` means you can never ship an update
> to existing installs again; losing `license.key` invalidates your ability to
> mint new licences that match the shipped public key.

---

## 1. Code signing (do this first — it's the #1 conversion killer)

**The problem.** An unsigned installer triggers Windows SmartScreen:
*"Windows protected your PC — unknown publisher"*. Most people abandon the
install right there, and no amount of good copy on the landing page fixes it.

**What to buy.** A **code-signing certificate** from a CA — Sectigo, DigiCert,
SSL.com and others resell them.

| Type | Rough cost | SmartScreen behaviour |
| --- | --- | --- |
| OV (organisation validated) | ~$200–400/yr | Warning disappears **after** you build reputation (some downloads over days/weeks) |
| EV (extended validation) | ~$300–600/yr | Trusted **immediately**, no reputation period |

EV certificates ship on a hardware token (or cloud HSM) and require a business
entity. OV is cheaper and works for individuals but you'll eat the reputation
ramp on your first release. Since mid-2023 all new certs are issued to hardware
tokens / cloud key stores — you can't just drop a `.pfx` on disk any more, so
plan for the token or a cloud-signing service.

**Wiring it up.** Once you hold a certificate, add its thumbprint to
`src-tauri/tauri.conf.json` under `bundle.windows`:

```jsonc
"windows": {
  "certificateThumbprint": "A1B2C3…",   // from certmgr.msc, spaces removed
  "digestAlgorithm": "sha256",           // already set
  "timestampUrl": "http://timestamp.digicert.com"  // already set
}
```

For a cloud/HSM signer that needs a custom command, use `signCommand` instead:

```jsonc
"windows": { "signCommand": "your-signtool sign %1" }
```

Then `npm run app:build` produces a signed exe + installer. Verify with:

```powershell
Get-AuthenticodeSignature ".\src-tauri\target\release\bundle\nsis\MewMuze_0.1.0_x64-setup.exe"
```

`Status` should read `Valid`. **Timestamping matters** — it keeps old releases
trusted after the certificate expires.

---

## 2. Updater signing key (already generated)

`.keys/updater.key` signs update manifests; its public half is already baked
into `tauri.conf.json` under `plugins.updater.pubkey`. This is *separate* from
code signing — it stops anyone who compromises your download host from pushing
a malicious "update".

### ⚠️ On Windows, do NOT try to sign during `tauri build`

The updater key here has **no password**, and there is no way to express that
through `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` on Windows. Both options fail:

| You set | What happens |
| --- | --- |
| `$env:...PASSWORD = ""` | Windows treats an empty env var as **unset**, so Tauri falls back to an interactive prompt. In a background shell there is no console to answer it and the build **hangs forever** (observed: 6 hours). |
| `$env:...PASSWORD = '""'` | Passes a literal two-quote string → `failed to decode secret key: incorrect updater private key password`. |

In both cases the installers themselves are built fine — only the `.sig` files
are missing. So **build without the signing env vars, then sign separately**.

Expect `tauri build` to finish with **exit code 1** and this message:

```
A public key has been found, but no private key. Make sure to set
`TAURI_SIGNING_PRIVATE_KEY` environment variable.
```

That is the *expected* end of an unsigned build, not a failure — check the
"Finished 2 bundles at:" lines just above it; the installers are already
written. Sign them afterwards:

```powershell
npm run app:build          # no TAURI_SIGNING_* vars set

$exe = "$PWD\src-tauri\target\release\bundle\nsis\MewMuze_0.1.0_x64-setup.exe"
& "$PWD\node_modules\.bin\tauri.cmd" signer sign -f "$PWD\.keys\updater.key" -p '""' "$exe"
```

Note `-p '""'` — a literal quoted empty string. On the **command line** (unlike
the env var) this is required, because PowerShell silently drops a genuinely
empty `""` argument to a native exe, making `-p` swallow the file path instead
and fail with "required arguments were not provided".

Verify the signature belongs to the configured key before publishing — compare
the 8-byte key id embedded in the `.sig` against `plugins.updater.pubkey`.

> **Delete stale `.sig` files before rebuilding.** They are not overwritten when
> signing is skipped, and `make-release-manifest.mjs` embeds whichever `.sig` it
> finds — pairing an old signature with a new installer makes every user's
> update fail verification. Removing them makes the script fail loudly instead.

---

## 3. Licence keys

One-time setup already done — `.keys/license.key` exists and its public key is
compiled into `src-tauri/src/license.rs`.

Mint a key per buyer:

```bash
node scripts/make-license.mjs "buyer@example.com" ORDER-1234
```

It prints a key like `eyJuIjoi….Ab3F…`. Paste that into the delivery email; the
buyer pastes it into **Settings → Unlock**. Verification is **offline** — no
server, no activation call, and their licence keeps working forever.

Automate it by calling the same script from your store's purchase webhook
(Gumroad, Lemon Squeezy and Paddle all support custom delivery / webhooks).

**Rotating the licence key invalidates every licence you have already sold.**
Don't, unless the private key leaks.

---

## 4. Cutting a release

1. Bump `version` in **both** `package.json` and `src-tauri/tauri.conf.json`.
2. Set the updater signing env vars (§2).
3. Build: `npm run app:build`
4. Generate the manifest (reads the real signature — never copy it by hand):
   ```bash
   node scripts/make-release-manifest.mjs https://github.com/<you>/<repo>
   ```
   Then edit the `notes` field in the generated `latest.json`.
5. Create a **GitHub Release** tagged `v<version>` and upload:
   - `…/bundle/nsis/MewMuze_<version>_x64-setup.exe`
   - the generated `latest.json`
6. Publish. Installed copies pick it up on their next launch check.

`latest.json` must be reachable at the URL in `tauri.conf.json`'s
`plugins.updater.endpoints`, which points at the repo's *latest* release — so
it resolves automatically for every future version.

> Signatures only appear when `bundle.createUpdaterArtifacts` is `true` (it is)
> **and** `TAURI_SIGNING_PRIVATE_KEY` was exported for that build. If the script
> reports a missing `.sig`, one of those two was skipped.

> Update the `endpoints` URL in `tauri.conf.json` to your real repo before the
> first public release — it currently points at a placeholder owner.

---

## 5. Landing page

```bash
npm run site:build     # → site-dist/
```

Deploy `site-dist/` to GitHub Pages, Netlify or Cloudflare Pages. The hero cat
is animated live by the *actual* sprite renderer, so it never goes stale.

Before publishing, replace the placeholder links in `site/index.html`:

- `data-buy` → your store checkout URL
- `data-download` → the GitHub release asset URL
- `data-support` → your support email or form

---

## 6. Pre-launch checklist

- [ ] Certificate purchased, thumbprint configured, installer shows `Valid`
- [ ] `endpoints` URL points at your real repo
- [ ] Secrets in `.keys/` backed up off-machine
- [ ] Store product created; delivery emails the licence key
- [ ] Landing-page links point at real URLs
- [ ] Fresh-VM install test: no SmartScreen warning, no console window,
      trial counts down, a minted key unlocks, update check succeeds
- [ ] `docs/MANUAL_TESTING.md` pass on a clean machine

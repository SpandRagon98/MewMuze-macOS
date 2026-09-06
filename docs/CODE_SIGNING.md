# Windows Defender / SmartScreen warnings

## Why buyers see a warning

`MewMuze_0.1.1_x64-setup.exe` is **unsigned**. Windows shows
"Windows protected your PC" (SmartScreen) for unsigned installers from an
unknown publisher, and Defender is more willing to quarantine them.

This cannot be fixed in application code. It is not caused by anything in
MewMuze — it is Windows' policy for executables with no trusted publisher
identity and no download reputation. Anyone claiming a code-only fix is
describing an evasion technique, not a solution.

Two things drive the warning, and they are separate:

| Factor | What it is | How it is fixed |
| --- | --- | --- |
| **Publisher identity** | Who signed this binary | A code-signing certificate |
| **Reputation** | How many people installed it safely | Downloads over time, or an EV certificate |

An unsigned build has neither, so it starts at the worst position and never
improves — every new version is a stranger again.

## Now: free mitigations

These reduce Defender false-positives but do **not** remove the SmartScreen
warning. Do them regardless.

1. **Submit the installer to Microsoft for analysis.**
   <https://www.microsoft.com/en-us/wdsi/filesubmission> — submit as a
   software developer, category "incorrectly detected". Turnaround is usually
   a few days. Repeat for each release that gets flagged.
2. **Serve the installer only over HTTPS from mewmuze.com.** Already true.
   Mirrors and shortened links reset reputation and look worse.
3. **Keep the filename and download URL stable across releases.** Reputation
   is tracked per URL and per binary.
4. **Tell buyers what to expect.** A short line on the success page —
   "Windows may show 'Windows protected your PC'. Click More info → Run
   anyway." — converts far better than a surprised customer abandoning the
   install. Honest, and it costs nothing.
5. **Do not** tell customers to disable Defender or add exclusions. It trains
   them into an unsafe habit and is a bad look for a paid product.

## Next: the certificate (the actual fix)

Since June 2023, all new code-signing certificates require the private key to
live on certified hardware (a USB token or a cloud HSM). You cannot get a
plain `.pfx` file anymore.

| Option | Rough cost | SmartScreen behaviour | Notes |
| --- | --- | --- | --- |
| **Azure Trusted Signing** | ~$10/month | Builds reputation over time | Cheapest by far, no hardware token, integrates with CI. Requires an eligible business identity; individuals/new orgs may not qualify. Check eligibility first. |
| **OV certificate** (Sectigo, DigiCert…) | ~$200–400/year | Builds reputation over time | Ships on a USB hardware token, which makes CI signing awkward. |
| **EV certificate** | ~$400–700/year | **Immediate** trust, no warning | Hardware token, strictest identity vetting. The only option that removes the warning on day one. |

**Recommendation:** try Azure Trusted Signing first — an order of magnitude
cheaper and CI-friendly. If MewMuze is not eligible, an OV certificate is the
practical middle ground; only buy EV if the first-run warning is measurably
costing sales.

Costs above are indicative — confirm current pricing with the vendor.

## Wiring a certificate in once you have one

`src-tauri/tauri.conf.json` already sets `digestAlgorithm` and `timestampUrl`
(timestamping is what keeps old releases trusted after the certificate
expires). Only the identity is missing.

For Azure Trusted Signing, or any HSM/token setup, add a `signCommand` to
`bundle.windows` — Tauri pipes the built binary path to it:

```jsonc
"windows": {
  "digestAlgorithm": "sha256",
  "timestampUrl": "http://timestamp.digicert.com",
  "signCommand": "trusted-signing-cli -e <endpoint> -a <account> -c <profile> %1"
}
```

For a certificate installed in the Windows store, use its thumbprint instead:

```jsonc
"certificateThumbprint": "<thumbprint>"
```

Then rebuild, and verify before publishing:

```bash
signtool verify /pa /v "src-tauri/target/release/bundle/nsis/MewMuze_0.1.1_x64-setup.exe"
```

Sign the **updater artifact** too, not just the installer — otherwise
auto-updates reintroduce an unsigned binary on every release.

> The Tauri **updater** key (`.keys/updater.key`) is a different thing and is
> not a substitute. It proves an update came from you to an *already
> installed* MewMuze. It means nothing to Windows on first install.

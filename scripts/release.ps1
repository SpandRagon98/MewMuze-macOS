<#
  .SYNOPSIS
    Cuts a MewMuze PAPER release: bumps the version, builds, signs with
    Paper's own key, generates Paper's update manifest, and stages both repos.

    Paper is kept apart from MewMuze Pro at every step, so running this can
    never offer Paper to Pro customers:
      * its own signing key          .keys\updater.key (in THIS repo)
      * its own GitHub release tag   paper-v<version>
      * its own update feed          <website>\public\updates\paper\latest.json
                                     = https://mewmuze.com/updates/paper/latest.json
      * Pro's feed, downloads and checkout pages are never touched.

  .DESCRIPTION
    Commit your actual feature/fix changes first with a normal `git commit` -
    this script only cuts the release on top of them, and refuses to run
    against a dirty tree so an unrelated half-finished edit can't ride along.

    By default this stops after committing locally in both repos and prints
    the exact push command - it does not publish to mewmuze.com on its own.
    Pass -Push to also push (which triggers the live deploy) and verify the
    result.

  .NOTES
    Do NOT pipe this script through 2>&1. Redirecting a native command's stderr
    inside PowerShell wraps each line in an ErrorRecord, and with
    $ErrorActionPreference = "Stop" that becomes a terminating error - so a
    harmless warning (vitest's jsdom canvas notice, for one) aborts the release
    even though every test passed. Run it unredirected.

  .EXAMPLE
    .\scripts\release.ps1 -Notes "Fixes the activation bug"
  .EXAMPLE
    .\scripts\release.ps1 -Notes "Fixes the activation bug" -Push
  .EXAMPLE
    .\scripts\release.ps1 -Version 0.2.0 -Notes "Adds seasonal costumes"
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Notes,
  [string]$Version = "",
  [switch]$Push,
  [switch]$SkipTests,
  [string]$WebsiteRepo = "C:\Users\SPANDAN\Documents\Codex\2026-07-19\c-users-spandan-downloads-pixel-cat\work\mewmuze-hostinger-deploy",
  [string]$GitHubRepo = "SpandRagon98/PawPico-Website"
)

$ErrorActionPreference = "Stop"

# ---- macOS tree guard ----------------------------------------------------
# This is the macOS port. release.ps1 publishes the WINDOWS installer: it
# pushes to the Windows website repo and cuts a GitHub release whose assets
# the Windows updater manifest points at. Running it from here would
# overwrite the Windows download with whatever this tree happens to contain.
#
# macOS releases are built by scripts/build-macos.sh on a Mac (or by the
# macOS CI workflow) and published to the separate macOS update channel
# declared in src-tauri/tauri.macos.conf.json. See docs/MACOS_PORT.md.
Write-Host ""
Write-Host "release.ps1 is the WINDOWS release script and must not be run from the macOS tree." -ForegroundColor Red
Write-Host "Windows releases are cut from the Windows Pro source folder." -ForegroundColor Yellow
Write-Host "macOS releases: ./scripts/build-macos.sh on a Mac, or the macOS CI workflow." -ForegroundColor Yellow
Write-Host ""
exit 1
# --------------------------------------------------------------------------
# PowerShell 5.1 still negotiates TLS 1.0 by default, which api.github.com refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Fail($msg) {
  Write-Host "`nRELEASE ABORTED: $msg" -ForegroundColor Red
  exit 1
}

<#
  A GitHub token, never stored by this script.

  Prefers $env:GITHUB_TOKEN (set it for CI or a non-interactive run), and
  otherwise borrows the credential Git Credential Manager already holds for
  github.com - the same one `git push` uses, so there is usually nothing to
  set up. It needs `repo` scope to publish a release.
#>
function Get-GitHubToken {
  if ($env:GITHUB_TOKEN) { return $env:GITHUB_TOKEN }
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "mewmuze-cred-in.txt"
  try {
    [System.IO.File]::WriteAllText($tmp, "protocol=https`nhost=github.com`n`n")
    $out = & cmd /c "git credential fill < `"$tmp`"" 2>$null
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
  $line = $out | Where-Object { $_ -like "password=*" } | Select-Object -First 1
  if (-not $line) {
    Fail ("Could not get a GitHub token. Either set `$env:GITHUB_TOKEN, or run " +
      "`git push` once so Git Credential Manager stores a github.com credential. " +
      "(A non-interactive shell cannot prompt for one.)")
  }
  return $line.Substring(9)
}

<#
  Publish the installer as a release asset and return its download URL.

  The installer is deliberately NOT committed: at ~5.7 MB per release it was
  the entire reason the website repo had grown to tens of megabytes and pushes
  had started timing out. Git never forgets a blob, so the only fix is to stop
  adding them.
#>
function Publish-Installer($token, $version, $exePath, $notes) {
  $headers = @{
    Authorization = "Bearer $token"
    "User-Agent"  = "mewmuze-release"
    Accept        = "application/vnd.github+json"
  }
  # paper-v*, never v*: Pro's releases use the same version numbers.
  $tag = "paper-v$version"
  $api = "https://api.github.com/repos/$GitHubRepo"

  # Reuse the release if a previous attempt already made it, so a retry is safe.
  $release = $null
  try {
    $release = Invoke-RestMethod -Uri "$api/releases/tags/$tag" -Headers $headers -TimeoutSec 60
  } catch {
    $body = @{ tag_name = $tag; name = "MewMuze Paper $version"; body = $notes } | ConvertTo-Json
    try {
      $release = Invoke-RestMethod -Uri "$api/releases" -Method Post -Headers $headers -Body $body -ContentType "application/json" -TimeoutSec 60
    } catch {
      Fail "Could not create the GitHub release ${tag}: $($_.Exception.Message)"
    }
  }

  $fileName = Split-Path $exePath -Leaf
  # An asset left over from a failed attempt would make the upload 422.
  foreach ($existing in $release.assets | Where-Object { $_.name -eq $fileName }) {
    try {
      Invoke-RestMethod -Uri "$api/releases/assets/$($existing.id)" -Method Delete -Headers $headers -TimeoutSec 60 | Out-Null
    } catch {
      Fail "Could not replace the existing $fileName asset: $($_.Exception.Message)"
    }
  }

  $uploadBase = $release.upload_url -replace '\{.*\}', ''
  Write-Host "Uploading $fileName to $tag (this is the slow part)..." -ForegroundColor Cyan
  try {
    $asset = Invoke-RestMethod -Uri "${uploadBase}?name=$fileName" -Method Post `
      -Headers $headers -ContentType "application/octet-stream" -InFile $exePath -TimeoutSec 900
  } catch {
    Fail "Uploading the installer failed: $($_.Exception.Message)"
  }
  if (-not $asset.browser_download_url) { Fail "GitHub accepted the upload but returned no download URL." }
  return $asset.browser_download_url
}

if (-not (Test-Path $WebsiteRepo)) {
  Fail "Website repo not found at $WebsiteRepo (pass -WebsiteRepo <path> if it moved)."
}
if (-not (Test-Path (Join-Path $root ".keys\updater.key"))) {
  Fail "Missing .keys\updater.key - can't sign a release without it."
}

# ---- Pre-flight: both trees must be clean ----
$dirty = git status --porcelain
if ($dirty) { Fail "MewMuze Paper has uncommitted changes - commit your actual fix/feature first:`n$dirty" }
Push-Location $WebsiteRepo
$dirtyWeb = git status --porcelain
Pop-Location
if ($dirtyWeb) { Fail "$WebsiteRepo has uncommitted changes - this script only touches release files, so start clean:`n$dirtyWeb" }

# ---- Resolve version ----
$confPath = Join-Path $root "src-tauri\tauri.conf.json"
$conf = Get-Content $confPath -Raw | ConvertFrom-Json
$oldVersion = $conf.version
$product = $conf.productName
if ($product -ne "MewMuze Paper") { Fail "This script releases MewMuze Paper only (productName is '$product')." }
if ($conf.plugins.updater.endpoints -notcontains "https://mewmuze.com/updates/paper/latest.json") {
  Fail "plugins.updater.endpoints must be https://mewmuze.com/updates/paper/latest.json - Paper must never read Pro's feed."
}
if (-not $Version) {
  $p = $oldVersion.Split('.')
  $p[2] = [string]([int]$p[2] + 1)
  $Version = $p -join '.'
}
if ($Version -eq $oldVersion) {
  Fail "New version ($Version) is the same as the current one - the updater won't offer this to existing installs."
}
Write-Host "Releasing $oldVersion -> $Version" -ForegroundColor Cyan

# ---- Tests (unless -SkipTests) ----
if (-not $SkipTests) {
  Write-Host "`n== Desktop: typecheck, lint, tests ==" -ForegroundColor Cyan
  npm run typecheck; if ($LASTEXITCODE -ne 0) { Fail "typecheck failed" }
  npm run lint; if ($LASTEXITCODE -ne 0) { Fail "lint failed" }
  npm test; if ($LASTEXITCODE -ne 0) { Fail "vitest failed" }
  Push-Location (Join-Path $root "src-tauri")
  cargo test -q
  $cargoOk = $LASTEXITCODE -eq 0
  Pop-Location
  if (-not $cargoOk) { Fail "cargo test failed" }
} else {
  Write-Host "`nSkipping tests (-SkipTests)" -ForegroundColor Yellow
}

# ---- Bump version in all three files ----
$bumps = @(
  @{ Path = (Join-Path $root "package.json"); Old = "`"version`": `"$oldVersion`""; New = "`"version`": `"$Version`"" },
  @{ Path = $confPath;                          Old = "`"version`": `"$oldVersion`""; New = "`"version`": `"$Version`"" },
  @{ Path = (Join-Path $root "src-tauri\Cargo.toml"); Old = "version = `"$oldVersion`""; New = "version = `"$Version`"" }
)
foreach ($b in $bumps) {
  $content = Get-Content $b.Path -Raw
  if ($content -notmatch [regex]::Escape($b.Old)) { Fail "Could not find `"$($b.Old)`" in $($b.Path) - bump it manually and re-run." }
  # WriteAllText, not Set-Content -NoNewline: -NoNewline is a dynamic parameter
  # supplied by the FileSystem provider, and with a positional -Path it is not
  # always bound in time ("a parameter cannot be found that matches -NoNewline").
  # This also writes UTF-8 without a BOM, which is what these source files are.
  [System.IO.File]::WriteAllText($b.Path, ($content -replace [regex]::Escape($b.Old), $b.New))
}
Write-Host "Bumped version in package.json, tauri.conf.json, Cargo.toml" -ForegroundColor Green

# ---- Build (unsigned - Windows signing-during-build hangs, see docs/RELEASING.md) ----
$nsisDir = Join-Path $root "src-tauri\target\release\bundle\nsis"
Get-ChildItem $nsisDir -Filter "*.sig" -ErrorAction SilentlyContinue | Remove-Item -Force
Write-Host "`n== Building (a real Rust release compile - a few minutes) ==" -ForegroundColor Cyan
npm run app:build
# Exit code is expected to be non-zero here: an unsigned build ends with
# "no private key" by design (see docs/RELEASING.md). Check for the artifact
# itself rather than trust the exit code.
$exe = Join-Path $nsisDir "${product}_${Version}_x64-setup.exe"
if (-not (Test-Path $exe)) { Fail "Build did not produce $exe - check the output above for a real failure." }
Write-Host "Built $exe" -ForegroundColor Green

# ---- Sign ----
Write-Host "`n== Signing ==" -ForegroundColor Cyan
# -p '""' (a literal two-quote string) is required here, not -p "" - PowerShell
# silently drops a genuinely empty argument to a native exe, which makes -p
# swallow the file path instead. See docs/RELEASING.md.
& "$root\node_modules\.bin\tauri.cmd" signer sign -f "$root\.keys\updater.key" -p '""' "$exe"
if ($LASTEXITCODE -ne 0) { Fail "Signing failed." }
if (-not (Test-Path "$exe.sig")) { Fail "Signing reported success but $exe.sig is missing." }

node "$root\scripts\verify-signature.mjs" "$exe.sig"
if ($LASTEXITCODE -ne 0) { Fail "Signature key ID does not match plugins.updater.pubkey - see the error above. Do not publish this." }

# ---- Publish the installer to GitHub Releases ----
# Done BEFORE the manifest is written, so nothing can ever advertise a download
# URL for a file that failed to upload.
Write-Host "`n== Publishing the installer to GitHub Releases ==" -ForegroundColor Cyan
$token = Get-GitHubToken
$downloadUrl = Publish-Installer $token $Version $exe $Notes
$token = $null
Write-Host "Installer published: $downloadUrl" -ForegroundColor Green

# Confirm it is really fetchable before anything points at it.
try {
  $head = Invoke-WebRequest -Uri $downloadUrl -Method Head -MaximumRedirection 5 -UseBasicParsing -TimeoutSec 120
  if ($head.StatusCode -ne 200) { Fail "The published installer returned HTTP $($head.StatusCode)." }
} catch {
  Fail "The published installer is not downloadable: $($_.Exception.Message)"
}
Write-Host "Verified the published installer is downloadable" -ForegroundColor Green

# ---- Manifest ----
# latest.json deliberately stays on mewmuze.com: every already-installed copy
# has that endpoint compiled in, so moving it would strand existing users.
# Only the (large) installer moves to GitHub; the manifest is ~700 bytes.
Write-Host "`n== Generating manifest ==" -ForegroundColor Cyan
node "$root\scripts\make-release-manifest.mjs" "$downloadUrl"
if ($LASTEXITCODE -ne 0) { Fail "Manifest generation failed." }
$manifestPath = Join-Path $nsisDir "latest.json"
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$manifest.notes = $Notes
($manifest | ConvertTo-Json -Depth 5) | Set-Content $manifestPath
if ($manifest.platforms.'windows-x86_64'.url -ne $downloadUrl) {
  Fail "The manifest URL does not match the published asset."
}

# ---- Stage into the website repo (Paper's own feed only) ----
Write-Host "`n== Copying Paper's manifest into the website repo ==" -ForegroundColor Cyan
$feedDir = Join-Path $WebsiteRepo "public\updates\paper"
New-Item -ItemType Directory -Force -Path $feedDir | Out-Null
Copy-Item $manifestPath (Join-Path $feedDir "latest.json") -Force
# Pro's public\updates\latest.json, downloads and checkout page are deliberately untouched.
$proFeed = Join-Path $WebsiteRepo "public\updates\latest.json"
Push-Location $WebsiteRepo
$touchedPro = git status --porcelain -- "public/updates/latest.json" "app/checkout"
Pop-Location
if ($touchedPro) { Fail "Pro's feed or checkout page changed during a Paper release - refusing to continue:`n$touchedPro" }
Write-Host "Paper feed staged: public\updates\paper\latest.json" -ForegroundColor Green
Write-Host "Point the website's Paper download button at: $downloadUrl" -ForegroundColor Yellow

# ---- Website tests (unless -SkipTests) ----
Push-Location $WebsiteRepo
if (-not $SkipTests) {
  Write-Host "`n== Website: lint, tests ==" -ForegroundColor Cyan
  npm run lint
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "Website lint failed." }
  npm test
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "Website tests failed." }
}

# ---- Commit both repos ----
git add -A
git -c user.name="Spandan" -c user.email="rkenterpriseamazon08@gmail.com" commit -q -m "Ship MewMuze Paper $Version`n`n$Notes"
Pop-Location

git add -A
git -c user.name="Spandan" -c user.email="rkenterpriseamazon08@gmail.com" commit -q -m "Bump MewMuze Paper to $Version`n`n$Notes"
Write-Host "`n== Committed locally in both repos ==" -ForegroundColor Green

# ---- Push (only if -Push) ----
if ($Push) {
  Write-Host "`n== Pushing (this deploys to mewmuze.com) ==" -ForegroundColor Cyan
  Push-Location $WebsiteRepo
  git push origin main
  $pushOk = $LASTEXITCODE -eq 0
  Pop-Location
  if (-not $pushOk) { Fail "git push failed - both repos are still committed locally, push manually when ready." }
  Write-Host "`nPushed. Deploy is running:" -ForegroundColor Green
  Write-Host "  https://github.com/SpandRagon98/PawPico-Website/actions"
  Write-Host "It is NOT live yet - the deploy takes a couple of minutes." -ForegroundColor Yellow
} else {
  Write-Host "`nNOT pushed (default). To publish:" -ForegroundColor Yellow
  Write-Host "  cd `"$WebsiteRepo`"; git push origin main"
}

Write-Host "`nMewMuze Paper $Version is built, signed, and staged." -ForegroundColor Cyan

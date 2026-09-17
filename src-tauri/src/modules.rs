//! Companion Modules - downloading, verifying, installing and removing the two
//! optional local-AI modules (Paper build).
//!
//! Nothing here ever runs on its own: a download starts only from an explicit
//! Download press. Every file is pinned by URL, exact size and SHA-256; a file
//! that does not match is deleted and never installed. Downloads resume with
//! HTTP Range after a pause, a drop or a restart.
//!
//! Layout, under the OS local app-data folder (never inside the app or source):
//!
//!   models/whisper/    ggml-base-q8_0.bin, runtime/whisper-cli.exe + DLLs, installed.json
//!   models/companion/  Qwen3-1.7B-Q4_K_M.gguf, runtime/llama-server.exe + DLLs, installed.json
//!
//! Each module owns its folder, so removing one frees its space at once and
//! can never touch the other.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Model,
    /// The official runtime archive (a zip on Windows, a tar.gz on macOS); only
    /// the executable and its libraries are extracted.
    Runtime,
}

#[derive(Debug)]
pub struct FileSpec {
    pub name: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    pub kind: Kind,
}

#[derive(Debug)]
pub struct ModuleSpec {
    pub id: &'static str,
    pub folder: &'static str,
    pub version: &'static str,
    pub model_file: &'static str,
    pub runtime_exe: &'static str,
    /// The runtime ships inside the app instead of being downloaded (whisper on
    /// macOS: whisper.cpp publishes no macOS command-line build, so the macOS
    /// CI compiles one and bundles it next to the app's own executable).
    pub runtime_bundled: bool,
    pub files: &'static [FileSpec],
}

#[cfg(target_os = "macos")]
const WHISPER_EXE: &str = "whisper-cli";
#[cfg(not(target_os = "macos"))]
const WHISPER_EXE: &str = "whisper-cli.exe";
#[cfg(target_os = "macos")]
const LLAMA_EXE: &str = "llama-server";
#[cfg(not(target_os = "macos"))]
const LLAMA_EXE: &str = "llama-server.exe";

const WHISPER_MODEL: FileSpec = FileSpec {
    name: "ggml-base-q8_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base-q8_0.bin",
    size: 81_768_585,
    sha256: "c577b9a86e7e048a0b7eada054f4dd79a56bbfa911fbdacf900ac5b567cbb7d9",
    kind: Kind::Model,
};

#[cfg(not(target_os = "macos"))]
const VOICE_FILES: &[FileSpec] = &[
    FileSpec {
        name: "whisper-bin-x64.zip",
        url: "https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-bin-x64.zip",
        size: 8_361_840,
        sha256: "c2a4b60edb11f7e11a9191ffb50929535527d4d91c9903dbe3e554583bbbc63d",
        kind: Kind::Runtime,
    },
    WHISPER_MODEL,
];
/// macOS: the runtime is bundled (see `runtime_bundled`); only the model is fetched.
#[cfg(target_os = "macos")]
const VOICE_FILES: &[FileSpec] = &[WHISPER_MODEL];

/// Local Voice: whisper.cpp (MIT) + OpenAI Whisper "base" multilingual (MIT),
/// 8-bit GGML conversion from the whisper.cpp model repository.
pub const VOICE: ModuleSpec = ModuleSpec {
    id: "voice",
    folder: "whisper",
    version: "whisper.cpp b4938 · ggml-base-q8_0",
    model_file: "ggml-base-q8_0.bin",
    runtime_exe: WHISPER_EXE,
    runtime_bundled: cfg!(target_os = "macos"),
    files: VOICE_FILES,
};

/// The llama.cpp runtime both chat tiers run on: the official CPU build on
/// Windows, the official macOS build (Metal on Apple Silicon) on a Mac.
#[cfg(not(target_os = "macos"))]
const LLAMA_RUNTIME: FileSpec = FileSpec {
    name: "llama-b10894-bin-win-cpu-x64.zip",
    url: "https://github.com/ggml-org/llama.cpp/releases/download/b10894/llama-b10894-bin-win-cpu-x64.zip",
    size: 18_423_620,
    sha256: "ab847167f848e1d49c9682dc6e742d1d27de23413689c7e0348d4f1477c5a389",
    kind: Kind::Runtime,
};
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const LLAMA_RUNTIME: FileSpec = FileSpec {
    name: "llama-b10894-bin-macos-arm64.tar.gz",
    url: "https://github.com/ggml-org/llama.cpp/releases/download/b10894/llama-b10894-bin-macos-arm64.tar.gz",
    size: 11_139_927,
    sha256: "443c7c22611420dee1faced2733f338ac74077562682ce895052bf871a42fd6c",
    kind: Kind::Runtime,
};
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const LLAMA_RUNTIME: FileSpec = FileSpec {
    name: "llama-b10894-bin-macos-x64.tar.gz",
    url: "https://github.com/ggml-org/llama.cpp/releases/download/b10894/llama-b10894-bin-macos-x64.tar.gz",
    size: 11_193_227,
    sha256: "e11cf09adc71d8efc0b527a4a3d76f65d165d2ba2684aa40f64af4ec3d3f2423",
    kind: Kind::Runtime,
};

/// Local Chat: llama.cpp (MIT) + Qwen3-1.7B (Apache-2.0), Q4_K_M GGUF published
/// by ggml-org (the llama.cpp maintainers) from Qwen/Qwen3-1.7B.
pub const CHAT: ModuleSpec = ModuleSpec {
    id: "chat",
    folder: "companion",
    version: "llama.cpp b10894 · Qwen3-1.7B-Q4_K_M",
    model_file: "Qwen3-1.7B-Q4_K_M.gguf",
    runtime_exe: LLAMA_EXE,
    runtime_bundled: false,
    files: &[
        LLAMA_RUNTIME,
        FileSpec {
            name: "Qwen3-1.7B-Q4_K_M.gguf",
            url: "https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF/resolve/daeb8e2d528a760970442092f6bf1e55c3b659eb/Qwen3-1.7B-Q4_K_M.gguf",
            size: 1_282_439_264,
            sha256: "d2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5",
            kind: Kind::Model,
        },
    ],
};

/// Local Chat Lite, for PCs with 4-6 GB of memory: the same runtime with
/// Qwen3-0.6B (Apache-2.0), Q4_0 GGUF published by ggml-org from
/// Qwen/Qwen3-0.6B, pinned to a commit. About a third of the standard model's
/// memory; replies are simpler.
pub const CHAT_LITE: ModuleSpec = ModuleSpec {
    id: "chat-lite",
    folder: "companion-lite",
    version: "llama.cpp b10894 · Qwen3-0.6B-Q4_0",
    model_file: "Qwen3-0.6B-Q4_0.gguf",
    runtime_exe: LLAMA_EXE,
    runtime_bundled: false,
    files: &[
        LLAMA_RUNTIME,
        FileSpec {
            name: "Qwen3-0.6B-Q4_0.gguf",
            url: "https://huggingface.co/ggml-org/Qwen3-0.6B-GGUF/resolve/b5f37287796e5be0ea3dab2e7430873fb3f73e49/Qwen3-0.6B-Q4_0.gguf",
            size: 428_970_080,
            sha256: "da2572f16c06133561ce56accaa822216f2391ef4d37fba427801cd6736417d4",
            kind: Kind::Model,
        },
    ],
};

pub fn spec(id: &str) -> Option<&'static ModuleSpec> {
    match id {
        "voice" => Some(&VOICE),
        "chat" => Some(&CHAT),
        "chat-lite" => Some(&CHAT_LITE),
        _ => None,
    }
}

/// Extra room kept free beyond the download itself.
const DISK_MARGIN: u64 = 300 * 1024 * 1024;
const CHUNK: usize = 256 * 1024;
/// Automatic retries for a network failure before it is reported.
const RETRIES: u32 = 4;

// ---- paths ------------------------------------------------------------------------

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// `<local app data>/models`. Set once at startup from Tauri's path resolver.
pub fn models_root() -> PathBuf {
    ROOT.get().cloned().unwrap_or_else(|| {
        let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        base.join("com.spandan.pixelcat.paper").join("models")
    })
}

pub fn init(app: &AppHandle) {
    if let Ok(dir) = app.path().app_local_data_dir() {
        let _ = ROOT.set(dir.join("models"));
    }
}

pub fn module_dir(s: &ModuleSpec) -> PathBuf {
    models_root().join(s.folder)
}

pub fn runtime_dir(s: &ModuleSpec) -> PathBuf {
    module_dir(s).join("runtime")
}

pub fn model_path(s: &ModuleSpec) -> PathBuf {
    module_dir(s).join(s.model_file)
}

pub fn runtime_path(s: &ModuleSpec) -> PathBuf {
    if s.runtime_bundled {
        // Tauri places an externalBin next to the app's own executable
        // (Contents/MacOS in a bundle, target/<profile> in development).
        if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
            return dir.join(s.runtime_exe);
        }
    }
    runtime_dir(s).join(s.runtime_exe)
}

fn marker_path(s: &ModuleSpec) -> PathBuf {
    module_dir(s).join("installed.json")
}

fn part_path(dir: &Path, f: &FileSpec) -> PathBuf {
    dir.join(format!("{}.part", f.name))
}

// ---- download core (pure: no Tauri, tested against a local server) ----------------

#[derive(Debug, PartialEq)]
pub enum DlError {
    Paused,
    Network(String),
    /// The server sent a different length than pinned.
    Incomplete,
    /// SHA-256 mismatch: the file was deleted.
    Corrupt,
    Io(String),
}

impl std::fmt::Display for DlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DlError::Paused => write!(f, "Paused"),
            DlError::Network(e) => write!(f, "Download interrupted ({e}). Press Retry to resume."),
            DlError::Incomplete => write!(f, "The download ended early. Press Retry to resume."),
            DlError::Corrupt => write!(f, "The file failed its checksum and was deleted. Press Retry to download it again."),
            DlError::Io(e) => write!(f, "Could not write the file: {e}"),
        }
    }
}

pub fn agent(https_only: bool) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .https_only(https_only)
        .user_agent(concat!("MewMuzePaper/", env!("CARGO_PKG_VERSION"), " (module download)"))
        .build()
}

fn hash_file_prefix(path: &Path, hasher: &mut Sha256) -> std::io::Result<u64> {
    let mut f = File::open(path)?;
    let mut buf = vec![0u8; CHUNK];
    let mut total = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            return Ok(total);
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
}

/// Download `url` into `part`, resuming from whatever `part` already holds,
/// until it has exactly `size` bytes whose SHA-256 is `sha256`. `progress`
/// receives the running byte count. On a checksum mismatch the partial file is
/// removed; on pause or a network drop it is kept for resuming.
pub fn download_file(
    agent: &ureq::Agent,
    url: &str,
    part: &Path,
    size: u64,
    sha256: &str,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<(), DlError> {
    let mut hasher = Sha256::new();
    let mut have = if part.exists() { fs::metadata(part).map(|m| m.len()).unwrap_or(0) } else { 0 };
    if have > size {
        let _ = fs::remove_file(part);
        have = 0;
    }
    if have > 0 {
        // Resuming: the hash has to cover the bytes already on disk too.
        have = hash_file_prefix(part, &mut hasher).map_err(|e| DlError::Io(e.to_string()))?;
    }
    progress(have);

    if have < size {
        let mut req = agent.get(url);
        if have > 0 {
            req = req.set("Range", &format!("bytes={have}-"));
        }
        let resp = match req.call() {
            Ok(r) => r,
            Err(ureq::Error::Status(416, _)) => {
                // Our partial file is not a prefix the server recognises: start over.
                let _ = fs::remove_file(part);
                return Err(DlError::Network("server refused to resume".into()));
            }
            Err(e) => return Err(DlError::Network(e.to_string())),
        };
        let resumed = resp.status() == 206;
        let mut out = if resumed {
            OpenOptions::new().append(true).open(part)
        } else {
            // A plain 200 is the whole file again, from byte zero.
            hasher = Sha256::new();
            have = 0;
            File::create(part)
        }
        .map_err(|e| DlError::Io(e.to_string()))?;

        let mut reader = resp.into_reader().take(size - have + 1);
        let mut buf = vec![0u8; CHUNK];
        loop {
            if cancel.load(Ordering::Relaxed) {
                let _ = out.flush();
                return Err(DlError::Paused);
            }
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    let _ = out.flush();
                    return Err(DlError::Network(e.to_string()));
                }
            };
            if have + n as u64 > size {
                drop(out);
                let _ = fs::remove_file(part);
                return Err(DlError::Corrupt);
            }
            out.write_all(&buf[..n]).map_err(|e| DlError::Io(e.to_string()))?;
            hasher.update(&buf[..n]);
            have += n as u64;
            progress(have);
        }
        out.flush().map_err(|e| DlError::Io(e.to_string()))?;
    }

    if have != size {
        return Err(DlError::Incomplete);
    }
    let digest = format!("{:x}", hasher.finalize());
    if !digest.eq_ignore_ascii_case(sha256) {
        let _ = fs::remove_file(part);
        return Err(DlError::Corrupt);
    }
    Ok(())
}

/// A plain file name an archive may write: no folders, nothing unusual.
fn safe_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Extract `keep_exe` and its libraries from a runtime archive into `dest`,
/// flattening folders: DLLs from a Windows zip, dylibs (and the version
/// symlinks the executable loads them by) from a macOS tar.gz. Entry names are
/// reduced to their file name and checked, so a hostile archive cannot write
/// outside `dest`.
pub fn extract_runtime(archive: &Path, dest: &Path, keep_exe: &str) -> Result<Vec<String>, String> {
    if archive.to_string_lossy().ends_with(".tar.gz") {
        return extract_tar_gz(archive, dest, keep_exe);
    }
    let zip_path = archive;
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Not a valid archive: {e}"))?;
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut written = Vec::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let Some(name) = entry.enclosed_name().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())) else { continue };
        let lower = name.to_ascii_lowercase();
        let wanted = lower == keep_exe.to_ascii_lowercase() || lower.ends_with(".dll");
        if !wanted || !safe_name(&name) {
            continue;
        }
        let mut out = File::create(dest.join(&name)).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        written.push(name);
    }
    if !written.iter().any(|n| n.eq_ignore_ascii_case(keep_exe)) {
        return Err(format!("{keep_exe} was not in the archive"));
    }
    Ok(written)
}

fn extract_tar_gz(archive: &Path, dest: &Path, keep_exe: &str) -> Result<Vec<String>, String> {
    let file = File::open(archive).map_err(|e| e.to_string())?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut written = Vec::new();
    let mut links: Vec<(String, String)> = Vec::new();
    for entry in tar.entries().map_err(|e| format!("Not a valid archive: {e}"))? {
        let mut entry = entry.map_err(|e| format!("Not a valid archive: {e}"))?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
        let wanted = name == keep_exe || name.ends_with(".dylib");
        if !wanted || !safe_name(&name) {
            continue;
        }
        let kind = entry.header().entry_type();
        if kind.is_symlink() {
            // libllama.0.dylib -> libllama.0.4.0.dylib: the executable asks for
            // the short name, so the link has to exist too - but only ever to a
            // sibling file.
            let target = entry.link_name().map_err(|e| e.to_string())?.map(|t| t.to_string_lossy().into_owned()).unwrap_or_default();
            if safe_name(&target) {
                links.push((name, target));
            }
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        let out_path = dest.join(&name);
        let mut out = File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&out_path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }
        written.push(name);
    }
    for (name, target) in links {
        let link = dest.join(&name);
        let _ = fs::remove_file(&link);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).map_err(|e| e.to_string())?;
        // Only the test suite extracts a macOS archive on Windows: a copy stands in.
        #[cfg(not(unix))]
        if dest.join(&target).is_file() {
            fs::copy(dest.join(&target), &link).map_err(|e| e.to_string())?;
        }
        written.push(name);
    }
    if !written.iter().any(|n| n == keep_exe) {
        return Err(format!("{keep_exe} was not in the archive"));
    }
    Ok(written)
}

#[cfg(windows)]
pub fn free_space(dir: &Path) -> Option<u64> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    // The folder may not exist yet: ask about its nearest existing ancestor.
    let mut probe = dir.to_path_buf();
    while !probe.exists() {
        probe = probe.parent()?.to_path_buf();
    }
    let mut free = 0u64;
    unsafe { GetDiskFreeSpaceExW(&HSTRING::from(probe.as_os_str()), Some(&mut free), None, None).ok()? };
    Some(free)
}

#[cfg(target_os = "macos")]
pub fn free_space(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let mut probe = dir.to_path_buf();
    while !probe.exists() {
        probe = probe.parent()?.to_path_buf();
    }
    let path = std::ffi::CString::new(probe.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // f_bavail: blocks available to an unprivileged user, which is what we are.
    (unsafe { libc::statvfs(path.as_ptr(), &mut st) } == 0).then(|| st.f_bavail as u64 * st.f_frsize as u64)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn free_space(_dir: &Path) -> Option<u64> {
    None
}

/// The refusal shown when a download would not fit, or None when it does.
pub fn space_error(free: u64, need: u64) -> Option<String> {
    (free < need).then(|| format!("Not enough disk space: {} MB free, {} MB needed.", free / 1_048_576, need / 1_048_576))
}

/// Bytes still to fetch for a module (pinned sizes minus what is on disk).
fn remaining_bytes(s: &ModuleSpec) -> u64 {
    let dir = module_dir(s);
    s.files
        .iter()
        .map(|f| {
            if dir.join(f.name).exists() || (f.kind == Kind::Runtime && runtime_path(s).exists()) {
                0
            } else {
                f.size - fs::metadata(part_path(&dir, f)).map(|m| m.len()).unwrap_or(0).min(f.size)
            }
        })
        .sum()
}

/// Download, verify and install every file of a module into its folder.
/// Returns Paused if `cancel` was raised; files already verified are kept.
pub fn install_into(
    s: &ModuleSpec,
    agent: &ureq::Agent,
    cancel: &AtomicBool,
    report: &mut dyn FnMut(&str, u64, u64),
) -> Result<(), DlError> {
    let dir = module_dir(s);
    fs::create_dir_all(&dir).map_err(|e| DlError::Io(e.to_string()))?;
    let total: u64 = s.files.iter().map(|f| f.size).sum();
    let need = remaining_bytes(s) + s.files.iter().filter(|f| f.kind == Kind::Runtime).map(|f| f.size * 3).sum::<u64>() + DISK_MARGIN;
    if let Some(msg) = free_space(&dir).and_then(|free| space_error(free, need)) {
        return Err(DlError::Io(msg));
    }

    let mut done_before = 0u64;
    for f in s.files {
        let final_path = dir.join(f.name);
        let installed_runtime = f.kind == Kind::Runtime && runtime_path(s).exists();
        if !final_path.exists() && !installed_runtime {
            let part = part_path(&dir, f);
            let base = done_before;
            // Transient network trouble (a reset TLS handshake, a dropped
            // connection) is retried a few times, resuming each time; a
            // checksum failure or a pause is not.
            let mut attempt = 0;
            loop {
                match download_file(agent, f.url, &part, f.size, f.sha256, cancel, &mut |n| report("downloading", base + n, total)) {
                    Err(DlError::Network(_)) | Err(DlError::Incomplete) if attempt < RETRIES && !cancel.load(Ordering::Relaxed) => {
                        attempt += 1;
                        std::thread::sleep(Duration::from_secs(2 * attempt as u64));
                    }
                    other => break other?,
                }
            }
            fs::rename(&part, &final_path).map_err(|e| DlError::Io(e.to_string()))?;
        }
        if f.kind == Kind::Runtime && !installed_runtime {
            report("installing", done_before + f.size, total);
            extract_runtime(&final_path, &runtime_dir(s), s.runtime_exe).map_err(DlError::Io)?;
            // The archive has done its job; only the runtime is kept.
            let _ = fs::remove_file(&final_path);
        }
        done_before += f.size;
    }
    report("verifying", total, total);
    let marker = serde_json::json!({
        "version": s.version,
        "installedUnix": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        "files": s.files.iter().map(|f| f.name).collect::<Vec<_>>(),
    });
    fs::write(marker_path(s), serde_json::to_vec_pretty(&marker).unwrap_or_default()).map_err(|e| DlError::Io(e.to_string()))?;
    Ok(())
}

pub fn dir_size(dir: &Path) -> u64 {
    let Ok(rd) = fs::read_dir(dir) else { return 0 };
    rd.flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

/// Is a module installed and intact enough to start? (Sizes only - the full
/// hash was checked when it was installed.)
pub fn is_installed(s: &ModuleSpec) -> Result<bool, String> {
    let Ok(raw) = fs::read(marker_path(s)) else { return Ok(false) };
    let marker: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| "The install record is damaged.".to_string())?;
    let model_ok = fs::metadata(model_path(s)).map(|m| Some(m.len()) == s.files.iter().find(|f| f.name == s.model_file).map(|f| f.size)).unwrap_or(false);
    if !model_ok || !runtime_path(s).exists() {
        return Err("Module files are missing or damaged. Remove it and download again.".into());
    }
    Ok(marker.get("version").and_then(|v| v.as_str()).is_some())
}

// ---- jobs and commands ------------------------------------------------------------

#[derive(Default)]
struct Job {
    cancel: AtomicBool,
    discard: AtomicBool,
    running: AtomicBool,
    done: AtomicU64,
    total: AtomicU64,
    phase: Mutex<String>,
    error: Mutex<Option<String>>,
}

fn jobs() -> &'static Mutex<HashMap<&'static str, Arc<Job>>> {
    static J: OnceLock<Mutex<HashMap<&'static str, Arc<Job>>>> = OnceLock::new();
    J.get_or_init(|| Mutex::new(HashMap::new()))
}

fn job(id: &'static str) -> Arc<Job> {
    jobs().lock().unwrap_or_else(|p| p.into_inner()).entry(id).or_default().clone()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModuleStatus {
    pub id: String,
    pub state: String,
    pub progress: f64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub version: Option<String>,
    pub catalog_version: String,
    pub download_bytes: u64,
    pub storage_bytes: u64,
    pub error: Option<String>,
}

pub fn status_of(s: &'static ModuleSpec) -> ModuleStatus {
    let j = job(s.id);
    let total: u64 = s.files.iter().map(|f| f.size).sum();
    let dir = module_dir(s);
    let mut st = ModuleStatus {
        id: s.id.into(),
        state: "not-installed".into(),
        progress: 0.0,
        bytes_done: 0,
        bytes_total: total,
        version: None,
        catalog_version: s.version.into(),
        download_bytes: total,
        storage_bytes: dir_size(&dir),
        error: None,
    };
    if j.running.load(Ordering::Relaxed) {
        let done = j.done.load(Ordering::Relaxed);
        st.state = j.phase.lock().map(|p| p.clone()).unwrap_or_else(|_| "downloading".into());
        st.bytes_done = done;
        st.progress = done as f64 / total.max(1) as f64;
        return st;
    }
    if let Some(e) = j.error.lock().ok().and_then(|e| e.clone()) {
        st.state = "error".into();
        st.error = Some(e);
        return st;
    }
    match is_installed(s) {
        Ok(true) => {
            let v = fs::read(marker_path(s))
                .ok()
                .and_then(|r| serde_json::from_slice::<serde_json::Value>(&r).ok())
                .and_then(|m| m.get("version").and_then(|v| v.as_str()).map(String::from));
            st.state = if v.as_deref() == Some(s.version) { "installed" } else { "update-available" }.into();
            st.version = v;
            st.bytes_done = total;
            st.progress = 1.0;
        }
        Err(e) => {
            st.state = "error".into();
            st.error = Some(e);
        }
        Ok(false) => {
            let partial = total - remaining_bytes(s);
            if partial > 0 {
                st.state = "paused".into();
                st.bytes_done = partial;
                st.progress = partial as f64 / total.max(1) as f64;
            }
        }
    }
    st
}

#[tauri::command]
pub fn module_status(id: String) -> Result<ModuleStatus, String> {
    spec(&id).map(status_of).ok_or_else(|| "Unknown module".into())
}

/// Start (or resume) a download. Returns at once; progress arrives as
/// `module-progress` events and the job ends with one `module-status` event.
#[tauri::command]
pub fn module_download(app: AppHandle, id: String) -> Result<(), String> {
    let s = spec(&id).ok_or("Unknown module")?;
    let j = job(s.id);
    if j.running.swap(true, Ordering::SeqCst) {
        return Ok(()); // already running
    }
    j.cancel.store(false, Ordering::SeqCst);
    j.discard.store(false, Ordering::SeqCst);
    *j.error.lock().unwrap_or_else(|p| p.into_inner()) = None;
    std::thread::spawn(move || {
        let agent = agent(true);
        let mut last = Instant::now() - Duration::from_secs(1);
        let jj = j.clone();
        let result = install_into(s, &agent, &j.cancel, &mut |phase, done, total| {
            jj.done.store(done, Ordering::Relaxed);
            jj.total.store(total, Ordering::Relaxed);
            *jj.phase.lock().unwrap_or_else(|p| p.into_inner()) = phase.to_string();
            if last.elapsed() >= Duration::from_millis(250) || done == total {
                last = Instant::now();
                let _ = app.emit("module-progress", serde_json::json!({ "id": s.id, "phase": phase, "done": done, "total": total }));
            }
        });
        if j.discard.load(Ordering::SeqCst) {
            let dir = module_dir(s);
            for f in s.files {
                let _ = fs::remove_file(part_path(&dir, f));
            }
        }
        match result {
            Ok(()) | Err(DlError::Paused) => {}
            Err(e) => *j.error.lock().unwrap_or_else(|p| p.into_inner()) = Some(e.to_string()),
        }
        j.running.store(false, Ordering::SeqCst);
        let _ = app.emit("module-status", status_of(s));
    });
    Ok(())
}

/// Pause keeps the partial file for Resume; cancel throws it away.
#[tauri::command]
pub fn module_pause(id: String, discard: bool) -> Result<(), String> {
    let s = spec(&id).ok_or("Unknown module")?;
    let j = job(s.id);
    j.discard.store(discard, Ordering::SeqCst);
    j.cancel.store(true, Ordering::SeqCst);
    if discard && !j.running.load(Ordering::SeqCst) {
        let dir = module_dir(s);
        for f in s.files {
            let _ = fs::remove_file(part_path(&dir, f));
        }
    }
    Ok(())
}

/// Delete a module's folder. The runtime must not be running (the frontend
/// unloads it first; `local_ai` refuses to start it while the folder is going).
#[tauri::command]
pub fn module_remove(id: String) -> Result<u64, String> {
    let s = spec(&id).ok_or("Unknown module")?;
    let j = job(s.id);
    if j.running.load(Ordering::SeqCst) {
        return Err("Stop the download first.".into());
    }
    crate::local_ai::stop_module(s.id);
    let dir = module_dir(s);
    let freed = dir_size(&dir);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("Could not remove the module: {e}"))?;
    }
    *j.error.lock().unwrap_or_else(|p| p.into_inner()) = None;
    Ok(freed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;

    /// A tiny HTTP/1.1 server for one body, honouring Range. `cut` stops a
    /// response after that many bytes (a dropped connection).
    fn serve(body: Vec<u8>, cut: Option<usize>, requests: usize) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(requests) {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut start = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(r) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                        start = r.trim().trim_end_matches('-').parse().unwrap_or(0);
                    }
                }
                let slice = &body[start.min(body.len())..];
                let send = cut.map(|c| c.min(slice.len())).unwrap_or(slice.len());
                let head = if start > 0 {
                    format!("HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\n\r\n", slice.len(), start, body.len() - 1, body.len())
                } else {
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", slice.len())
                };
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&slice[..send]);
            }
        });
        format!("http://{addr}/file")
    }

    fn body() -> (Vec<u8>, String) {
        let b: Vec<u8> = (0..700_000u32).map(|i| (i % 251) as u8).collect();
        let h = format!("{:x}", Sha256::digest(&b));
        (b, h)
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mm-modules-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.join("file.part")
    }

    #[test]
    fn downloads_and_verifies() {
        let (b, h) = body();
        let url = serve(b.clone(), None, 1);
        let part = tmp("ok");
        let mut last = 0;
        download_file(&agent(false), &url, &part, b.len() as u64, &h, &AtomicBool::new(false), &mut |n| last = n).unwrap();
        assert_eq!(last, b.len() as u64);
        assert_eq!(fs::read(&part).unwrap(), b);
    }

    #[test]
    fn resumes_after_a_dropped_connection() {
        let (b, h) = body();
        // First response is cut after 300 KB; the second is a Range request.
        let url = serve(b.clone(), Some(300_000), 1);
        let part = tmp("resume");
        let first = download_file(&agent(false), &url, &part, b.len() as u64, &h, &AtomicBool::new(false), &mut |_| {});
        assert!(matches!(first, Err(DlError::Network(_)) | Err(DlError::Incomplete)), "{first:?}");
        assert_eq!(fs::metadata(&part).unwrap().len(), 300_000);
        let url = serve(b.clone(), None, 1);
        download_file(&agent(false), &url, &part, b.len() as u64, &h, &AtomicBool::new(false), &mut |_| {}).unwrap();
        assert_eq!(fs::read(&part).unwrap(), b);
    }

    #[test]
    fn rejects_and_deletes_a_corrupt_download() {
        let (mut b, h) = body();
        b[123_456] ^= 0xff; // one flipped byte
        let url = serve(b.clone(), None, 1);
        let part = tmp("corrupt");
        let r = download_file(&agent(false), &url, &part, b.len() as u64, &h, &AtomicBool::new(false), &mut |_| {});
        assert_eq!(r, Err(DlError::Corrupt));
        assert!(!part.exists(), "a corrupt file must never be kept");
    }

    #[test]
    fn pause_keeps_the_partial_file() {
        let (b, h) = body();
        let url = serve(b.clone(), None, 1);
        let part = tmp("pause");
        let cancel = AtomicBool::new(false);
        let r = download_file(&agent(false), &url, &part, b.len() as u64, &h, &cancel, &mut |n| {
            if n >= 256 * 1024 {
                cancel.store(true, Ordering::Relaxed);
            }
        });
        assert_eq!(r, Err(DlError::Paused));
        assert!(fs::metadata(&part).unwrap().len() >= 256 * 1024);
    }

    #[test]
    fn network_failure_is_reported_not_fatal() {
        // Nothing listens on this port.
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let part = tmp("down");
        let r = download_file(&agent(false), &format!("http://127.0.0.1:{port}/x"), &part, 10, "00", &AtomicBool::new(false), &mut |_| {});
        assert!(matches!(r, Err(DlError::Network(_))));
    }

    #[test]
    fn a_longer_body_than_pinned_is_corrupt() {
        let (b, h) = body();
        let url = serve(b.clone(), None, 1);
        let part = tmp("long");
        let r = download_file(&agent(false), &url, &part, (b.len() - 10) as u64, &h, &AtomicBool::new(false), &mut |_| {});
        assert_eq!(r, Err(DlError::Corrupt));
    }

    #[test]
    fn runtime_extraction_keeps_only_the_exe_and_dlls_and_blocks_traversal() {
        let dir = tmp("zip").parent().unwrap().to_path_buf();
        let zpath = dir.join("rt.zip");
        {
            let mut z = zip::ZipWriter::new(File::create(&zpath).unwrap());
            let opts = zip::write::SimpleFileOptions::default();
            for (n, data) in [("Release/whisper-cli.exe", "exe"), ("Release/ggml.dll", "dll"), ("Release/bench.exe", "x"), ("../evil.dll", "evil"), ("README.md", "r")] {
                z.start_file(n, opts).unwrap();
                z.write_all(data.as_bytes()).unwrap();
            }
            z.finish().unwrap();
        }
        let out = dir.join("runtime");
        let mut got = extract_runtime(&zpath, &out, "whisper-cli.exe").unwrap();
        got.sort();
        assert_eq!(got, vec!["ggml.dll", "whisper-cli.exe"]);
        assert!(!dir.join("evil.dll").exists());
        assert!(extract_runtime(&zpath, &dir.join("rt2"), "llama-server.exe").is_err());
    }

    #[test]
    fn macos_runtime_extraction_keeps_the_server_its_dylibs_and_their_links() {
        let dir = tmp("targz").parent().unwrap().join("targz");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let apath = dir.join("rt.tar.gz");
        {
            let gz = flate2::write::GzEncoder::new(File::create(&apath).unwrap(), flate2::Compression::fast());
            let mut t = tar::Builder::new(gz);
            let file = |t: &mut tar::Builder<_>, name: &str, data: &[u8]| {
                let mut h = tar::Header::new_gnu();
                h.set_size(data.len() as u64);
                h.set_mode(0o755);
                h.set_cksum();
                t.append_data(&mut h, name, data).unwrap();
            };
            let link = |t: &mut tar::Builder<_>, name: &str, target: &str| {
                let mut h = tar::Header::new_gnu();
                h.set_entry_type(tar::EntryType::Symlink);
                h.set_size(0);
                t.append_link(&mut h, name, target).unwrap();
            };
            file(&mut t, "llama-b1/llama-server", b"server");
            file(&mut t, "llama-b1/libllama.0.4.0.dylib", b"lib");
            file(&mut t, "llama-b1/llama-cli", b"not wanted");
            file(&mut t, "llama-b1/LICENSE", b"text");
            link(&mut t, "llama-b1/libllama.0.dylib", "libllama.0.4.0.dylib");
            // A link may only ever point at a sibling.
            link(&mut t, "llama-b1/libevil.dylib", "../../outside.dylib");
            t.into_inner().unwrap().finish().unwrap();
        }
        let out = dir.join("runtime");
        let mut got = extract_runtime(&apath, &out, "llama-server").unwrap();
        got.sort();
        assert_eq!(got, vec!["libllama.0.4.0.dylib", "libllama.0.dylib", "llama-server"]);
        // The short name the executable loads resolves to the real library.
        assert_eq!(fs::read(out.join("libllama.0.dylib")).unwrap(), b"lib");
        assert!(!out.join("libevil.dylib").exists());
        assert!(!out.join("llama-cli").exists());
        assert!(extract_runtime(&apath, &dir.join("rt2"), "whisper-cli").is_err());
    }

    /// The real, pinned macOS runtime: downloaded, checked, unpacked by our own
    /// extractor, and started. Network and ~11 MB, so only CI runs it:
    /// `cargo test -- --ignored real_macos_chat_runtime`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "downloads the real llama.cpp runtime; run explicitly in macOS CI"]
    fn real_macos_chat_runtime_installs_and_starts() {
        let dir = std::env::temp_dir().join(format!("mewmuze-real-runtime-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let part = dir.join("runtime.part");
        let f = &LLAMA_RUNTIME;
        download_file(&agent(true), f.url, &part, f.size, f.sha256, &AtomicBool::new(false), &mut |_| {}).unwrap();
        let archive = dir.join(f.name);
        fs::rename(&part, &archive).unwrap();
        let rt = dir.join("runtime");
        extract_runtime(&archive, &rt, LLAMA_EXE).unwrap();
        let out = std::process::Command::new(rt.join(LLAMA_EXE)).arg("--version").output().unwrap();
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        println!("{text}");
        assert!(out.status.success(), "llama-server did not start: {text}");
        assert!(text.contains("10894"), "unexpected version: {text}");
    }

    #[test]
    fn catalog_is_pinned_https_with_real_hashes() {
        for s in [&VOICE, &CHAT, &CHAT_LITE] {
            for f in s.files {
                assert!(f.url.starts_with("https://"), "{}", f.url);
                assert_eq!(f.sha256.len(), 64);
                assert!(f.size > 1_000_000);
            }
            assert!(s.files.iter().any(|f| f.name == s.model_file));
            // Anything not bundled must bring its runtime with it.
            assert_eq!(s.runtime_bundled, !s.files.iter().any(|f| f.kind == Kind::Runtime), "{}", s.id);
        }
        // The two modules never share a folder.
        assert_ne!(VOICE.folder, CHAT.folder);
        assert_ne!(CHAT.folder, CHAT_LITE.folder);
        assert_ne!(VOICE.folder, CHAT_LITE.folder);
    }

    #[test]
    fn free_space_is_known_here() {
        assert!(free_space(&std::env::temp_dir()).unwrap_or(1) > 0);
    }

    #[test]
    fn refuses_a_download_that_would_not_fit() {
        let msg = space_error(200 * 1_048_576, 1_600 * 1_048_576).unwrap();
        assert_eq!(msg, "Not enough disk space: 200 MB free, 1600 MB needed.");
        assert!(space_error(5_000 * 1_048_576, 1_600 * 1_048_576).is_none());
    }

    /// The whole install path against a local server: a corrupt model is
    /// rejected and never installed, a retry installs, remove frees the folder.
    #[test]
    fn install_verify_retry_and_remove_flow() {
        // A runtime zip with the exe the spec asks for.
        let mut zbuf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut zbuf);
            z.start_file("bin/fake-cli.exe", zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b"MZ fake").unwrap();
            z.finish().unwrap();
        }
        let zip_bytes = zbuf.into_inner();
        let (model, model_hash) = body();
        let zip_hash = format!("{:x}", Sha256::digest(&zip_bytes));

        let zip_url = serve(zip_bytes.clone(), None, 2);
        let mut bad_model = model.clone();
        bad_model[10] ^= 1;
        let bad_url = serve(bad_model, None, 1);
        let folder: &'static str = Box::leak(format!("selftest-{}", std::process::id()).into_boxed_str());
        let make = |model_url: String| -> &'static ModuleSpec {
            let files: &'static [FileSpec] = Box::leak(Box::new([
                FileSpec { name: "rt.zip", url: Box::leak(zip_url.clone().into_boxed_str()), size: zip_bytes.len() as u64, sha256: Box::leak(zip_hash.clone().into_boxed_str()), kind: Kind::Runtime },
                FileSpec { name: "model.bin", url: Box::leak(model_url.into_boxed_str()), size: model.len() as u64, sha256: Box::leak(model_hash.clone().into_boxed_str()), kind: Kind::Model },
            ]));
            Box::leak(Box::new(ModuleSpec { id: "selftest", folder, version: "test-1", model_file: "model.bin", runtime_exe: "fake-cli.exe", runtime_bundled: false, files }))
        };

        let bad = make(bad_url);
        let _ = fs::remove_dir_all(module_dir(bad));
        let r = install_into(bad, &agent(false), &AtomicBool::new(false), &mut |_, _, _| {});
        assert_eq!(r, Err(DlError::Corrupt));
        assert_eq!(is_installed(bad), Ok(false), "a corrupt download must never count as installed");
        assert!(!module_dir(bad).join("model.bin").exists());
        assert!(runtime_path(bad).exists(), "the verified runtime is kept for the retry");

        let good = make(serve(model.clone(), None, 1));
        install_into(good, &agent(false), &AtomicBool::new(false), &mut |_, _, _| {}).unwrap();
        assert_eq!(is_installed(good), Ok(true));
        assert!(!module_dir(good).join("rt.zip").exists(), "only the runtime is kept, not the archive");
        let used = dir_size(&module_dir(good));
        assert!(used >= model.len() as u64);

        fs::remove_dir_all(module_dir(good)).unwrap();
        assert!(!module_dir(good).exists());
        assert_eq!(is_installed(good), Ok(false));
    }

    /// The real downloads, through exactly this code. Not part of the normal
    /// run: `cargo test --release -- --ignored real_module_install --nocapture`.
    #[test]
    #[ignore]
    fn real_module_install() {
        for s in [&VOICE, &CHAT, &CHAT_LITE] {
            let t0 = Instant::now();
            let mut last = 0u64;
            install_into(s, &agent(true), &AtomicBool::new(false), &mut |phase, done, total| {
                if done - last > 50_000_000 || done == total {
                    last = done;
                    println!("{} {phase} {:.1}%", s.id, done as f64 * 100.0 / total as f64);
                }
            })
            .unwrap();
            println!("{} installed in {:.1}s at {:?} ({} MB on disk)", s.id, t0.elapsed().as_secs_f64(), module_dir(s), dir_size(&module_dir(s)) / 1_048_576);
            assert_eq!(is_installed(s), Ok(true));
        }
    }
}

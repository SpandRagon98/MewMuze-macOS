//! Local AI runtimes (Paper build): whisper.cpp for Local Voice, llama.cpp for
//! Local Chat. Both run as SEPARATE PROCESSES from the module folders:
//!
//! * a model crash, a corrupt file or an out-of-memory kill takes down that
//!   process, never the cat;
//! * every child is placed in a Windows Job Object that kills it when
//!   MewMuze exits, so no model process can outlive the app;
//! * nothing is started at launch or because a module is installed.
//!
//! Voice: one `whisper-cli` run per transcription - it exits when done, which
//! releases everything it used.
//! Chat: `llama-server` on 127.0.0.1 with a random port and a random API key,
//! started when a chat needs it and stopped by the frontend's
//! LocalAIManager after its idle grace period (or at once in Battery Saver).

use crate::modules::{self, CHAT, CHAT_LITE, VOICE};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Below-normal priority: local AI never competes with what the user is doing.
#[cfg(windows)]
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;

// ---- process plumbing -------------------------------------------------------------

#[cfg(windows)]
mod job {
    use std::sync::OnceLock;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    struct Job(HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    fn job() -> Option<&'static Job> {
        static J: OnceLock<Option<Job>> = OnceLock::new();
        J.get_or_init(|| unsafe {
            let h = CreateJobObjectW(None, None).ok()?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .ok()?;
            Some(Job(h))
        })
        .as_ref()
    }

    /// The child dies with MewMuze, even if MewMuze is killed.
    pub fn adopt(child: &std::process::Child) {
        use std::os::windows::io::AsRawHandle;
        if let Some(j) = job() {
            unsafe {
                let _ = AssignProcessToJobObject(j.0, HANDLE(child.as_raw_handle()));
            }
        }
    }
}

#[cfg(not(windows))]
mod job {
    pub fn adopt(_child: &std::process::Child) {}
}

fn command(exe: &Path) -> Command {
    let mut c = Command::new(exe);
    c.current_dir(exe.parent().unwrap_or(Path::new(".")));
    c.stdin(Stdio::null());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    c
}

/// CPU seconds and working set of a child, for the battery guard.
#[cfg(windows)]
fn process_usage(child: &Child) -> (f64, u64) {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::{FILETIME, HANDLE};
    use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::GetProcessTimes;
    let h = HANDLE(child.as_raw_handle());
    let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    let secs = |t: FILETIME| ((t.dwHighDateTime as u64) << 32 | t.dwLowDateTime as u64) as f64 / 10_000_000.0;
    let cpu = unsafe { GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) }.map(|_| secs(k) + secs(u)).unwrap_or(0.0);
    let mut mem = PROCESS_MEMORY_COUNTERS { cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32, ..Default::default() };
    let ws = if unsafe { K32GetProcessMemoryInfo(h, &mut mem, mem.cb) }.as_bool() { mem.WorkingSetSize as u64 } else { 0 };
    (cpu, ws)
}

#[cfg(not(windows))]
fn process_usage(_child: &Child) -> (f64, u64) {
    (0.0, 0)
}

/// Physical memory available right now, in bytes.
#[cfg(windows)]
pub fn available_memory() -> Option<u64> {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut m = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    unsafe { GlobalMemoryStatusEx(&mut m) }.ok()?;
    Some(m.ullAvailPhys)
}

/// Memory that can still be committed (RAM + page file) - what an allocation
/// actually needs. Free RAM is not: Windows keeps it near zero on purpose and
/// trims idle apps when something asks.
#[cfg(windows)]
fn available_commit() -> Option<u64> {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut m = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    unsafe { GlobalMemoryStatusEx(&mut m) }.ok()?;
    Some(m.ullAvailPageFile)
}

#[cfg(not(windows))]
fn available_commit() -> Option<u64> {
    None
}

#[cfg(not(windows))]
pub fn available_memory() -> Option<u64> {
    None
}

/// Installed physical memory, in bytes.
#[cfg(windows)]
pub fn total_memory() -> Option<u64> {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut m = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    unsafe { GlobalMemoryStatusEx(&mut m) }.ok()?;
    Some(m.ullTotalPhys)
}

#[cfg(not(windows))]
pub fn total_memory() -> Option<u64> {
    None
}

// ---- voice ------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub text: String,
    pub language: String,
    pub audio_seconds: f64,
    pub elapsed_ms: u64,
    /// elapsed / audio length: below 1 means faster than real time.
    pub real_time_factor: f64,
    pub threads: u32,
}

static VOICE_CHILD: Mutex<Option<Child>> = Mutex::new(None);
static VOICE_CPU: AtomicU64 = AtomicU64::new(0); // finished runs, in ms of CPU

fn wav_seconds(path: &Path) -> f64 {
    // Our own 16 kHz mono 16-bit WAVs: 44-byte header.
    std::fs::metadata(path).map(|m| (m.len().saturating_sub(44)) as f64 / 32_000.0).unwrap_or(0.0)
}

/// Parse whisper-cli's `-oj` JSON: the joined segment text and the language.
pub fn parse_whisper_json(raw: &str) -> Option<(String, String)> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let lang = v.pointer("/result/language").and_then(|l| l.as_str()).unwrap_or("").to_string();
    let text = v
        .get("transcription")?
        .as_array()?
        .iter()
        .filter_map(|s| s.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .to_string();
    Some((text, lang))
}

/// Transcribe a 16 kHz mono WAV with the installed Local Voice module.
/// `language` is "auto", "en" or "hi". Blocking; call from a worker thread.
pub fn transcribe_file(wav: &Path, language: &str, threads: u32, cancel: &AtomicBool) -> Result<Transcript, String> {
    let exe = modules::runtime_path(&VOICE);
    let model = modules::model_path(&VOICE);
    if modules::is_installed(&VOICE) != Ok(true) {
        return Err("Local Voice is not installed.".into());
    }
    let lang = match language {
        "en" | "hi" => language,
        _ => "auto",
    };
    let out_base = wav.with_extension("");
    let json_path = out_base.with_extension("json");
    let _ = std::fs::remove_file(&json_path);
    let t0 = Instant::now();
    let child = command(&exe)
        .args(["-m"]).arg(&model)
        .args(["-f"]).arg(wav)
        .args(["-l", lang, "-t", &threads.max(1).to_string(), "-np", "-nt", "-oj", "-of"])
        .arg(&out_base)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Local Voice could not start: {e}"))?;
    job::adopt(&child);
    *VOICE_CHILD.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);

    let audio = wav_seconds(wav);
    let deadline = Duration::from_secs_f64((audio * 4.0).max(90.0));
    let status = loop {
        std::thread::sleep(Duration::from_millis(50));
        let mut guard = VOICE_CHILD.lock().unwrap_or_else(|p| p.into_inner());
        let Some(child) = guard.as_mut() else { return Err("Transcription was stopped.".into()) };
        if cancel.load(Ordering::Relaxed) || t0.elapsed() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            *guard = None;
            return Err(if cancel.load(Ordering::Relaxed) { "Transcription was cancelled." } else { "Transcription took too long and was stopped." }.into());
        }
        if let Ok(Some(st)) = child.try_wait() {
            let (cpu, _) = process_usage(child);
            VOICE_CPU.fetch_add((cpu * 1000.0) as u64, Ordering::Relaxed);
            *guard = None;
            break st;
        }
    };
    if !status.success() {
        return Err(format!("Local Voice stopped unexpectedly (exit {:?}). The model may be damaged.", status.code()));
    }
    let raw = std::fs::read_to_string(&json_path).map_err(|_| "Local Voice produced no transcript.".to_string())?;
    let _ = std::fs::remove_file(&json_path);
    let (text, detected) = parse_whisper_json(&raw).ok_or("The transcript could not be read.")?;
    let elapsed = t0.elapsed();
    Ok(Transcript {
        text,
        language: if detected.is_empty() { lang.to_string() } else { detected },
        audio_seconds: audio,
        elapsed_ms: elapsed.as_millis() as u64,
        real_time_factor: if audio > 0.0 { elapsed.as_secs_f64() / audio } else { 0.0 },
        threads,
    })
}

static VOICE_CANCEL: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn voice_transcribe(path: String, language: String, threads: u32) -> Result<Transcript, String> {
    let wav = crate::audio::own_temp_file(&path).ok_or("Unknown recording.")?;
    VOICE_CANCEL.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || transcribe_file(&wav, &language, threads, &VOICE_CANCEL))
        .await
        .map_err(|_| "Transcription could not run.".to_string())?
}

#[tauri::command]
pub fn voice_cancel() {
    VOICE_CANCEL.store(true, Ordering::SeqCst);
}

// ---- chat ---------------------------------------------------------------------------

struct Server {
    child: Child,
    port: u16,
    key: String,
    threads: u32,
    /// Running the Lite model (Qwen3-0.6B) rather than the standard one.
    lite: bool,
    loaded_at: Instant,
}

static SERVER: Mutex<Option<Server>> = Mutex::new(None);
static CHAT_CPU_BEFORE: AtomicU64 = AtomicU64::new(0); // CPU ms of servers already stopped
static CHAT_CRASHES: AtomicU64 = AtomicU64::new(0);

fn random_key() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn free_port() -> Option<u16> {
    std::net::TcpListener::bind("127.0.0.1:0").ok()?.local_addr().ok().map(|a| a.port())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoadResult {
    pub load_ms: u64,
    pub threads: u32,
    pub already_loaded: bool,
}

fn local_agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(5)).timeout_read(Duration::from_secs(120)).build()
}

/// Start llama-server with the Local Chat model (standard or Lite), unless it
/// is already running with the same model and thread count. Refuses when free
/// memory is too low.
pub fn load_chat(threads: u32, ctx: u32, lite: bool) -> Result<LoadResult, String> {
    let spec = if lite { &CHAT_LITE } else { &CHAT };
    if modules::is_installed(spec) != Ok(true) {
        return Err(if lite { "Local Chat Lite is not installed." } else { "Local Chat is not installed." }.into());
    }
    {
        let mut guard = SERVER.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(s) = guard.as_mut() {
            if s.child.try_wait().ok().flatten().is_none() && s.threads == threads && s.lite == lite {
                return Ok(LoadResult { load_ms: 0, threads, already_loaded: true });
            }
            let (cpu, _) = process_usage(&s.child);
            CHAT_CPU_BEFORE.fetch_add((cpu * 1000.0) as u64, Ordering::Relaxed);
            let _ = s.child.kill();
            let _ = s.child.wait();
            *guard = None;
        }
    }
    // With the flags below the weights stay a read-only file mapping that
    // Windows pages in and out like any file, and the server's own memory
    // is ~380 MB at 4k context (it was ~1.27 GB). Refuse only when even that
    // cannot be committed; low "free RAM" is normal and Windows makes room.
    // The Lite model is ~0.43 GB of weights against 1.28 GB: its floor is lower.
    let need: u64 = if lite { 256 } else { 512 } * 1024 * 1024;
    if let Some(avail) = available_commit() {
        if avail < need {
            return Err(format!(
                "Not enough memory for Local Chat ({} MB left, about {} MB needed). Close some apps and try again.",
                avail / 1_048_576,
                need / 1_048_576
            ));
        }
    }
    let port = free_port().ok_or("No local port available.")?;
    let key = random_key();
    let t0 = Instant::now();
    let child = command(&modules::runtime_path(spec))
        .args(["-m"]).arg(modules::model_path(spec))
        .args(["--host", "127.0.0.1", "--port", &port.to_string(), "--api-key", &key])
        // Generating is memory-bound: on the 16-thread test PC, 4 threads
        // gave 17.0 tok/s and 8 gave 17.5, for twice the CPU per token. So
        // half the mode's threads generate; all of them read the prompt.
        .args(["-t", &(threads / 2).max(1).to_string(), "-tb", &threads.max(1).to_string()])
        // Plain ChatML (Qwen's native format) instead of the Jinja template:
        // with Jinja, llama-server also parses the model's output and in
        // testing rejected a Hindi reply with a 500 ("does not match the
        // expected peg-native format"). Thinking is switched off with
        // Qwen3's own "/no_think" in the system prompt instead.
        .args(["-c", &ctx.to_string(), "-np", "1", "--no-jinja", "--chat-template", "chatml", "--no-webui"])
        // Memory, measured with a 1,500-token chat: CPU weight repacking
        // copied the whole model into private RAM (1.27 GB committed -> 0.62
        // without, same tok/s); an 8-bit KV cache with flash attention and a
        // smaller batch take it to 0.36 GB. The RAM prompt cache (default
        // 8 GB) is unused with one conversation. Cost: a cold prompt reads
        // ~35 % slower - hidden by warming the cache when the chat opens.
        // Batches of 64 cost ~4 % prompt speed, but the server only notices
        // a cancel between batches: a stale mood label now stops in ~0.8 s
        // instead of finishing a 4 s batch in front of the next reply.
        .args(["--no-repack", "-cram", "0", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0", "-ub", "64", "-b", "64"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Local Chat could not start: {e}"))?;
    job::adopt(&child);
    let mut server = Server { child, port, key, threads, lite, loaded_at: Instant::now() };

    // Ready when /health answers 200 (it returns 503 while the model loads).
    let agent = local_agent();
    loop {
        if let Ok(Some(st)) = server.child.try_wait() {
            CHAT_CRASHES.fetch_add(1, Ordering::Relaxed);
            return Err(format!("Local Chat stopped while loading (exit {:?}). The model may be damaged or too large for this PC.", st.code()));
        }
        if t0.elapsed() > Duration::from_secs(120) {
            let _ = server.child.kill();
            return Err("Local Chat took too long to load.".into());
        }
        if let Ok(r) = agent.get(&format!("http://127.0.0.1:{port}/health")).call() {
            if r.status() == 200 {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    server.loaded_at = Instant::now();
    let load_ms = t0.elapsed().as_millis() as u64;
    *SERVER.lock().unwrap_or_else(|p| p.into_inner()) = Some(server);
    Ok(LoadResult { load_ms, threads, already_loaded: false })
}

pub fn unload_chat() -> bool {
    let mut guard = SERVER.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(mut s) = guard.take() {
        let (cpu, _) = process_usage(&s.child);
        CHAT_CPU_BEFORE.fetch_add((cpu * 1000.0) as u64, Ordering::Relaxed);
        let _ = s.child.kill();
        let _ = s.child.wait();
        return true;
    }
    false
}

/// Stop whatever runs from a module's folder (before it is removed).
pub fn stop_module(id: &str) {
    match id {
        "chat" | "chat-lite" => {
            unload_chat();
        }
        "voice" => {
            VOICE_CANCEL.store(true, Ordering::SeqCst);
            if let Some(mut c) = VOICE_CHILD.lock().unwrap_or_else(|p| p.into_inner()).take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
        _ => {}
    }
}

fn endpoint() -> Result<(u16, String), String> {
    let mut guard = SERVER.lock().unwrap_or_else(|p| p.into_inner());
    let s = guard.as_mut().ok_or("Local Chat is not loaded.")?;
    if let Ok(Some(st)) = s.child.try_wait() {
        CHAT_CRASHES.fetch_add(1, Ordering::Relaxed);
        *guard = None;
        return Err(format!("Local Chat stopped unexpectedly (exit {:?}).", st.code()));
    }
    Ok((s.port, s.key.clone()))
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GenStats {
    pub text: String,
    pub first_token_ms: u64,
    pub total_ms: u64,
    pub tokens: u64,
    pub tokens_per_second: f64,
    pub prompt_tokens: u64,
    pub prompt_ms: f64,
    pub finish_reason: String,
    pub cancelled: bool,
}

/// Stream one chat reply. `on_token` receives each piece of text as it comes.
/// Raising `cancel` closes the connection, which stops llama-server's
/// generation cleanly - the server itself keeps running.
pub fn generate(
    messages: &Value,
    max_tokens: u32,
    temperature: f64,
    top_p: f64,
    script: Option<&str>,
    cancel: &AtomicBool,
    on_token: &mut dyn FnMut(&str),
) -> Result<GenStats, String> {
    let mut body = json!({
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "top_p": top_p,
        "top_k": 20,
        "presence_penalty": 1.1,
        "repeat_penalty": 1.1,
        // DRY: penalise re-running any phrase already in the conversation. The
        // repeat penalties above only see the last 64 tokens (mostly the turn
        // note), so without this a small model recycled its own earlier replies
        // ("You deserve some rest and a snack" four turns running).
        "dry_multiplier": 0.8,
        "dry_base": 1.75,
        "dry_allowed_length": 2,
        // The whole context (-c 4096); this llama-server rejects -1.
        "dry_penalty_last_n": 4096,
    });
    if let Some(g) = script.and_then(script_grammar) {
        body["grammar"] = json!(g);
    }
    stream_chat(body, cancel, on_token)
}

/// The writing system a reply must stay in, as a llama.cpp grammar. Asked for
/// Hinglish, the 1.7B model answered in Devanagari - once in Gurmukhi - even
/// with the instruction last; a grammar makes the wrong script impossible to
/// sample. Only these fixed grammars exist: the frontend names one, it cannot
/// send its own.
fn script_grammar(script: &str) -> Option<String> {
    // Code-point ranges the reply may NOT contain.
    const OTHER: [(u32, u32); 5] = [(0x0600, 0x06FF), (0x0E00, 0x0E7F), (0x3040, 0x30FF), (0x3400, 0x9FFF), (0xAC00, 0xD7AF)];
    let indic = match script {
        // English and Hinglish: no Indic script at all (0900..0DFF).
        "latin" => (0x0900, 0x0DFF),
        // Hindi: Devanagari (0900..097F) stays; Bengali onwards does not.
        "devanagari" => (0x0980, 0x0DFF),
        _ => return None,
    };
    let class: String = std::iter::once(indic).chain(OTHER).map(|(a, b)| format!("\\u{a:04X}-\\u{b:04X}")).collect();
    Some(format!("root ::= [^{class}]*"))
}

/// POST a streamed chat completion and read it piece by piece, stopping as
/// soon as `cancel` is raised. Shared by replies and mood labels.
fn stream_chat(mut body: Value, cancel: &AtomicBool, on_token: &mut dyn FnMut(&str)) -> Result<GenStats, String> {
    let (port, key) = endpoint()?;
    body["stream"] = json!(true);
    let t0 = Instant::now();
    let mut stats = GenStats::default();
    let cancelled = post_sse(port, &key, &body.to_string(), cancel, &mut |line| {
        let Some(data) = line.strip_prefix("data: ") else { return true };
        if data.trim() == "[DONE]" {
            return false;
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else { return true };
        if let Some(piece) = v.pointer("/choices/0/delta/content").and_then(|c| c.as_str()) {
            if !piece.is_empty() {
                if stats.first_token_ms == 0 {
                    stats.first_token_ms = t0.elapsed().as_millis() as u64;
                }
                stats.text.push_str(piece);
                on_token(piece);
            }
        }
        if let Some(r) = v.pointer("/choices/0/finish_reason").and_then(|r| r.as_str()) {
            stats.finish_reason = r.to_string();
        }
        if let Some(t) = v.get("timings") {
            stats.tokens = t.get("predicted_n").and_then(|x| x.as_u64()).unwrap_or(stats.tokens);
            stats.tokens_per_second = t.get("predicted_per_second").and_then(|x| x.as_f64()).unwrap_or(0.0);
            stats.prompt_tokens = t.get("prompt_n").and_then(|x| x.as_u64()).unwrap_or(0);
            stats.prompt_ms = t.get("prompt_ms").and_then(|x| x.as_f64()).unwrap_or(0.0);
        }
        true
    })?;
    stats.cancelled = cancelled;
    stats.total_ms = t0.elapsed().as_millis() as u64;
    Ok(stats)
}

/// POST to llama-server over a plain socket and hand each SSE line to
/// `on_line` (return false to stop). Returns true if cancelled.
///
/// ureq cannot abandon a request while the server is still reading the
/// prompt - no bytes arrive until the first token - so a cancelled mood label
/// used to hold the next reply back by ~3 s. Closing the socket makes
/// llama-server stop within a batch (measured: a 12 s prompt abandoned after
/// 0.4 s freed the model by 1.5 s), so the socket is polled every 100 ms.
fn post_sse(port: u16, key: &str, body: &str, cancel: &AtomicBool, on_line: &mut dyn FnMut(&str) -> bool) -> Result<bool, String> {
    use std::io::{ErrorKind, Read, Write};
    let find = |h: &[u8], n: &[u8]| h.windows(n.len()).position(|w| w == n);
    let dropped = |e: std::io::Error| format!("Local Chat connection dropped: {e}");
    let mut sock = std::net::TcpStream::connect(("127.0.0.1", port)).map_err(|e| format!("Local Chat did not answer: {e}"))?;
    sock.set_read_timeout(Some(Duration::from_millis(100))).map_err(dropped)?;
    write!(
        sock,
        "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {key}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .map_err(dropped)?;
    let (mut raw, mut text, mut buf) = (Vec::new(), Vec::new(), [0u8; 8192]);
    let mut chunked: Option<bool> = None; // known once the headers are in
    let mut last = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(true); // dropping the socket tells the server to stop
        }
        let ended = match sock.read(&mut buf) {
            Ok(0) => true,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                last = Instant::now();
                false
            }
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                if last.elapsed() > Duration::from_secs(120) {
                    return Err("Local Chat did not answer in time.".into());
                }
                continue;
            }
            Err(e) => return Err(dropped(e)),
        };
        if chunked.is_none() {
            let Some(end) = find(&raw, b"\r\n\r\n") else {
                if ended {
                    return Err("Local Chat connection dropped before answering.".into());
                }
                continue;
            };
            let head = String::from_utf8_lossy(&raw[..end]).to_ascii_lowercase();
            if !head.split_whitespace().nth(1).is_some_and(|code| code == "200") {
                return Err(format!("Local Chat did not answer: {}", head.lines().next().unwrap_or_default()));
            }
            chunked = Some(head.contains("transfer-encoding: chunked"));
            raw.drain(..end + 4);
        }
        let mut done = ended;
        if chunked == Some(true) {
            while let Some(eol) = find(&raw, b"\r\n") {
                let size_hex = String::from_utf8_lossy(&raw[..eol]);
                let size = usize::from_str_radix(size_hex.split(';').next().unwrap_or("").trim(), 16)
                    .map_err(|_| "Local Chat sent a malformed reply.".to_string())?;
                if size == 0 {
                    done = true;
                    break;
                }
                if raw.len() < eol + 2 + size + 2 {
                    break; // wait for the rest of this chunk
                }
                text.extend_from_slice(&raw[eol + 2..eol + 2 + size]);
                raw.drain(..eol + 2 + size + 2);
            }
        } else {
            text.append(&mut raw);
        }
        while let Some(nl) = text.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = text.drain(..=nl).collect();
            if !on_line(String::from_utf8_lossy(&line).trim_end()) {
                return Ok(false);
            }
        }
        if done {
            return Ok(false);
        }
    }
}

/// One short non-streamed completion constrained to a JSON schema (the mood
/// metadata). Returns the raw JSON text; the frontend validates it.
///
/// Streamed internally so it can be CANCELLED: when the user sends the next
/// message before the previous one's mood is labelled, the stale request is
/// dropped mid-generation (llama-server stops when the connection closes) and
/// the reply starts at once instead of waiting ~3 s behind it.
pub fn complete_json(messages: &Value, schema: &Value, max_tokens: u32, cancel: &AtomicBool) -> Result<String, String> {
    let body = json!({
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.1,
        "json_schema": schema,
    });
    let mut text = String::new();
    let stats = stream_chat(body, cancel, &mut |piece| text.push_str(piece))?;
    if stats.cancelled {
        return Err("cancelled".into());
    }
    Ok(text)
}

fn cancels() -> &'static Mutex<std::collections::HashMap<String, Arc<AtomicBool>>> {
    static C: OnceLock<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

#[tauri::command]
pub async fn chat_load(threads: u32, ctx: u32, lite: Option<bool>) -> Result<LoadResult, String> {
    tauri::async_runtime::spawn_blocking(move || load_chat(threads, ctx.clamp(1024, 8192), lite.unwrap_or(false)))
        .await
        .map_err(|_| "Local Chat could not start.".to_string())?
}

#[tauri::command]
pub fn chat_unload() -> bool {
    unload_chat()
}

/// Stream a reply as `chat-token` events; resolves with the final stats.
#[tauri::command]
pub async fn chat_generate(
    app: AppHandle,
    request_id: String,
    messages: Value,
    max_tokens: u32,
    temperature: f64,
    top_p: Option<f64>,
    script: Option<String>,
) -> Result<GenStats, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    cancels().lock().unwrap_or_else(|p| p.into_inner()).insert(request_id.clone(), cancel.clone());
    let rid = request_id.clone();
    let top_p = top_p.unwrap_or(0.8).clamp(0.1, 1.0);
    let result = tauri::async_runtime::spawn_blocking(move || {
        generate(&messages, max_tokens.clamp(1, 1024), temperature.clamp(0.0, 1.5), top_p, script.as_deref(), &cancel, &mut |piece| {
            let _ = app.emit("chat-token", json!({ "id": rid, "text": piece }));
        })
    })
    .await
    .map_err(|_| "Local Chat could not run.".to_string())?;
    cancels().lock().unwrap_or_else(|p| p.into_inner()).remove(&request_id);
    result
}

#[tauri::command]
pub fn chat_cancel(request_id: String) {
    if let Some(c) = cancels().lock().unwrap_or_else(|p| p.into_inner()).get(&request_id) {
        c.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn chat_json(request_id: String, messages: Value, schema: Value, max_tokens: u32) -> Result<String, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    cancels().lock().unwrap_or_else(|p| p.into_inner()).insert(request_id.clone(), cancel.clone());
    let result = tauri::async_runtime::spawn_blocking(move || complete_json(&messages, &schema, max_tokens.clamp(16, 256), &cancel))
        .await
        .map_err(|_| "Local Chat could not run.".to_string())?;
    cancels().lock().unwrap_or_else(|p| p.into_inner()).remove(&request_id);
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub chat_loaded: bool,
    pub chat_threads: u32,
    pub chat_loaded_seconds: f64,
    pub chat_memory_bytes: u64,
    pub voice_busy: bool,
    pub voice_memory_bytes: u64,
    /// CPU seconds used by all local-AI processes since MewMuze started.
    pub cpu_seconds: f64,
    pub chat_crashes: u64,
    pub available_memory_bytes: u64,
    /// Installed RAM: decides whether Local Chat Lite is recommended.
    pub total_memory_bytes: u64,
    /// "lite" when the running chat model is Local Chat Lite.
    pub chat_model: &'static str,
}

#[tauri::command]
pub fn ai_status() -> AiStatus {
    let mut st = AiStatus {
        chat_loaded: false,
        chat_threads: 0,
        chat_loaded_seconds: 0.0,
        chat_memory_bytes: 0,
        voice_busy: false,
        voice_memory_bytes: 0,
        cpu_seconds: (CHAT_CPU_BEFORE.load(Ordering::Relaxed) + VOICE_CPU.load(Ordering::Relaxed)) as f64 / 1000.0,
        chat_crashes: CHAT_CRASHES.load(Ordering::Relaxed),
        available_memory_bytes: available_memory().unwrap_or(0),
        total_memory_bytes: total_memory().unwrap_or(0),
        chat_model: "",
    };
    {
        let mut guard = SERVER.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(s) = guard.as_mut() {
            if s.child.try_wait().ok().flatten().is_some() {
                CHAT_CRASHES.fetch_add(1, Ordering::Relaxed);
                st.chat_crashes += 1;
                *guard = None;
            } else {
                let (cpu, ws) = process_usage(&s.child);
                st.chat_loaded = true;
                st.chat_threads = s.threads;
                st.chat_model = if s.lite { "lite" } else { "standard" };
                st.chat_loaded_seconds = s.loaded_at.elapsed().as_secs_f64();
                st.chat_memory_bytes = ws;
                st.cpu_seconds += cpu;
            }
        }
    }
    if let Some(c) = VOICE_CHILD.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        let (cpu, ws) = process_usage(c);
        st.voice_busy = true;
        st.voice_memory_bytes = ws;
        st.cpu_seconds += cpu;
    }
    st
}

/// Where a test WAV for the benchmarks lives (not used by the app).
#[allow(dead_code)]
pub fn bench_dir() -> PathBuf {
    modules::models_root().join("bench")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_grammars_are_fixed() {
        let latin = script_grammar("latin").unwrap();
        // Escapes, not raw characters: llama.cpp reads them, and they stay reviewable.
        assert!(latin.is_ascii() && latin.starts_with("root ::= [^") && latin.ends_with("]*"), "{latin}");
        assert!(latin.contains("u0900-") && latin.contains("u0DFF") && latin.contains("u3400-"), "{latin}");
        // Hindi keeps Devanagari (0900..097F) and drops the rest of Indic.
        let hindi = script_grammar("devanagari").unwrap();
        assert!(hindi.contains("u0980-") && !hindi.contains("u0900"), "{hindi}");
        // Nothing else is accepted: the frontend cannot send its own grammar.
        assert_eq!(script_grammar("root ::= .*"), None);
        assert_eq!(script_grammar(""), None);
    }

    #[test]
    fn parses_whisper_json() {
        let raw = r#"{"result":{"language":"en"},"transcription":[{"text":" Hello there,"},{"text":" friend."}]}"#;
        assert_eq!(parse_whisper_json(raw), Some(("Hello there, friend.".into(), "en".into())));
        assert_eq!(parse_whisper_json("not json"), None);
    }

    #[test]
    fn nothing_loads_when_modules_are_absent_or_it_is_already_quiet() {
        // Default state: no server, no voice process.
        let st = ai_status();
        assert!(!st.chat_loaded);
        assert!(!st.voice_busy);
        assert!(!unload_chat(), "unloading with nothing loaded is a no-op");
        assert!(endpoint().is_err());
    }

    #[test]
    fn keys_and_ports_are_fresh() {
        assert_ne!(random_key(), random_key());
        assert!(free_port().unwrap() > 0);
    }

    /// A fake llama-server: reads one request, then plays `reply` (or nothing).
    fn fake_server(reply: Option<&'static [&'static str]>) -> u16 {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut req = [0u8; 4096];
            let _ = s.read(&mut req);
            for part in reply.unwrap_or(&[]) {
                s.write_all(part.as_bytes()).unwrap();
                std::thread::sleep(Duration::from_millis(20));
            }
            if reply.is_none() {
                std::thread::sleep(Duration::from_secs(5)); // "still reading the prompt"
            }
        });
        port
    }

    #[test]
    fn sse_lines_survive_chunk_boundaries_and_cancel_is_prompt() {
        // One SSE line split across two HTTP chunks, then the end.
        let a = "data: {\"choices\":[{\"delta\":{\"content\":\"Hel";
        let b = "lo\"}}]}\n\ndata: [DONE]\n\n";
        let reply: &'static [&'static str] = Box::leak(Box::new([
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
            Box::leak(format!("{:x}\r\n{a}\r\n", a.len()).into_boxed_str()),
            Box::leak(format!("{:x}\r\n{b}\r\n0\r\n\r\n", b.len()).into_boxed_str()),
        ]));
        let port = fake_server(Some(reply));
        let mut lines = Vec::new();
        let never = AtomicBool::new(false);
        let cancelled = post_sse(port, "k", "{}", &never, &mut |l| {
            lines.push(l.to_string());
            !l.contains("[DONE]")
        })
        .unwrap();
        assert!(!cancelled);
        assert_eq!(lines[0], format!("{a}{}", &b[..b.find('\n').unwrap()]));

        // The server never answers: cancelling returns at once, not after 5 s.
        let port = fake_server(None);
        let cancel = Arc::new(AtomicBool::new(false));
        let c2 = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            c2.store(true, Ordering::Relaxed);
        });
        let t = Instant::now();
        assert!(post_sse(port, "k", "{}", &cancel, &mut |_| true).unwrap());
        assert!(t.elapsed() < Duration::from_secs(1), "cancel took {:?}", t.elapsed());
    }

    fn server_usage() -> (f64, u64) {
        SERVER.lock().unwrap().as_ref().map(|s| process_usage(&s.child)).unwrap_or((0.0, 0))
    }

    /// Performance states C-F with the real installed models, through the
    /// app's own functions. Writes bench/results/phase2-ai-bench.json.
    ///   cargo test --release ai_bench -- --ignored --nocapture --test-threads=1
    #[test]
    #[ignore]
    fn ai_bench() {
        let bench = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("bench");
        let logical = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(8);
        let mut out = serde_json::Map::new();
        out.insert("logicalProcessors".into(), json!(logical));
        let never = AtomicBool::new(false);

        // ---- E: Whisper transcribing, at each power mode's thread count.
        let mut voice = Vec::new();
        for (mode, share) in [("saver", 0.25), ("balanced", 0.5), ("performance", 0.75)] {
            let threads = ((logical as f64 * share) as u32).max(1);
            for clip in ["en-reminder", "en-correction", "en-long"] {
                let wav = bench.join("audio").join(format!("{clip}.wav"));
                let t = transcribe_file(&wav, "auto", threads, &never).expect("transcribe");
                println!("E voice {mode:<11} t={threads:<2} {clip:<14} audio {:.1}s  took {} ms  RTF {:.3}  [{}] {}", t.audio_seconds, t.elapsed_ms, t.real_time_factor, t.language, t.text);
                voice.push(json!({ "mode": mode, "threads": threads, "clip": clip, "audioSeconds": t.audio_seconds, "elapsedMs": t.elapsed_ms, "rtf": t.real_time_factor, "language": t.language, "text": t.text }));
            }
        }
        out.insert("voice".into(), json!(voice));

        // ---- C: Qwen loaded, idle.
        let threads = (logical / 2).max(1);
        let lr = load_chat(threads, 4096, false).expect("load chat");
        println!("C chat loaded in {} ms with {threads} threads", lr.load_ms);
        std::thread::sleep(Duration::from_secs(5));
        let (c0, _) = server_usage();
        let t0 = Instant::now();
        std::thread::sleep(Duration::from_secs(60));
        let (c1, ws) = server_usage();
        let idle_pct = (c1 - c0) / t0.elapsed().as_secs_f64() * 100.0;
        println!("C chat idle 60 s: {idle_pct:.2}% of one core, working set {} MB", ws / 1_048_576);
        out.insert("chatLoad".into(), json!({ "loadMs": lr.load_ms, "threads": threads, "idleCpuPctOneCore": idle_pct, "idleWorkingSetMB": ws / 1_048_576 }));

        // ---- D: Qwen generating, three languages.
        let prompts = [
            ("en", "My manager changed everything again today. I'm so tired of it."),
            ("hi", "आज का दिन बहुत थका देने वाला था।"),
            ("hinglish", "Yaar aaj office mein bahut kaam tha, thak gaya hoon."),
        ];
        let mut gens = Vec::new();
        for (lang, text) in prompts {
            let msgs = json!([
                { "role": "system", "content": "You are MewMuze, a small pixel cat who lives on the user's desktop. You are a companion who listens, not a therapist. Listen first; reflect and ask one gentle question. 1-3 short sentences, plain text. Mirror the user's language: English stays English, Hindi stays Hindi in Devanagari, Hinglish stays Hinglish in Latin letters. /no_think" },
                { "role": "user", "content": text }
            ]);
            let (g0, _) = server_usage();
            let s = generate(&msgs, 160, 0.7, 0.8, None, &never, &mut |_| {}).expect("generate");
            let (g1, gws) = server_usage();
            let cores = (g1 - g0) / (s.total_ms as f64 / 1000.0);
            println!("D chat {lang:<8} first token {} ms, {} tokens at {:.1} tok/s, {:.2} cores, WS {} MB :: {}", s.first_token_ms, s.tokens, s.tokens_per_second, cores, gws / 1_048_576, s.text.replace('\n', " "));
            let mood = complete_json(
                &json!([
                    { "role": "system", "content": "Label the emotional tone of ONE chat message. Use only the listed values. intensity: 0 none, 1 mild, 2 clear, 3 very strong. /no_think" },
                    { "role": "user", "content": text }
                ]),
                &json!({ "type": "object", "properties": { "mood": { "type": "string", "enum": ["neutral","happy","excited","playful","tired","sad","frustrated","angry","stressed"] }, "intensity": { "type": "integer", "enum": [0, 1, 2, 3] } }, "required": ["mood","intensity"], "additionalProperties": false }),
                80,
                &never,
            )
            .unwrap_or_else(|e| format!("error: {e}"));
            println!("  mood {mood}");
            gens.push(json!({ "lang": lang, "prompt": text, "reply": s.text, "firstTokenMs": s.first_token_ms, "tokens": s.tokens, "tokensPerSecond": s.tokens_per_second, "cores": cores, "workingSetMB": gws / 1_048_576, "mood": mood }));
        }
        out.insert("chat".into(), json!(gens));

        // ---- F: voice + chat: transcribe, then answer the transcript.
        let wav = bench.join("audio").join("en-long.wav");
        let t_all = Instant::now();
        let tr = transcribe_file(&wav, "auto", threads, &never).expect("transcribe");
        let s = generate(&json!([{ "role": "system", "content": "You are MewMuze, a desktop cat who listens. 1-3 short sentences. /no_think" }, { "role": "user", "content": tr.text }]), 120, 0.7, 0.8, None, &never, &mut |_| {}).expect("generate");
        println!("F voice chat: transcribe {} ms + first token {} ms = {} ms to first word; total {} ms", tr.elapsed_ms, s.first_token_ms, tr.elapsed_ms + s.first_token_ms, t_all.elapsed().as_millis());
        out.insert("voiceChat".into(), json!({ "transcribeMs": tr.elapsed_ms, "firstTokenMs": s.first_token_ms, "totalMs": t_all.elapsed().as_millis() as u64, "tokensPerSecond": s.tokens_per_second }));

        // Unload releases the memory at once.
        assert!(unload_chat());
        assert!(!ai_status().chat_loaded);
        std::fs::write(bench.join("results").join("phase2-ai-bench.json"), serde_json::to_vec_pretty(&Value::Object(out)).unwrap()).unwrap();
    }
}

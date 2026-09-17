//! Microphone capture for Local Voice (Paper build).
//!
//! Never always-listening: the device is opened by an explicit Start
//! (dictation shortcut, Record button, microphone button) and closed by Stop.
//! Audio is low-pass filtered and resampled to 16 kHz mono in the capture
//! callback, kept in memory, and written to a WAV in MewMuze's own temp
//! folder only for the transcription, which deletes it afterwards unless the
//! user chooses to save the recording.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use std::f32::consts::PI;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const TARGET_RATE: u32 = 16_000;

// ---- DSP: mono -> low-pass -> 16 kHz ------------------------------------------------

/// RBJ low-pass biquad.
#[derive(Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn low_pass(rate: f32, cutoff: f32) -> Self {
        let w = 2.0 * PI * cutoff / rate;
        let q = std::f32::consts::FRAC_1_SQRT_2;
        let alpha = w.sin() / (2.0 * q);
        let cos = w.cos();
        let a0 = 1.0 + alpha;
        Biquad {
            b0: (1.0 - cos) / 2.0 / a0,
            b1: (1.0 - cos) / a0,
            b2: (1.0 - cos) / 2.0 / a0,
            a1: -2.0 * cos / a0,
            a2: (1.0 - alpha) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }
    fn run(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// Streaming resampler: anti-alias filter (4th order) then linear interpolation.
pub struct Resampler {
    filters: [Biquad; 2],
    step: f64,
    next_out: f64,
    t: f64,
    prev: f32,
    bypass: bool,
}

impl Resampler {
    pub fn new(in_rate: u32) -> Self {
        let r = in_rate as f32;
        let cutoff = (TARGET_RATE as f32 * 0.45).min(r * 0.45);
        Resampler {
            filters: [Biquad::low_pass(r, cutoff), Biquad::low_pass(r, cutoff)],
            step: in_rate as f64 / TARGET_RATE as f64,
            next_out: 0.0,
            t: -1.0,
            prev: 0.0,
            bypass: in_rate == TARGET_RATE,
        }
    }

    pub fn push(&mut self, x: f32, out: &mut Vec<i16>) {
        if self.bypass {
            out.push((x.clamp(-1.0, 1.0) * 32767.0) as i16);
            return;
        }
        let a = self.filters[0].run(x);
        let y = self.filters[1].run(a);
        self.t += 1.0;
        while self.next_out <= self.t {
            let frac = (self.next_out - (self.t - 1.0)) as f32;
            let v = self.prev + (y - self.prev) * frac;
            out.push((v.clamp(-1.0, 1.0) * 32767.0) as i16);
            self.next_out += self.step;
        }
        self.prev = y;
    }
}

pub fn wav_bytes(samples: &[i16], rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut v = Vec::with_capacity(44 + data_len as usize);
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&(36 + data_len).to_le_bytes());
    v.extend_from_slice(b"WAVEfmt ");
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes()); // PCM
    v.extend_from_slice(&1u16.to_le_bytes()); // mono
    v.extend_from_slice(&rate.to_le_bytes());
    v.extend_from_slice(&(rate * 2).to_le_bytes());
    v.extend_from_slice(&2u16.to_le_bytes());
    v.extend_from_slice(&16u16.to_le_bytes());
    v.extend_from_slice(b"data");
    v.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        v.extend_from_slice(&s.to_le_bytes());
    }
    v
}

// ---- temp files -------------------------------------------------------------------

fn temp_dir() -> PathBuf {
    crate::modules::models_root().parent().map(|p| p.join("recordings-tmp")).unwrap_or_else(std::env::temp_dir)
}

/// A path the frontend handed back, accepted only if it is one of our own
/// temp recordings (so these commands can never touch any other file).
pub fn own_temp_file(path: &str) -> Option<PathBuf> {
    let p = PathBuf::from(path);
    let name = p.file_name()?.to_str()?;
    let ok_name = name.starts_with("rec-") && name.ends_with(".wav") && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.'));
    let candidate = temp_dir().join(name);
    (ok_name && candidate.exists()).then_some(candidate)
}

// ---- capture ------------------------------------------------------------------------

struct Session {
    stop: mpsc::Sender<()>,
    done: mpsc::Receiver<Result<(), String>>,
    samples: Arc<Mutex<Vec<i16>>>,
    level: Arc<Mutex<f32>>,
    started: Instant,
    max: Duration,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static OVERFLOW: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInfo {
    pub device: String,
    pub device_rate: u32,
}

/// Open the default microphone. The stream lives on its own thread (cpal
/// streams are not Send) until `audio_stop`.
#[tauri::command]
pub fn audio_start(max_seconds: u32) -> Result<StartInfo, String> {
    let mut guard = SESSION.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_some() {
        return Err("Already recording.".into());
    }
    let samples = Arc::new(Mutex::new(Vec::<i16>::with_capacity(TARGET_RATE as usize * 30)));
    let level = Arc::new(Mutex::new(0f32));
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<StartInfo, String>>();
    let (done_tx, done_rx) = mpsc::channel::<Result<(), String>>();
    let max_samples = TARGET_RATE as usize * max_seconds.clamp(5, 3600) as usize;
    OVERFLOW.store(false, Ordering::SeqCst);
    let (s2, l2) = (samples.clone(), level.clone());
    std::thread::spawn(move || {
        let host = cpal::default_host();
        let Some(device) = host.default_input_device() else {
            let _ = ready_tx.send(Err("No microphone was found.".into()));
            return;
        };
        let name = device.name().unwrap_or_else(|_| "Microphone".into());
        let config = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                let _ = ready_tx.send(Err(format!("The microphone could not be opened: {e}")));
                return;
            }
        };
        let rate = config.sample_rate().0;
        let channels = config.channels() as usize;
        let mut rs = Resampler::new(rate);
        let mut scratch = Vec::with_capacity(4096);
        let mut data_fn = move |frames: &[f32]| {
            scratch.clear();
            for frame in frames.chunks(channels.max(1)) {
                let mono = frame.iter().sum::<f32>() / frame.len() as f32;
                rs.push(mono, &mut scratch);
            }
            if scratch.is_empty() {
                return;
            }
            let rms = (scratch.iter().map(|&s| (s as f32 / 32768.0).powi(2)).sum::<f32>() / scratch.len() as f32).sqrt();
            if let Ok(mut l) = l2.lock() {
                *l = rms;
            }
            if let Ok(mut buf) = s2.lock() {
                let room = max_samples.saturating_sub(buf.len());
                if room < scratch.len() {
                    OVERFLOW.store(true, Ordering::Relaxed);
                }
                buf.extend_from_slice(&scratch[..room.min(scratch.len())]);
            }
        };
        let err_fn = |e| eprintln!("microphone stream error: {e}");
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(&config.into(), move |d: &[f32], _: &_| data_fn(d), err_fn, None),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config.into(),
                move |d: &[i16], _: &_| {
                    let f: Vec<f32> = d.iter().map(|&s| s as f32 / 32768.0).collect();
                    data_fn(&f)
                },
                err_fn,
                None,
            ),
            other => {
                let _ = ready_tx.send(Err(format!("Unsupported microphone format {other:?}.")));
                return;
            }
        };
        // Windows privacy settings blocking desktop apps land in either error.
        let blocked = |e: String| format!("The microphone is blocked or busy ({e}). Check Windows Settings → Privacy → Microphone.");
        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                let _ = ready_tx.send(Err(blocked(e.to_string())));
                return;
            }
        };
        if let Err(e) = stream.play() {
            let _ = ready_tx.send(Err(blocked(e.to_string())));
            return;
        }
        let _ = ready_tx.send(Ok(StartInfo { device: name, device_rate: rate }));
        let _ = stop_rx.recv(); // until Stop (or the session is dropped)
        drop(stream);
        let _ = done_tx.send(Ok(()));
    });
    let info = ready_rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "The microphone did not respond.".to_string())??;
    *guard = Some(Session { stop: stop_tx, done: done_rx, samples, level, started: Instant::now(), max: Duration::from_secs(max_seconds as u64) });
    Ok(info)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelInfo {
    pub recording: bool,
    pub level: f32,
    pub seconds: f64,
    pub at_limit: bool,
}

/// Input level for the microphone animation (cheap; polled ~10x/s while recording).
#[tauri::command]
pub fn audio_level() -> LevelInfo {
    let guard = SESSION.lock().unwrap_or_else(|p| p.into_inner());
    match guard.as_ref() {
        Some(s) => LevelInfo {
            recording: true,
            level: s.level.lock().map(|l| *l).unwrap_or(0.0),
            seconds: s.started.elapsed().as_secs_f64(),
            at_limit: OVERFLOW.load(Ordering::Relaxed) || s.started.elapsed() >= s.max,
        },
        None => LevelInfo { recording: false, level: 0.0, seconds: 0.0, at_limit: false },
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub path: String,
    pub seconds: f64,
}

/// Close the microphone and write the take to a temp WAV for transcription.
#[tauri::command]
pub fn audio_stop() -> Result<Recording, String> {
    let s = SESSION.lock().unwrap_or_else(|p| p.into_inner()).take().ok_or("Not recording.")?;
    let _ = s.stop.send(());
    let _ = s.done.recv_timeout(Duration::from_secs(5));
    let samples = std::mem::take(&mut *s.samples.lock().unwrap_or_else(|p| p.into_inner()));
    if samples.len() < TARGET_RATE as usize / 4 {
        return Err("That was too short to transcribe.".into());
    }
    let dir = temp_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("rec-{stamp}.wav"));
    std::fs::write(&path, wav_bytes(&samples, TARGET_RATE)).map_err(|e| e.to_string())?;
    Ok(Recording { path: path.to_string_lossy().into_owned(), seconds: samples.len() as f64 / TARGET_RATE as f64 })
}

/// Stop without keeping anything.
#[tauri::command]
pub fn audio_cancel() {
    if let Some(s) = SESSION.lock().unwrap_or_else(|p| p.into_inner()).take() {
        let _ = s.stop.send(());
    }
}

/// Delete a temp recording (the default right after transcription).
#[tauri::command]
pub fn audio_discard(path: String) {
    if let Some(p) = own_temp_file(&path) {
        let _ = std::fs::remove_file(p);
    }
}

/// Keep a recording: copy it where the user chose, then delete the temp file.
#[tauri::command]
pub fn audio_save(path: String, destination: String) -> Result<(), String> {
    let src = own_temp_file(&path).ok_or("Unknown recording.")?;
    let dest = Path::new(&destination);
    if dest.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("wav")) != Some(true) {
        return Err("Recordings are saved as .wav files.".into());
    }
    std::fs::copy(&src, dest).map_err(|e| format!("Could not save: {e}"))?;
    let _ = std::fs::remove_file(src);
    Ok(())
}

/// Clear any leftover temp recordings (after a crash) at startup.
pub fn sweep_temp() {
    if let Ok(rd) = std::fs::read_dir(temp_dir()) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with("rec-") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resamples_48k_to_16k_and_keeps_a_speech_band_tone() {
        let mut rs = Resampler::new(48_000);
        let mut out = Vec::new();
        for i in 0..48_000 {
            rs.push((2.0 * PI * 440.0 * i as f32 / 48_000.0).sin() * 0.5, &mut out);
        }
        assert!((out.len() as i64 - 16_000).abs() <= 2, "{}", out.len());
        let peak = out[1000..].iter().map(|s| s.abs()).max().unwrap();
        assert!(peak > 14_000 && peak < 17_500, "440 Hz passes almost unchanged: {peak}");
    }

    #[test]
    fn filters_out_what_16k_cannot_represent() {
        let mut rs = Resampler::new(48_000);
        let mut out = Vec::new();
        for i in 0..48_000 {
            rs.push((2.0 * PI * 15_000.0 * i as f32 / 48_000.0).sin() * 0.5, &mut out);
        }
        let peak = out[1000..].iter().map(|s| s.abs()).max().unwrap();
        assert!(peak < 1_500, "a 15 kHz tone must not alias into speech: {peak}");
    }

    #[test]
    fn writes_a_standard_wav_header() {
        let w = wav_bytes(&[0, 1000, -1000], 16_000);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(&w[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(w[24..28].try_into().unwrap()), 16_000);
        assert_eq!(w.len(), 44 + 6);
    }

    #[test]
    fn only_our_own_temp_recordings_are_accepted() {
        assert!(own_temp_file("C:\\Windows\\win.ini").is_none());
        assert!(own_temp_file("rec-../../x.wav").is_none());
        assert!(own_temp_file("rec-123.wav").is_none(), "must also exist in our temp folder");
    }

    #[test]
    fn stop_without_start_is_an_error_not_a_panic() {
        assert!(audio_stop().is_err());
        assert!(!audio_level().recording);
    }
}

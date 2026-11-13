// Dictation (S-3): microphone capture, Silero VAD and Whisper Large v3 Turbo, all inside the
// Rust backend (D-3, D-6). The UI starts and stops recording through commands and gets the
// text back from stop_recording; progress and state changes arrive as "dictation" events.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub const MODEL_FILE: &str = "ggml-large-v3-turbo.bin";
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin";
const MODEL_SHA256: &str = "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69";
const MODEL_SIZE: u64 = 1_624_555_275;
const RATE: u32 = 16_000;

#[derive(Default)]
pub struct Dictation {
    model: Mutex<Option<Arc<WhisperContext>>>,
    downloading: AtomicBool,
    recording: Mutex<Option<Recording>>,
}

struct Recording {
    stop: mpsc::Sender<()>,
    samples: Arc<Mutex<Vec<f32>>>,
    rate: u32,
    doc: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum Event {
    Downloading { progress: f32 },
    Ready,
    Recording,
    Transcribing,
    MicDenied,
    Error { message: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    model_ready: bool,
    downloading: bool,
    recording: bool,
}

use crate::fetch::models_dir;

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(models_dir(app)?.join(MODEL_FILE))
}

fn emit(app: &AppHandle, e: Event) {
    let _ = app.emit("dictation", e);
}

#[tauri::command]
pub fn dictation_status(app: AppHandle, state: State<Dictation>) -> Result<Status, String> {
    Ok(Status {
        model_ready: model_path(&app)?.is_file(),
        downloading: state.downloading.load(Ordering::SeqCst),
        recording: state.recording.lock().unwrap().is_some(),
    })
}

// Pressing record with no model starts the one-time download instead (Req 2). Returns false
// when recording did not start for that reason.
#[tauri::command]
pub fn start_recording(app: AppHandle, state: State<Dictation>, doc: Option<String>) -> Result<bool, String> {
    if !model_path(&app)?.is_file() {
        start_download(app.clone(), &state);
        return Ok(false);
    }
    let mut rec = state.recording.lock().unwrap();
    if rec.is_some() {
        return Ok(true);
    }
    let samples = Arc::new(Mutex::new(Vec::<f32>::with_capacity(48_000 * 120)));
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
    let buf = samples.clone();
    let app2 = app.clone();
    // cpal streams are not Send on macOS, so the stream lives on its own thread until stopped.
    std::thread::spawn(move || {
        let host = cpal::default_host();
        let Some(device) = host.default_input_device() else {
            let _ = ready_tx.send(Err("No microphone found".into()));
            return;
        };
        let config = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                let _ = ready_tx.send(Err(e.to_string()));
                return;
            }
        };
        let channels = config.channels() as usize;
        let rate = config.sample_rate();
        let stream_config = config.config();
        let started = Instant::now();
        let heard = Arc::new(AtomicBool::new(false));
        let warned = Arc::new(AtomicBool::new(false));
        let (h, w, a) = (heard.clone(), warned.clone(), app2.clone());
        let stream = device.build_input_stream(
            stream_config,
            move |data: &[f32], _| {
                let mut out = buf.lock().unwrap();
                for frame in data.chunks(channels) {
                    let s = frame.iter().sum::<f32>() / channels as f32;
                    if s != 0.0 {
                        h.store(true, Ordering::Relaxed);
                    }
                    out.push(s);
                }
                // macOS delivers pure silence when microphone access is denied (Req 7).
                if !h.load(Ordering::Relaxed) && started.elapsed() > Duration::from_millis(1500) && !w.swap(true, Ordering::Relaxed) {
                    emit(&a, Event::MicDenied);
                }
            },
            move |err| eprintln!("microphone error: {err}"),
            None,
        );
        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                let _ = ready_tx.send(Err(e.to_string()));
                return;
            }
        };
        if let Err(e) = stream.play() {
            let _ = ready_tx.send(Err(e.to_string()));
            return;
        }
        let _ = ready_tx.send(Ok(rate));
        let _ = stop_rx.recv();
        drop(stream);
    });
    let rate = ready_rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "The microphone did not start".to_string())??;
    *rec = Some(Recording { stop: stop_tx, samples, rate, doc });
    emit(&app, Event::Recording);
    // Load Whisper while the user speaks, so stopping only waits for transcription.
    let app3 = app.clone();
    std::thread::spawn(move || {
        let state = app3.state::<Dictation>();
        let _ = load_model(&app3, &state);
    });
    Ok(true)
}

// Stops recording and returns the transcript (Req 4, 5). The raw text is kept next to the
// document (Req 6).
#[tauri::command]
pub async fn stop_recording(app: AppHandle) -> Result<String, String> {
    let rec = {
        let state = app.state::<Dictation>();
        let mut guard = state.recording.lock().unwrap();
        guard.take()
    };
    let Some(rec) = rec else { return Ok(String::new()) };
    let _ = rec.stop.send(());
    emit(&app, Event::Transcribing);
    let app2 = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let raw = std::mem::take(&mut *rec.samples.lock().unwrap());
        let audio = resample(&raw, rec.rate, RATE);
        let state = app2.state::<Dictation>();
        let ctx = load_model(&app2, &state)?;
        let text = transcribe(&ctx, &trim_silence(&audio))?;
        if let (Some(id), false) = (rec.doc.as_deref(), text.is_empty()) {
            save_transcript(id, &text)?;
        }
        Ok::<String, String>(text)
    })
    .await
    .map_err(|e| e.to_string())?;
    match &result {
        Ok(_) => emit(&app, Event::Ready),
        Err(e) => emit(&app, Event::Error { message: e.clone() }),
    }
    result
}

#[tauri::command]
pub fn open_mic_settings() -> Result<(), String> {
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn load_model(app: &AppHandle, state: &Dictation) -> Result<Arc<WhisperContext>, String> {
    let mut slot = state.model.lock().unwrap();
    if let Some(ctx) = slot.as_ref() {
        return Ok(ctx.clone());
    }
    let ctx = Arc::new(load_context(&model_path(app)?)?);
    *slot = Some(ctx.clone());
    Ok(ctx)
}

pub fn load_context(path: &std::path::Path) -> Result<WhisperContext, String> {
    let path = path.to_str().ok_or("Model path is not UTF-8")?;
    WhisperContext::new_with_params(path, WhisperContextParameters::default()).map_err(|e| format!("Could not load the speech model: {e}"))
}

pub fn transcribe(ctx: &WhisperContext, audio: &[f32]) -> Result<String, String> {
    if audio.len() < RATE as usize / 4 {
        return Ok(String::new());
    }
    let mut state = ctx.create_state().map_err(|e| e.to_string())?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_suppress_blank(true);
    state.full(params, audio).map_err(|e| format!("Transcription failed: {e}"))?;
    let mut text = String::new();
    for seg in state.as_iter() {
        text.push_str(&seg.to_string());
    }
    Ok(text.split_whitespace().collect::<Vec<_>>().join(" "))
}

// Downmixed audio at the device rate -> 16 kHz: average over each output step (a box
// low-pass), which is enough for speech going to Whisper.
pub fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let n = (input.len() as f64 / ratio) as usize;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let a = (i as f64 * ratio) as usize;
        let b = (((i + 1) as f64 * ratio) as usize).clamp(a + 1, input.len());
        out.push(input[a..b].iter().sum::<f32>() / (b - a) as f32);
    }
    out
}

// Silero VAD finds where speech starts and ends; silence before and after is dropped
// (with a little padding), so Whisper does not hallucinate over long quiet stretches.
pub fn trim_silence(audio: &[f32]) -> Vec<f32> {
    const CHUNK: usize = 512;
    let Ok(mut vad) = voice_activity_detector::VoiceActivityDetector::builder().sample_rate(RATE as i64).chunk_size(CHUNK).build() else {
        return audio.to_vec();
    };
    let mut first = None;
    let mut last = 0;
    for (i, chunk) in audio.chunks(CHUNK).enumerate() {
        if chunk.len() < CHUNK {
            break;
        }
        if vad.predict(chunk.to_vec()) > 0.5 {
            first.get_or_insert(i);
            last = i;
        }
    }
    let Some(first) = first else { return Vec::new() };
    let pad = RATE as usize / 4;
    let start = (first * CHUNK).saturating_sub(pad);
    let end = ((last + 1) * CHUNK + pad).min(audio.len());
    audio[start..end].to_vec()
}

fn save_transcript(doc: &str, text: &str) -> Result<(), String> {
    let dir = crate::library::doc_dir(doc)?.join("transcripts");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    fs::write(dir.join(format!("{ms}.txt")), format!("{text}\n")).map_err(|e| e.to_string())
}

// One-time model download with progress (Req 2), through the shared checksummed downloader.
const REMOTE: [crate::fetch::Remote; 1] = [crate::fetch::Remote { url: MODEL_URL, file: MODEL_FILE, sha256: MODEL_SHA256, size: MODEL_SIZE }];

fn start_download(app: AppHandle, state: &Dictation) {
    if state.downloading.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        emit(&app, Event::Downloading { progress: 0.0 });
        let result = models_dir(&app).and_then(|dir| crate::fetch::download_all(&dir, &REMOTE, |p| emit(&app, Event::Downloading { progress: p })));
        app.state::<Dictation>().downloading.store(false, Ordering::SeqCst);
        match result {
            Ok(()) => emit(&app, Event::Ready),
            Err(e) => emit(&app, Event::Error { message: format!("Model download failed: {e}") }),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_48k_to_16k_keeps_length_and_level() {
        let tone: Vec<f32> = (0..48_000).map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.5).collect();
        let out = resample(&tone, 48_000, 16_000);
        assert_eq!(out.len(), 16_000);
        let peak = out.iter().fold(0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.4 && peak <= 0.5, "peak {peak}");
    }

    #[test]
    fn silence_trims_to_nothing() {
        assert!(trim_silence(&vec![0.0; 16_000 * 2]).is_empty());
    }

    // Needs the downloaded model and a 16 kHz mono WAV of speech:
    // CADER_MODEL=... CADER_WAV=... cargo test -- --ignored --nocapture
    #[test]
    #[ignore]
    fn transcribes_a_recording() {
        let model = std::env::var("CADER_MODEL").expect("CADER_MODEL");
        let wav = std::env::var("CADER_WAV").expect("CADER_WAV");
        let bytes = fs::read(wav).unwrap();
        // 16-bit PCM (afconvert -f WAVE -d LEI16@16000 -c 1); samples start after the "data" chunk header.
        let data = bytes.windows(4).position(|w| w == b"data").expect("data chunk") + 8;
        let pcm: Vec<f32> = bytes[data..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
        let ctx = load_context(std::path::Path::new(&model)).unwrap();
        let t = Instant::now();
        let text = transcribe(&ctx, &trim_silence(&pcm)).unwrap();
        println!("{:.1}s of audio in {:.2}s: {text}", pcm.len() as f32 / 16_000.0, t.elapsed().as_secs_f32());
        assert!(!text.is_empty());
    }
}

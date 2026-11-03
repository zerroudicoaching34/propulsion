//! Microphone capture → 16 kHz mono → voice-activity segmentation → transcription.
//!
//! Privacy: audio only lives in memory, in bounded channels, and is dropped once
//! transcribed. Nothing is written to disk. Capture requires the meeting consent
//! to be recorded in the database (checked by the caller).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::transcribe::{RawSegment, Transcriber};

pub const SAMPLE_RATE: u32 = 16_000;

/// Something that can push events to the UI (Tauri in the app, a recorder in tests).
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: serde_json::Value);
}

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

/// Streaming linear resampler with a simple box low-pass when downsampling.
/// Good enough for speech recognition (Whisper is robust to this).
pub struct Resampler {
    ratio: f64, // input samples per output sample
    pos: f64,
    prev: f32,
    lp_len: usize,
    lp_buf: Vec<f32>,
}

impl Resampler {
    pub fn new(input_rate: u32, output_rate: u32) -> Self {
        let ratio = input_rate as f64 / output_rate as f64;
        let lp_len = if ratio > 1.0 { ratio.round().max(1.0) as usize } else { 1 };
        Self { ratio, pos: 0.0, prev: 0.0, lp_len, lp_buf: Vec::new() }
    }

    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        // Moving-average low-pass to limit aliasing when downsampling.
        let filtered: Vec<f32> = if self.lp_len > 1 {
            let mut out = Vec::with_capacity(input.len());
            for &x in input {
                self.lp_buf.push(x);
                if self.lp_buf.len() > self.lp_len {
                    self.lp_buf.remove(0);
                }
                out.push(self.lp_buf.iter().sum::<f32>() / self.lp_buf.len() as f32);
            }
            out
        } else {
            input.to_vec()
        };
        let mut out = Vec::with_capacity((filtered.len() as f64 / self.ratio) as usize + 1);
        // `pos` is relative to the sample before `filtered[0]` (self.prev at index -1).
        while self.pos < filtered.len() as f64 {
            let i = self.pos.floor() as isize - 1;
            let frac = (self.pos - self.pos.floor()) as f32;
            let a = if i < 0 { self.prev } else { filtered[i as usize] };
            let b = filtered[(i + 1) as usize];
            out.push(a + (b - a) * frac);
            self.pos += self.ratio;
        }
        self.pos -= filtered.len() as f64;
        if let Some(&last) = filtered.last() {
            self.prev = last;
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Voice activity segmentation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SpeechChunk {
    /// Offset of the first sample, in ms since capture start.
    pub start_ms: i64,
    pub samples: Vec<f32>,
}

#[derive(Debug, Clone)]
pub struct VadConfig {
    pub frame_ms: u32,
    pub min_threshold: f32,
    pub silence_to_cut_ms: u32,
    pub min_chunk_ms: u32,
    pub max_chunk_ms: u32,
    pub min_voiced_ms: u32,
    pub preroll_ms: u32,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            frame_ms: 30,
            min_threshold: 0.006,
            silence_to_cut_ms: 700,
            min_chunk_ms: 1000,
            max_chunk_ms: 12_000,
            min_voiced_ms: 300,
            preroll_ms: 210,
        }
    }
}

/// Energy-based segmenter with an adaptive noise floor. Splits the stream into
/// utterances at pauses, with a hard maximum length to keep latency bounded.
pub struct VadSegmenter {
    cfg: VadConfig,
    frame_len: usize,
    pending: Vec<f32>,
    noise_floor: f32,
    in_speech: bool,
    chunk: Vec<f32>,
    chunk_start_sample: u64,
    voiced_frames: u32,
    silence_frames: u32,
    preroll: Vec<f32>,
    samples_seen: u64,
    pub last_level: f32,
}

impl VadSegmenter {
    pub fn new(cfg: VadConfig) -> Self {
        let frame_len = (SAMPLE_RATE * cfg.frame_ms / 1000) as usize;
        Self {
            cfg,
            frame_len,
            pending: Vec::new(),
            noise_floor: 0.003,
            in_speech: false,
            chunk: Vec::new(),
            chunk_start_sample: 0,
            voiced_frames: 0,
            silence_frames: 0,
            preroll: Vec::new(),
            samples_seen: 0,
            last_level: 0.0,
        }
    }

    fn ms_to_frames(&self, ms: u32) -> u32 {
        (ms / self.cfg.frame_ms).max(1)
    }

    fn samples_to_ms(n: u64) -> i64 {
        (n as i64 * 1000) / SAMPLE_RATE as i64
    }

    pub fn threshold(&self) -> f32 {
        (self.noise_floor * 3.0).max(self.cfg.min_threshold)
    }

    /// Feeds 16 kHz mono samples, returns completed chunks.
    pub fn push(&mut self, samples: &[f32]) -> Vec<SpeechChunk> {
        self.pending.extend_from_slice(samples);
        let mut out = Vec::new();
        while self.pending.len() >= self.frame_len {
            let frame: Vec<f32> = self.pending.drain(..self.frame_len).collect();
            if let Some(c) = self.process_frame(&frame) {
                out.push(c);
            }
        }
        out
    }

    fn process_frame(&mut self, frame: &[f32]) -> Option<SpeechChunk> {
        let rms = (frame.iter().map(|x| x * x).sum::<f32>() / frame.len() as f32).sqrt();
        self.last_level = rms;
        let voiced = rms > self.threshold();
        if !voiced {
            // Track the noise floor slowly when not speaking.
            self.noise_floor = self.noise_floor * 0.95 + rms * 0.05;
        }
        let frame_start = self.samples_seen;
        self.samples_seen += frame.len() as u64;

        if !self.in_speech {
            if voiced {
                self.in_speech = true;
                self.chunk.clear();
                self.chunk_start_sample = frame_start.saturating_sub(self.preroll.len() as u64);
                self.chunk.extend_from_slice(&self.preroll);
                self.chunk.extend_from_slice(frame);
                self.voiced_frames = 1;
                self.silence_frames = 0;
            } else {
                self.preroll.extend_from_slice(frame);
                let max = (SAMPLE_RATE * self.cfg.preroll_ms / 1000) as usize;
                if self.preroll.len() > max {
                    let drop = self.preroll.len() - max;
                    self.preroll.drain(..drop);
                }
            }
            return None;
        }

        self.chunk.extend_from_slice(frame);
        if voiced {
            self.voiced_frames += 1;
            self.silence_frames = 0;
        } else {
            self.silence_frames += 1;
        }
        let chunk_ms = Self::samples_to_ms(self.chunk.len() as u64) as u32;
        let pause = self.silence_frames >= self.ms_to_frames(self.cfg.silence_to_cut_ms);
        if pause || chunk_ms >= self.cfg.max_chunk_ms {
            return self.close_chunk();
        }
        None
    }

    fn close_chunk(&mut self) -> Option<SpeechChunk> {
        self.in_speech = false;
        self.preroll.clear();
        let voiced_ms = self.voiced_frames * self.cfg.frame_ms;
        let samples = std::mem::take(&mut self.chunk);
        self.voiced_frames = 0;
        self.silence_frames = 0;
        if voiced_ms < self.cfg.min_voiced_ms {
            return None; // a click or a breath
        }
        Some(SpeechChunk { start_ms: Self::samples_to_ms(self.chunk_start_sample), samples })
    }

    /// Returns the speech in progress (used on stop so the last sentence is not lost).
    pub fn flush(&mut self) -> Option<SpeechChunk> {
        if self.in_speech {
            self.close_chunk()
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Session control
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioState {
    Idle,
    LoadingModel,
    Listening,
    Paused,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStatus {
    pub state: AudioState,
    pub meeting_id: Option<String>,
    pub speaker: String,
    pub device: Option<String>,
    pub message: Option<String>,
    pub pending_chunks: u64,
}

enum Ctrl {
    Pause,
    Resume,
    Stop,
}

struct Session {
    meeting_id: String,
    ctrl: Sender<Ctrl>,
    threads: Vec<JoinHandle<()>>,
    device: Option<String>,
}

/// A source of raw audio. The real one is the microphone (cpal); tests use a synthetic one.
pub trait AudioSource: Send + 'static {
    /// Starts producing mono f32 frames at `rate()` Hz into `tx`. Must return quickly.
    fn start(&mut self, tx: SyncSender<Vec<f32>>) -> AppResult<()>;
    fn pause(&mut self) -> AppResult<()>;
    fn resume(&mut self) -> AppResult<()>;
    fn rate(&self) -> u32;
    fn name(&self) -> String;
}

pub struct AudioEngine {
    session: Mutex<Option<Session>>,
    state: Arc<Mutex<AudioState>>,
    speaker: Arc<Mutex<String>>,
    paused: Arc<AtomicBool>,
    pending: Arc<AtomicU64>,
    last_message: Arc<Mutex<Option<String>>>,
}

impl Default for AudioEngine {
    fn default() -> Self {
        Self {
            session: Mutex::new(None),
            state: Arc::new(Mutex::new(AudioState::Idle)),
            speaker: Arc::new(Mutex::new("unknown".into())),
            paused: Arc::new(AtomicBool::new(false)),
            pending: Arc::new(AtomicU64::new(0)),
            last_message: Arc::new(Mutex::new(None)),
        }
    }
}

fn set_state(state: &Arc<Mutex<AudioState>>, s: AudioState, sink: &Arc<dyn EventSink>, msg: Option<String>) {
    *state.lock().unwrap() = s;
    sink.emit("audio:state", json!({ "state": s, "message": msg }));
}

/// Words Whisper is known to "hear" in silence (subtitle credits, etc.).
const HALLUCINATIONS: &[&str] = &[
    "sous-titres réalisés par la communauté d'amara.org",
    "sous-titrage st' 501",
    "sous-titrage société radio-canada",
    "merci d'avoir regardé",
    "merci de votre attention",
    "...",
];

pub fn is_hallucination(text: &str) -> bool {
    let t = text.trim().to_lowercase();
    if t.is_empty() || (t.starts_with('[') && t.ends_with(']')) || (t.starts_with('(') && t.ends_with(')')) {
        return true;
    }
    let stripped = t.trim_end_matches(['.', '!', ' ']);
    HALLUCINATIONS.iter().any(|h| stripped == h.trim_end_matches('.') || t.contains("amara.org"))
}

impl AudioEngine {
    pub fn status(&self) -> AudioStatus {
        let sess = self.session.lock().unwrap();
        AudioStatus {
            state: *self.state.lock().unwrap(),
            meeting_id: sess.as_ref().map(|s| s.meeting_id.clone()),
            speaker: self.speaker.lock().unwrap().clone(),
            device: sess.as_ref().and_then(|s| s.device.clone()),
            message: self.last_message.lock().unwrap().clone(),
            pending_chunks: self.pending.load(Ordering::Relaxed),
        }
    }

    pub fn set_speaker(&self, speaker: &str) -> AppResult<()> {
        if !matches!(speaker, "coach" | "prospect" | "unknown") {
            return Err(AppError::msg("Locuteur invalide"));
        }
        *self.speaker.lock().unwrap() = speaker.to_string();
        Ok(())
    }

    pub fn is_active(&self) -> bool {
        self.session.lock().unwrap().is_some()
    }

    /// Starts capture for a meeting. The caller must have verified consent.
    pub fn start(
        &self,
        meeting_id: &str,
        db: Arc<Mutex<rusqlite::Connection>>,
        source: Box<dyn AudioSource>,
        transcriber_factory: Box<dyn FnOnce() -> AppResult<Box<dyn Transcriber>> + Send>,
        sink: Arc<dyn EventSink>,
        vad: VadConfig,
    ) -> AppResult<()> {
        let mut guard = self.session.lock().unwrap();
        if guard.is_some() {
            return Err(AppError::msg("Une écoute est déjà en cours"));
        }
        self.paused.store(false, Ordering::SeqCst);
        self.pending.store(0, Ordering::SeqCst);
        *self.last_message.lock().unwrap() = None;

        // Continue timestamps after the existing transcript (when resuming a meeting later).
        let offset_ms: i64 = {
            let conn = db.lock().unwrap();
            conn.query_row("SELECT COALESCE(MAX(end_ms), 0) FROM segments WHERE meeting_id = ?1", [meeting_id], |r| r.get(0))?
        };

        // 1. Load the speech model first, so we fail before opening the microphone.
        set_state(&self.state, AudioState::LoadingModel, &sink, None);
        let transcriber = match transcriber_factory() {
            Ok(t) => t,
            Err(e) => {
                set_state(&self.state, AudioState::Error, &sink, Some(e.to_string()));
                *self.last_message.lock().unwrap() = Some(e.to_string());
                return Err(e);
            }
        };

        // 2. Open the audio source from its own thread (cpal streams must stay on the
        //    thread that created them on macOS). The thread then waits for controls.
        let (raw_tx, raw_rx) = mpsc::sync_channel::<Vec<f32>>(256);
        let (ctrl_tx, ctrl_rx) = mpsc::channel::<Ctrl>();
        let (ready_tx, ready_rx) = mpsc::channel::<AppResult<()>>();
        let (chunk_tx, chunk_rx) = mpsc::channel::<(SpeechChunk, String)>();
        let device = Some(source.name());
        let rate = source.rate();
        let state_c = self.state.clone();
        let sink_c = sink.clone();
        let paused_c = self.paused.clone();
        let ctrl_thread = std::thread::spawn(move || {
            let mut source = source;
            if let Err(e) = source.start(raw_tx) {
                let _ = ready_tx.send(Err(e));
                return;
            }
            let _ = ready_tx.send(Ok(()));
            while let Ok(cmd) = ctrl_rx.recv() {
                match cmd {
                    Ctrl::Pause => {
                        paused_c.store(true, Ordering::SeqCst);
                        let _ = source.pause();
                        set_state(&state_c, AudioState::Paused, &sink_c, None);
                    }
                    Ctrl::Resume => {
                        paused_c.store(false, Ordering::SeqCst);
                        let _ = source.resume();
                        set_state(&state_c, AudioState::Listening, &sink_c, None);
                    }
                    Ctrl::Stop => break,
                }
            }
            drop(source); // closes the microphone immediately
        });
        let ready = ready_rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|_| Err(AppError::msg("Le micro ne répond pas")));
        if let Err(e) = ready {
            let _ = ctrl_thread.join();
            set_state(&self.state, AudioState::Error, &sink, Some(e.to_string()));
            *self.last_message.lock().unwrap() = Some(e.to_string());
            return Err(e);
        }

        // Processing thread: resample + segment.
        let speaker_c = self.speaker.clone();
        let sink_p = sink.clone();
        let paused_p = self.paused.clone();
        let pending_p = self.pending.clone();
        let proc_thread = std::thread::spawn(move || {
            let mut resampler = Resampler::new(rate, SAMPLE_RATE);
            let mut vad_seg = VadSegmenter::new(vad);
            let mut last_level = Instant::now();
            let send = |c: SpeechChunk, spk: String| {
                pending_p.fetch_add(1, Ordering::SeqCst);
                let _ = chunk_tx.send((SpeechChunk { start_ms: c.start_ms + offset_ms, samples: c.samples }, spk));
            };
            while let Ok(frame) = raw_rx.recv() {
                if paused_p.load(Ordering::SeqCst) {
                    continue;
                }
                let s16 = resampler.process(&frame);
                for chunk in vad_seg.push(&s16) {
                    send(chunk, speaker_c.lock().unwrap().clone());
                }
                if last_level.elapsed() > Duration::from_millis(150) {
                    last_level = Instant::now();
                    sink_p.emit("audio:level", json!({ "level": vad_seg.last_level, "threshold": vad_seg.threshold() }));
                }
            }
            // Source closed (stop): keep the sentence in progress.
            if let Some(chunk) = vad_seg.flush() {
                send(chunk, speaker_c.lock().unwrap().clone());
            }
        });

        // Transcription thread.
        let meeting = meeting_id.to_string();
        let sink_t = sink.clone();
        let pending_t = self.pending.clone();
        let state_t = self.state.clone();
        let tr_thread = std::thread::spawn(move || {
            let mut transcriber = transcriber;
            while let Ok((chunk, speaker)) = chunk_rx.recv() {
                let started = Instant::now();
                let result = transcriber.transcribe(&chunk.samples);
                pending_t.fetch_sub(1, Ordering::SeqCst);
                let audio_ms = (chunk.samples.len() as i64 * 1000) / SAMPLE_RATE as i64;
                drop(chunk.samples); // audio released as soon as it is transcribed
                match result {
                    Ok(raw) => {
                        let segs = to_db_segments(&meeting, chunk.start_ms, audio_ms, &speaker, raw);
                        for seg in segs {
                            let saved = db::segment_insert(&db.lock().unwrap(), seg);
                            match saved {
                                Ok(seg) => sink_t.emit("transcript:segment", serde_json::to_value(&seg).unwrap_or_default()),
                                Err(e) => sink_t.emit("audio:error", json!({ "message": e.to_string() })),
                            }
                        }
                        sink_t.emit(
                            "transcript:latency",
                            json!({ "ms": started.elapsed().as_millis() as u64, "audioMs": audio_ms }),
                        );
                    }
                    Err(e) => sink_t.emit("audio:error", json!({ "message": e.to_string() })),
                }
            }
            set_state(&state_t, AudioState::Idle, &sink_t, None);
        });

        *guard = Some(Session {
            meeting_id: meeting_id.to_string(),
            ctrl: ctrl_tx,
            threads: vec![ctrl_thread, proc_thread, tr_thread],
            device,
        });
        set_state(&self.state, AudioState::Listening, &sink, None);
        Ok(())
    }

    pub fn pause(&self) -> AppResult<()> {
        let guard = self.session.lock().unwrap();
        let s = guard.as_ref().ok_or_else(|| AppError::msg("Aucune écoute en cours"))?;
        self.paused.store(true, Ordering::SeqCst); // effective immediately, even before the thread reacts
        s.ctrl.send(Ctrl::Pause).map_err(|_| AppError::msg("Contrôle audio indisponible"))
    }

    pub fn resume(&self) -> AppResult<()> {
        let guard = self.session.lock().unwrap();
        let s = guard.as_ref().ok_or_else(|| AppError::msg("Aucune écoute en cours"))?;
        s.ctrl.send(Ctrl::Resume).map_err(|_| AppError::msg("Contrôle audio indisponible"))
    }

    /// Stops listening immediately (microphone closed). The utterance already captured
    /// is still transcribed in the background unless `discard` is true.
    pub fn stop(&self, discard: bool) -> AppResult<()> {
        let session = self.session.lock().unwrap().take();
        let Some(s) = session else { return Ok(()) };
        if discard {
            self.paused.store(true, Ordering::SeqCst);
        }
        let _ = s.ctrl.send(Ctrl::Stop);
        // Join in the background so the UI is never blocked by a transcription in progress.
        std::thread::spawn(move || {
            for t in s.threads {
                let _ = t.join();
            }
        });
        Ok(())
    }

    /// Test helper: waits until all threads of a stopped session are idle.
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < timeout {
            if *self.state.lock().unwrap() == AudioState::Idle && self.pending.load(Ordering::SeqCst) == 0 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }
}

fn to_db_segments(meeting_id: &str, chunk_start_ms: i64, audio_ms: i64, speaker: &str, raw: Vec<RawSegment>) -> Vec<db::Segment> {
    raw.into_iter()
        .filter(|r| !is_hallucination(&r.text))
        .map(|r| db::Segment {
            id: String::new(),
            meeting_id: meeting_id.to_string(),
            start_ms: chunk_start_ms + r.t0_ms.min(audio_ms),
            end_ms: chunk_start_ms + r.t1_ms.clamp(r.t0_ms, audio_ms.max(r.t0_ms)),
            speaker: speaker.to_string(),
            text: r.text.trim().to_string(),
            confidence: r.confidence,
            source: "whisper".into(),
            edited: false,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Microphone (cpal)
// ---------------------------------------------------------------------------

pub mod mic {
    use super::*;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{SampleFormat, Stream};

    pub fn list_input_devices() -> Vec<String> {
        let host = cpal::default_host();
        host.input_devices()
            .map(|it| it.filter_map(|d| d.name().ok()).collect())
            .unwrap_or_default()
    }

    pub struct MicSource {
        device: cpal::Device,
        config: cpal::SupportedStreamConfig,
        stream: Option<Stream>,
    }

    // SAFETY: a MicSource is moved to its control thread *before* `start` creates the
    // stream; the stream is then created, driven and dropped on that single thread.
    // Before `start`, it only holds a device handle and a config, which are plain data.
    unsafe impl Send for MicSource {}

    impl MicSource {
        pub fn open(preferred: &str) -> AppResult<Self> {
            let host = cpal::default_host();
            let device = if preferred.is_empty() {
                host.default_input_device()
            } else {
                host.input_devices()
                    .ok()
                    .and_then(|mut it| it.find(|d| d.name().map(|n| n == preferred).unwrap_or(false)))
                    .or_else(|| host.default_input_device())
            }
            .ok_or_else(|| AppError::msg("Aucun microphone détecté. Vérifiez qu'un micro est branché et autorisé dans Réglages Système → Confidentialité et sécurité → Microphone."))?;
            let config = device
                .default_input_config()
                .map_err(|e| AppError::msg(format!("Micro inaccessible : {e}. Sur macOS, autorisez l'accès au micro dans Réglages Système → Confidentialité et sécurité → Microphone.")))?;
            Ok(Self { device, config, stream: None })
        }
    }

    fn push_mono<T: Copy>(data: &[T], channels: usize, conv: impl Fn(T) -> f32, tx: &SyncSender<Vec<f32>>) {
        let mono: Vec<f32> = data
            .chunks(channels.max(1))
            .map(|frame| frame.iter().map(|&s| conv(s)).sum::<f32>() / frame.len() as f32)
            .collect();
        // Never block the real-time audio thread: drop if the consumer is late.
        let _ = tx.try_send(mono);
    }

    impl AudioSource for MicSource {
        fn start(&mut self, tx: SyncSender<Vec<f32>>) -> AppResult<()> {
            let channels = self.config.channels() as usize;
            let cfg: cpal::StreamConfig = self.config.clone().into();
            let err_fn = |e| log::error!("audio stream error: {e}");
            let stream = match self.config.sample_format() {
                SampleFormat::F32 => self.device.build_input_stream(&cfg, move |d: &[f32], _| push_mono(d, channels, |s| s, &tx), err_fn, None),
                SampleFormat::I16 => self.device.build_input_stream(&cfg, move |d: &[i16], _| push_mono(d, channels, |s| s as f32 / i16::MAX as f32, &tx), err_fn, None),
                SampleFormat::U16 => self.device.build_input_stream(&cfg, move |d: &[u16], _| push_mono(d, channels, |s| (s as f32 - 32768.0) / 32768.0, &tx), err_fn, None),
                SampleFormat::I32 => self.device.build_input_stream(&cfg, move |d: &[i32], _| push_mono(d, channels, |s| s as f32 / i32::MAX as f32, &tx), err_fn, None),
                other => return Err(AppError::msg(format!("Format audio non pris en charge : {other:?}"))),
            }
            .map_err(|e| AppError::msg(format!("Impossible d'ouvrir le micro : {e}")))?;
            stream.play().map_err(|e| AppError::msg(format!("Impossible de démarrer le micro : {e}")))?;
            self.stream = Some(stream);
            Ok(())
        }
        fn pause(&mut self) -> AppResult<()> {
            if let Some(s) = &self.stream {
                s.pause().map_err(|e| AppError::msg(e.to_string()))?;
            }
            Ok(())
        }
        fn resume(&mut self) -> AppResult<()> {
            if let Some(s) = &self.stream {
                s.play().map_err(|e| AppError::msg(e.to_string()))?;
            }
            Ok(())
        }
        fn rate(&self) -> u32 {
            self.config.sample_rate().0
        }
        fn name(&self) -> String {
            self.device.name().unwrap_or_else(|_| "Micro".into())
        }
    }
}

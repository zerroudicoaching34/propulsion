//! Backend tests: storage, retention, consent, audio pipeline, cloud gate.
//! Audio tests use a synthetic source and a fake transcriber (no microphone needed).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use ss_copilot_lib::audio::{is_hallucination, AudioEngine, AudioSource, AudioState, EventSink, Resampler, VadConfig, VadSegmenter, SAMPLE_RATE};
use ss_copilot_lib::commands::{cloud_prepare, ensure_consent};
use ss_copilot_lib::db::{self, MeetingPatch, Prospect, Segment};
use ss_copilot_lib::error::AppResult;
use ss_copilot_lib::llm::{check_cloud_gate, sha256_hex, CloudRequest, GateRefusal};
use ss_copilot_lib::settings::{self, is_loopback_url, AppSettings};
use ss_copilot_lib::transcribe::{RawSegment, Transcriber};

fn prospect(conn: &rusqlite::Connection) -> Prospect {
    db::prospect_upsert(conn, Prospect { first_name: "Camille".into(), last_name: "Test".into(), ..Default::default() }).unwrap()
}

fn seg(meeting: &str, text: &str) -> Segment {
    Segment { meeting_id: meeting.into(), speaker: "prospect".into(), text: text.into(), source: "manual".into(), ..Default::default() }
}

// ---------------- storage ----------------

#[test]
fn encrypted_database_requires_the_right_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.db");
    let key = "a".repeat(64);
    {
        let c = db::open(&path, Some(&key)).unwrap();
        assert_eq!(db::schema_version(&c).unwrap(), 1);
        prospect(&c);
    }
    // Reopen with the right key: data is there, migrations are idempotent.
    let c = db::open(&path, Some(&key)).unwrap();
    assert_eq!(db::prospect_list(&c).unwrap().len(), 1);
    drop(c);
    // Wrong key or no key: unreadable.
    assert!(db::open(&path, Some(&"b".repeat(64))).is_err());
    assert!(db::open(&path, None).is_err());
    // The file does not contain the clear-text name.
    let raw = std::fs::read(&path).unwrap();
    assert!(!raw.windows(7).any(|w| w == b"Camille"));
}

#[test]
fn prospect_and_meeting_crud_with_cascade_delete() {
    let c = db::open_in_memory().unwrap();
    let p = prospect(&c);
    let m = db::meeting_create(&c, &p.id, "R1", "2026-11-04T10:00:00Z", false).unwrap();
    assert!(db::meeting_create(&c, &p.id, "R3", "x", false).is_err());
    db::segment_insert(&c, seg(&m.id, "Je veux perdre 5 kilos")).unwrap();
    let m2 = db::meeting_update(&c, &m.id, MeetingPatch { decision: Some("Souhaite réfléchir".into()), ..Default::default() }).unwrap();
    assert_eq!(m2.decision, "Souhaite réfléchir");
    let mut p2 = p.clone();
    p2.objective = "Perdre 5 kg".into();
    assert_eq!(db::prospect_upsert(&c, p2).unwrap().objective, "Perdre 5 kg");
    db::prospect_delete(&c, &p.id).unwrap();
    assert!(db::meeting_get(&c, &m.id).unwrap().is_none());
    assert!(db::segment_list(&c, &m.id).unwrap().is_empty());
}

#[test]
fn manual_speaker_correction_is_saved() {
    let c = db::open_in_memory().unwrap();
    let p = prospect(&c);
    let m = db::meeting_create(&c, &p.id, "R1", "2026-11-04", false).unwrap();
    let s = db::segment_insert(&c, seg(&m.id, "Bonjour")).unwrap();
    let u = db::segment_update(&c, &s.id, Some("coach".into()), Some("Bonjour Camille".into())).unwrap();
    assert_eq!((u.speaker.as_str(), u.text.as_str(), u.edited), ("coach", "Bonjour Camille", true));
    assert!(db::segment_update(&c, &s.id, Some("robot".into()), None).is_err());
    assert_eq!(db::segment_list(&c, &m.id).unwrap()[0].speaker, "coach");
}

#[test]
fn deleting_a_meeting_removes_all_its_data() {
    let c = db::open_in_memory().unwrap();
    let p = prospect(&c);
    let m = db::meeting_create(&c, &p.id, "R2", "2026-11-04", true).unwrap();
    db::segment_insert(&c, seg(&m.id, "texte")).unwrap();
    db::meeting_delete(&c, &m.id).unwrap();
    assert!(db::meeting_get(&c, &m.id).unwrap().is_none());
    let n: i64 = c.query_row("SELECT count(*) FROM segments", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
    // The prospect sheet itself stays.
    assert!(db::prospect_get(&c, &p.id).unwrap().is_some());
}

#[test]
fn retention_purges_non_retained_content_but_keeps_statistics() {
    let c = db::open_in_memory().unwrap();
    let p = prospect(&c);
    let ephemeral = db::meeting_create(&c, &p.id, "R1", "2026-11-04", false).unwrap();
    let kept = db::meeting_create(&c, &p.id, "R1", "2026-11-04", true).unwrap();
    for m in [&ephemeral, &kept] {
        db::segment_insert(&c, seg(&m.id, "contenu")).unwrap();
        db::meeting_update(
            &c,
            &m.id,
            MeetingPatch { status: Some("done".into()), decision: Some("Accord exprimé".into()), objection_kinds: Some("price".into()), debrief_json: Some("{}".into()), ..Default::default() },
        )
        .unwrap();
    }
    assert_eq!(db::apply_retention(&c, 30).unwrap(), 1);
    let e = db::meeting_get(&c, &ephemeral.id).unwrap().unwrap();
    assert!(e.content_purged && e.debrief_json.is_none());
    assert!(db::segment_list(&c, &ephemeral.id).unwrap().is_empty());
    assert_eq!(e.decision, "Accord exprimé");
    assert_eq!(e.objection_kinds, "price");
    assert_eq!(db::segment_list(&c, &kept.id).unwrap().len(), 1);
    // Retained meetings older than the retention period are purged too.
    c.execute("UPDATE meetings SET updated_at = '2000-01-01T00:00:00Z' WHERE id = ?1", [&kept.id]).unwrap();
    assert_eq!(db::apply_retention(&c, 30).unwrap(), 1);
    assert!(db::segment_list(&c, &kept.id).unwrap().is_empty());
}

#[test]
fn knowledge_base_and_settings_roundtrip() {
    let c = db::open_in_memory().unwrap();
    assert!(db::kb_set(&c, "offers", "not json").is_err());
    db::kb_set(&c, "offers", r#"[{"id":"basic"}]"#).unwrap();
    assert!(db::kb_get(&c, "offers").unwrap().unwrap().contains("basic"));
    let mut s = settings::load(&c).unwrap();
    assert_eq!(s.ai_mode, "local"); // local by default
    assert!(!s.retain_by_default); // retention off by default
    s.ollama_url = "http://192.168.1.20:11434".into();
    assert!(settings::save(&c, &s).is_err());
    s.ollama_url = "http://localhost:11434".into();
    s.ai_mode = "hybrid".into();
    settings::save(&c, &s).unwrap();
    assert_eq!(settings::load(&c).unwrap().ai_mode, "hybrid");
}

#[test]
fn loopback_detection() {
    for ok in ["http://127.0.0.1:11434", "http://localhost:11434/", "http://[::1]:11434"] {
        assert!(is_loopback_url(ok), "{ok}");
    }
    for bad in ["http://10.0.0.2:11434", "https://api.example.com", "http://localhost.evil.com", "ftp://localhost"] {
        assert!(!is_loopback_url(bad), "{bad}");
    }
}

// ---------------- consent ----------------

#[test]
fn capture_is_refused_without_consent() {
    let c = db::open_in_memory().unwrap();
    let p = prospect(&c);
    let m = db::meeting_create(&c, &p.id, "R1", "2026-11-04", false).unwrap();
    assert!(ensure_consent(&c, &m.id).is_err());
    db::meeting_set_consent(&c, &m.id, true).unwrap();
    assert!(ensure_consent(&c, &m.id).is_ok());
    db::meeting_set_consent(&c, &m.id, false).unwrap();
    assert!(ensure_consent(&c, &m.id).is_err());
}

// ---------------- audio pipeline ----------------

fn tone(ms: u32, rate: u32, amp: f32) -> Vec<f32> {
    let n = (rate as u64 * ms as u64 / 1000) as usize;
    (0..n).map(|i| amp * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / rate as f32).sin()).collect()
}
fn silence(ms: u32, rate: u32) -> Vec<f32> {
    vec![0.0005; (rate as u64 * ms as u64 / 1000) as usize]
}

#[test]
fn resampler_preserves_duration() {
    let mut r = Resampler::new(48_000, 16_000);
    let mut out = Vec::new();
    for _ in 0..100 {
        out.extend(r.process(&tone(10, 48_000, 0.5)));
    }
    let expected = 16_000; // 1 s
    assert!((out.len() as i64 - expected).abs() <= 2, "{}", out.len());
    let mut up = Resampler::new(8_000, 16_000);
    assert!((up.process(&tone(1000, 8_000, 0.5)).len() as i64 - 16_000).abs() <= 2);
}

#[test]
fn vad_splits_utterances_on_pauses() {
    let mut v = VadSegmenter::new(VadConfig::default());
    let mut audio = silence(500, SAMPLE_RATE);
    audio.extend(tone(1500, SAMPLE_RATE, 0.2));
    audio.extend(silence(1000, SAMPLE_RATE));
    audio.extend(tone(2000, SAMPLE_RATE, 0.2));
    audio.extend(silence(1000, SAMPLE_RATE));
    let chunks = v.push(&audio);
    assert_eq!(chunks.len(), 2);
    assert!((chunks[0].start_ms - 290).abs() < 60, "start {}", chunks[0].start_ms);
    assert!(chunks[1].start_ms > 2000);
    // Pure silence or a click produces nothing.
    let mut v2 = VadSegmenter::new(VadConfig::default());
    let mut quiet = silence(3000, SAMPLE_RATE);
    quiet.extend(tone(60, SAMPLE_RATE, 0.3));
    quiet.extend(silence(1500, SAMPLE_RATE));
    assert!(v2.push(&quiet).is_empty());
}

#[test]
fn vad_bounds_latency_with_a_maximum_chunk_length() {
    let mut v = VadSegmenter::new(VadConfig::default());
    let chunks = v.push(&tone(30_000, SAMPLE_RATE, 0.2));
    assert!(chunks.len() >= 2);
    for c in &chunks {
        assert!(c.samples.len() as u32 <= SAMPLE_RATE * 12 + SAMPLE_RATE / 10);
    }
}

#[test]
fn whisper_hallucinations_are_filtered() {
    assert!(is_hallucination("Sous-titres réalisés par la communauté d'Amara.org"));
    assert!(is_hallucination("[Musique]"));
    assert!(is_hallucination("  "));
    assert!(!is_hallucination("Je voudrais perdre du poids."));
}

#[derive(Default)]
struct Recorder(Mutex<Vec<(String, Value)>>);
impl EventSink for Recorder {
    fn emit(&self, event: &str, payload: Value) {
        self.0.lock().unwrap().push((event.to_string(), payload));
    }
}

/// Plays a scripted signal at real-time-ish speed; records when it is closed.
struct FakeMic {
    script: Vec<f32>,
    rate: u32,
    closed: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}
impl AudioSource for FakeMic {
    fn start(&mut self, tx: SyncSender<Vec<f32>>) -> AppResult<()> {
        let script = std::mem::take(&mut self.script);
        let (paused, stop, rate) = (self.paused.clone(), self.stop.clone(), self.rate);
        std::thread::spawn(move || {
            let block = (rate / 100) as usize; // 10 ms
            let mut i = 0;
            // Loop the script until stopped, 20x faster than real time.
            while !stop.load(Ordering::SeqCst) {
                if !paused.load(Ordering::SeqCst) {
                    let end = (i + block).min(script.len());
                    if tx.send(script[i..end].to_vec()).is_err() {
                        break;
                    }
                    i = if end >= script.len() { 0 } else { end };
                }
                std::thread::sleep(Duration::from_micros(500));
            }
        });
        Ok(())
    }
    fn pause(&mut self) -> AppResult<()> {
        self.paused.store(true, Ordering::SeqCst);
        Ok(())
    }
    fn resume(&mut self) -> AppResult<()> {
        self.paused.store(false, Ordering::SeqCst);
        Ok(())
    }
    fn rate(&self) -> u32 {
        self.rate
    }
    fn name(&self) -> String {
        "Micro de test".into()
    }
}
impl Drop for FakeMic {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.closed.store(true, Ordering::SeqCst);
    }
}

struct FakeTranscriber;
impl Transcriber for FakeTranscriber {
    fn transcribe(&mut self, audio: &[f32]) -> AppResult<Vec<RawSegment>> {
        let ms = (audio.len() as i64 * 1000) / SAMPLE_RATE as i64;
        Ok(vec![RawSegment { t0_ms: 0, t1_ms: ms, text: "J'ai déjà essayé plusieurs régimes.".into(), confidence: Some(0.87) }])
    }
}

fn wait_for(cond: impl Fn() -> bool, timeout: Duration) -> bool {
    let t = Instant::now();
    while t.elapsed() < timeout {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

#[test]
fn microphone_start_pause_stop_and_transcription_flow() {
    let conn = db::open_in_memory().unwrap();
    let p = prospect(&conn);
    let m = db::meeting_create(&conn, &p.id, "R1", "2026-11-04", false).unwrap();
    db::meeting_set_consent(&conn, &m.id, true).unwrap();
    let dbh = Arc::new(Mutex::new(conn));
    let sink = Arc::new(Recorder::default());
    let engine = AudioEngine::default();
    engine.set_speaker("prospect").unwrap();
    assert!(engine.set_speaker("nobody").is_err());

    let mut script = silence(400, 48_000);
    script.extend(tone(1500, 48_000, 0.2));
    script.extend(silence(900, 48_000));
    let closed = Arc::new(AtomicBool::new(false));
    let mic = FakeMic { script, rate: 48_000, closed: closed.clone(), paused: Arc::new(AtomicBool::new(false)), stop: Arc::new(AtomicBool::new(false)) };

    engine
        .start(&m.id, dbh.clone(), Box::new(mic), Box::new(|| Ok(Box::new(FakeTranscriber) as Box<dyn Transcriber>)), sink.clone(), VadConfig::default())
        .unwrap();
    assert_eq!(engine.status().state, AudioState::Listening);
    assert_eq!(engine.status().device.as_deref(), Some("Micro de test"));
    // A second start is refused while listening.
    assert!(engine
        .start(&m.id, dbh.clone(), Box::new(FakeMic { script: vec![], rate: 16_000, closed: Arc::new(AtomicBool::new(false)), paused: Arc::new(AtomicBool::new(false)), stop: Arc::new(AtomicBool::new(false)) }), Box::new(|| Ok(Box::new(FakeTranscriber) as Box<dyn Transcriber>)), sink.clone(), VadConfig::default())
        .is_err());

    // Segments appear, attributed to the selected speaker, persisted and emitted.
    assert!(wait_for(|| db::segment_list(&dbh.lock().unwrap(), &m.id).unwrap().len() >= 1, Duration::from_secs(10)));
    let segs = db::segment_list(&dbh.lock().unwrap(), &m.id).unwrap();
    assert_eq!(segs[0].speaker, "prospect");
    assert_eq!(segs[0].source, "whisper");
    assert_eq!(segs[0].confidence, Some(0.87));
    assert!(sink.0.lock().unwrap().iter().any(|(e, _)| e == "transcript:segment"));
    assert!(sink.0.lock().unwrap().iter().any(|(e, _)| e == "transcript:latency"));

    // Pause: no new segments while paused.
    engine.pause().unwrap();
    assert!(wait_for(|| engine.status().state == AudioState::Paused, Duration::from_secs(2)));
    std::thread::sleep(Duration::from_millis(300)); // let in-flight chunks finish
    let before = db::segment_list(&dbh.lock().unwrap(), &m.id).unwrap().len();
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(db::segment_list(&dbh.lock().unwrap(), &m.id).unwrap().len(), before);

    // Resume, then stop: the source (microphone) is closed immediately.
    engine.resume().unwrap();
    assert!(wait_for(|| engine.status().state == AudioState::Listening, Duration::from_secs(2)));
    let t = Instant::now();
    engine.stop(false).unwrap();
    assert!(wait_for(|| closed.load(Ordering::SeqCst), Duration::from_millis(500)), "microphone not closed promptly");
    assert!(t.elapsed() < Duration::from_millis(500));
    assert!(!engine.is_active());
    assert!(engine.wait_idle(Duration::from_secs(5)));
}

#[test]
fn audio_start_fails_cleanly_when_the_model_is_missing() {
    let conn = db::open_in_memory().unwrap();
    let dbh = Arc::new(Mutex::new(conn));
    let sink = Arc::new(Recorder::default());
    let engine = AudioEngine::default();
    let closed = Arc::new(AtomicBool::new(false));
    let mic = FakeMic { script: tone(100, 16_000, 0.1), rate: 16_000, closed: closed.clone(), paused: Arc::new(AtomicBool::new(false)), stop: Arc::new(AtomicBool::new(false)) };
    let err = engine
        .start("m", dbh, Box::new(mic), Box::new(|| ss_copilot_lib::transcribe::load_transcriber("", 2)), sink, VadConfig::default())
        .unwrap_err();
    assert!(err.to_string().contains("Whisper"));
    assert_eq!(engine.status().state, AudioState::Error);
    assert!(!engine.is_active());
    assert!(closed.load(Ordering::SeqCst), "microphone must never be opened when the model is missing");
}

// ---------------- cloud gate ----------------

fn req(purpose: &str, payload: &str, confirmed: bool) -> CloudRequest {
    CloudRequest { meeting_id: Some("m1".into()), purpose: purpose.into(), payload: payload.into(), preview_sha256: sha256_hex(payload), confirmed }
}

#[test]
fn no_cloud_transfer_without_mode_confirmation_and_matching_preview() {
    let mut s = AppSettings::default();
    let r = req("excerpt_analysis", "Prospect : je veux perdre 5 kg", true);
    assert_eq!(check_cloud_gate(&s, &r, true), Err(GateRefusal::LocalMode)); // default mode is local
    s.ai_mode = "hybrid".into();
    assert_eq!(check_cloud_gate(&s, &req("deep_analysis", "x", true), true), Err(GateRefusal::PurposeNotAllowed));
    assert_eq!(check_cloud_gate(&s, &req("excerpt_analysis", "x", false), true), Err(GateRefusal::NotConfirmed));
    let mut tampered = r.clone();
    tampered.payload.push_str(" + données ajoutées");
    assert_eq!(check_cloud_gate(&s, &tampered, true), Err(GateRefusal::PayloadChanged));
    assert_eq!(check_cloud_gate(&s, &r, false), Err(GateRefusal::NoApiKey));
    assert_eq!(check_cloud_gate(&s, &r, true), Ok(()));
    s.ai_mode = "deep".into();
    assert_eq!(check_cloud_gate(&s, &req("deep_analysis", "x", true), true), Ok(()));
}

#[test]
fn cloud_transfers_are_logged_without_content_and_refusals_are_not_logged() {
    let c = db::open_in_memory().unwrap();
    let mut s = AppSettings::default();
    let r = req("excerpt_analysis", "Prospect : mon budget est de 300 euros", true);
    assert!(cloud_prepare(&c, &s, &r, true).is_err());
    assert!(db::transfer_list(&c).unwrap().is_empty());
    s.ai_mode = "hybrid".into();
    let t = cloud_prepare(&c, &s, &r, true).unwrap();
    let log = db::transfer_list(&c).unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].sha256, t.sha256);
    assert_eq!(log[0].bytes, r.payload.len() as i64);
    assert_eq!(log[0].provider, "Anthropic (Claude)");
    let dump: String = c.query_row("SELECT group_concat(id||provider||model||purpose||sha256||status) FROM cloud_transfers", [], |r| r.get(0)).unwrap();
    assert!(!dump.contains("300 euros"));
}

// ---------------- performance ----------------

#[test]
fn audio_preprocessing_is_far_faster_than_real_time() {
    // 60 s of 48 kHz audio must be resampled + segmented in well under a second.
    let mut audio = Vec::new();
    for _ in 0..15 {
        audio.extend(tone(2500, 48_000, 0.2));
        audio.extend(silence(1500, 48_000));
    }
    let t = Instant::now();
    let mut r = Resampler::new(48_000, SAMPLE_RATE);
    let mut v = VadSegmenter::new(VadConfig::default());
    let mut n = 0;
    for block in audio.chunks(480) {
        n += v.push(&r.process(block)).len();
    }
    let elapsed = t.elapsed();
    assert_eq!(n, 15);
    assert!(elapsed < Duration::from_millis(1500), "too slow: {elapsed:?}");
    eprintln!("60 s of audio preprocessed in {elapsed:?}");
}

// ---------------- real Whisper (opt-in) ----------------

/// Runs only when WHISPER_MODEL and FR_TEST_WAV (16 kHz mono WAV in French) are set:
/// `WHISPER_MODEL=models/ggml-small.bin FR_TEST_WAV=fixtures/fr.wav cargo test -- --ignored`
#[test]
#[ignore]
fn real_whisper_french_transcription() {
    let model = std::env::var("WHISPER_MODEL").expect("WHISPER_MODEL");
    let wav = std::env::var("FR_TEST_WAV").expect("FR_TEST_WAV");
    let mut reader = hound::WavReader::open(&wav).unwrap();
    let spec = reader.spec();
    assert_eq!(spec.channels, 1);
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => reader.samples::<i16>().map(|s| s.unwrap() as f32 / i16::MAX as f32).collect(),
        hound::SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap()).collect(),
    };
    let samples = if spec.sample_rate != SAMPLE_RATE { Resampler::new(spec.sample_rate, SAMPLE_RATE).process(&samples) } else { samples };
    let mut t = ss_copilot_lib::transcribe::load_transcriber(&model, 4).unwrap();
    let start = Instant::now();
    let segs = t.transcribe(&samples).unwrap();
    let text = segs.iter().map(|s| s.text.clone()).collect::<Vec<_>>().join(" ");
    eprintln!("transcribed {:.1}s of audio in {:?}: {text}", samples.len() as f32 / 16_000.0, start.elapsed());
    assert!(!text.trim().is_empty());
    if let Ok(expect) = std::env::var("FR_TEST_EXPECT") {
        for w in expect.split(',') {
            assert!(text.to_lowercase().contains(&w.trim().to_lowercase()), "missing '{w}' in: {text}");
        }
    }
}

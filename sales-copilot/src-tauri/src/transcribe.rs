//! Speech-to-text. Whisper (whisper.cpp) runs locally; French is forced.

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq)]
pub struct RawSegment {
    pub t0_ms: i64,
    pub t1_ms: i64,
    pub text: String,
    /// Mean token probability (0..1) when available.
    pub confidence: Option<f64>,
}

pub trait Transcriber: Send {
    /// `audio`: 16 kHz mono f32 samples.
    fn transcribe(&mut self, audio: &[f32]) -> AppResult<Vec<RawSegment>>;
}

pub fn check_model_file(path: &str) -> AppResult<u64> {
    if path.trim().is_empty() {
        return Err(AppError::msg(
            "Aucun modèle Whisper configuré. Lancez scripts/download-models.sh puis indiquez le fichier dans Réglages.",
        ));
    }
    let meta = std::fs::metadata(path).map_err(|_| AppError::msg(format!("Modèle Whisper introuvable : {path}")))?;
    if meta.len() < 1_000_000 {
        return Err(AppError::msg("Le fichier du modèle Whisper semble incomplet"));
    }
    Ok(meta.len())
}

#[cfg(feature = "whisper")]
pub mod whisper {
    use super::*;
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState};

    pub struct WhisperTranscriber {
        // The state borrows nothing from the context in whisper-rs 0.14 (it holds an Arc).
        state: WhisperState,
        _ctx: WhisperContext,
        threads: i32,
    }

    impl WhisperTranscriber {
        pub fn load(model_path: &str, threads: u32) -> AppResult<Self> {
            check_model_file(model_path)?;
            let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
                .map_err(|e| AppError::msg(format!("Chargement du modèle Whisper impossible : {e}")))?;
            let state = ctx.create_state().map_err(|e| AppError::msg(format!("Whisper : {e}")))?;
            Ok(Self { state, _ctx: ctx, threads: threads.clamp(1, 16) as i32 })
        }
    }

    impl Transcriber for WhisperTranscriber {
        fn transcribe(&mut self, audio: &[f32]) -> AppResult<Vec<RawSegment>> {
            // Whisper needs at least ~1 s; pad short utterances with silence.
            let mut buf;
            let audio = if audio.len() < 16_000 + 1600 {
                buf = audio.to_vec();
                buf.resize(16_000 + 1600, 0.0);
                &buf[..]
            } else {
                audio
            };
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            params.set_language(Some("fr"));
            params.set_n_threads(self.threads);
            params.set_no_context(true);
            params.set_suppress_blank(true);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_special(false);
            params.set_print_timestamps(false);
            params.set_temperature(0.0);
            params.set_no_speech_thold(0.6);
            self.state.full(params, audio).map_err(|e| AppError::msg(format!("Transcription : {e}")))?;
            let n = self.state.full_n_segments().map_err(|e| AppError::msg(e.to_string()))?;
            let mut out = Vec::new();
            for i in 0..n {
                let text = self.state.full_get_segment_text_lossy(i).unwrap_or_default();
                let t0 = self.state.full_get_segment_t0(i).unwrap_or(0) * 10; // centiseconds → ms
                let t1 = self.state.full_get_segment_t1(i).unwrap_or(0) * 10;
                let n_tok = self.state.full_n_tokens(i).unwrap_or(0);
                let mut sum = 0.0f64;
                let mut count = 0;
                for t in 0..n_tok {
                    let tok_text = self.state.full_get_token_text_lossy(i, t).unwrap_or_default();
                    if tok_text.starts_with("[_") || tok_text.starts_with("<|") {
                        continue;
                    }
                    if let Ok(p) = self.state.full_get_token_prob(i, t) {
                        sum += p as f64;
                        count += 1;
                    }
                }
                let confidence = if count > 0 { Some((sum / count as f64 * 100.0).round() / 100.0) } else { None };
                if !text.trim().is_empty() {
                    out.push(RawSegment { t0_ms: t0, t1_ms: t1, text: text.trim().to_string(), confidence });
                }
            }
            Ok(out)
        }
    }
}

/// Builds the real transcriber, or explains why it is unavailable.
pub fn load_transcriber(model_path: &str, threads: u32) -> AppResult<Box<dyn Transcriber>> {
    #[cfg(feature = "whisper")]
    {
        Ok(Box::new(whisper::WhisperTranscriber::load(model_path, threads)?))
    }
    #[cfg(not(feature = "whisper"))]
    {
        let _ = (model_path, threads);
        Err(AppError::msg("Cette version a été compilée sans Whisper (feature « whisper » désactivée)."))
    }
}

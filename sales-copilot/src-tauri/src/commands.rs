//! Tauri commands exposed to the web view. Every privacy rule is enforced here,
//! not only in the UI: consent before capture, local-only LLM URL, cloud gate.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::audio::{AudioEngine, AudioStatus, EventSink, VadConfig};
use crate::db::{self, Meeting, MeetingPatch, Prospect, Segment};
use crate::error::{AppError, AppResult};
use crate::llm::{self, ChatMessage, CloudRequest, LlmReply, OllamaStatus};
use crate::secrets::{self, KeyStorage};
use crate::settings::{self, AppSettings};

pub struct AppState {
    pub db: Arc<Mutex<rusqlite::Connection>>,
    pub audio: Arc<AudioEngine>,
    pub data_dir: PathBuf,
    pub key_storage: KeyStorage,
}

pub struct TauriSink(pub AppHandle);

impl EventSink for TauriSink {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.0.emit(event, payload);
    }
}

fn with_db<T>(state: &State<'_, AppState>, f: impl FnOnce(&rusqlite::Connection) -> AppResult<T>) -> AppResult<T> {
    let conn = state.db.lock().map_err(|_| AppError::msg("Base verrouillée"))?;
    f(&conn)
}

// ---------- app ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    data_dir: String,
    key_storage: KeyStorage,
    database_encrypted: bool,
    schema_version: i64,
    whisper_compiled: bool,
    os: String,
    arch: String,
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> AppResult<AppInfo> {
    let schema_version = with_db(&state, db::schema_version)?;
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        data_dir: state.data_dir.display().to_string(),
        key_storage: state.key_storage,
        database_encrypted: true,
        schema_version,
        whisper_compiled: cfg!(feature = "whisper"),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
    })
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> AppResult<AppSettings> {
    with_db(&state, settings::load)
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, value: AppSettings) -> AppResult<AppSettings> {
    with_db(&state, |c| {
        settings::save(c, &value)?;
        Ok(value)
    })
}

#[tauri::command]
pub fn kb_get(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    with_db(&state, |c| db::kb_get(c, &key))
}

#[tauri::command]
pub fn kb_set(state: State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    if !matches!(key.as_str(), "offers" | "questionnaire_R1" | "questionnaire_R2" | "consent_text") {
        return Err(AppError::msg("Clé de base de connaissances inconnue"));
    }
    with_db(&state, |c| db::kb_set(c, &key, &value))
}

// ---------- prospects ----------

#[tauri::command]
pub fn prospect_list(state: State<'_, AppState>) -> AppResult<Vec<Prospect>> {
    with_db(&state, db::prospect_list)
}

#[tauri::command]
pub fn prospect_get(state: State<'_, AppState>, id: String) -> AppResult<Option<Prospect>> {
    with_db(&state, |c| db::prospect_get(c, &id))
}

#[tauri::command]
pub fn prospect_upsert(state: State<'_, AppState>, prospect: Prospect) -> AppResult<Prospect> {
    with_db(&state, |c| db::prospect_upsert(c, prospect))
}

#[tauri::command]
pub fn prospect_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let active = state.audio.status().meeting_id;
    with_db(&state, |c| {
        if let Some(mid) = active {
            if db::meeting_get(c, &mid)?.map(|m| m.prospect_id == id).unwrap_or(false) {
                return Err(AppError::msg("Arrêtez l'écoute avant de supprimer ce prospect"));
            }
        }
        db::prospect_delete(c, &id)
    })
}

// ---------- meetings ----------

#[tauri::command]
pub fn meeting_list(state: State<'_, AppState>, prospect_id: Option<String>) -> AppResult<Vec<Meeting>> {
    with_db(&state, |c| db::meeting_list(c, prospect_id.as_deref()))
}

#[tauri::command]
pub fn meeting_get(state: State<'_, AppState>, id: String) -> AppResult<Option<Meeting>> {
    with_db(&state, |c| db::meeting_get(c, &id))
}

#[tauri::command]
pub fn meeting_create(state: State<'_, AppState>, prospect_id: String, kind: String, scheduled_at: String) -> AppResult<Meeting> {
    with_db(&state, |c| {
        let retain = settings::load(c)?.retain_by_default;
        db::meeting_create(c, &prospect_id, &kind, &scheduled_at, retain)
    })
}

#[tauri::command]
pub fn meeting_update(state: State<'_, AppState>, id: String, patch: MeetingPatch) -> AppResult<Meeting> {
    with_db(&state, |c| db::meeting_update(c, &id, patch))
}

#[tauri::command]
pub fn meeting_set_consent(state: State<'_, AppState>, id: String, given: bool) -> AppResult<Meeting> {
    if !given && state.audio.status().meeting_id.as_deref() == Some(id.as_str()) {
        // Consent withdrawn: stop listening immediately and discard pending audio.
        state.audio.stop(true)?;
    }
    with_db(&state, |c| db::meeting_set_consent(c, &id, given))
}

#[tauri::command]
pub fn meeting_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    if state.audio.status().meeting_id.as_deref() == Some(id.as_str()) {
        state.audio.stop(true)?;
    }
    with_db(&state, |c| db::meeting_delete(c, &id))
}

#[tauri::command]
pub fn meeting_purge_content(state: State<'_, AppState>, id: String) -> AppResult<()> {
    if state.audio.status().meeting_id.as_deref() == Some(id.as_str()) {
        state.audio.stop(true)?;
    }
    with_db(&state, |c| db::meeting_purge_content(c, &id))
}

// ---------- segments ----------

#[tauri::command]
pub fn segment_list(state: State<'_, AppState>, meeting_id: String) -> AppResult<Vec<Segment>> {
    with_db(&state, |c| db::segment_list(c, &meeting_id))
}

/// Manual note typed by the coach (works without microphone).
#[tauri::command]
pub fn segment_add(state: State<'_, AppState>, meeting_id: String, speaker: String, text: String, start_ms: i64) -> AppResult<Segment> {
    if text.trim().is_empty() {
        return Err(AppError::msg("Texte vide"));
    }
    with_db(&state, |c| {
        db::meeting_get(c, &meeting_id)?.ok_or_else(|| AppError::msg("Rendez-vous introuvable"))?;
        db::segment_insert(
            c,
            Segment { id: String::new(), meeting_id, start_ms, end_ms: start_ms, speaker, text: text.trim().into(), confidence: None, source: "manual".into(), edited: false },
        )
    })
}

#[tauri::command]
pub fn segment_update(state: State<'_, AppState>, id: String, speaker: Option<String>, text: Option<String>) -> AppResult<Segment> {
    with_db(&state, |c| db::segment_update(c, &id, speaker, text))
}

#[tauri::command]
pub fn segment_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    with_db(&state, |c| db::segment_delete(c, &id))
}

// ---------- audio ----------

#[tauri::command]
pub fn audio_devices() -> Vec<String> {
    crate::audio::mic::list_input_devices()
}

#[tauri::command]
pub fn audio_status(state: State<'_, AppState>) -> AudioStatus {
    state.audio.status()
}

/// Consent is checked here, in the backend: no consent recorded → no capture.
pub fn ensure_consent(conn: &rusqlite::Connection, meeting_id: &str) -> AppResult<Meeting> {
    let m = db::meeting_get(conn, meeting_id)?.ok_or_else(|| AppError::msg("Rendez-vous introuvable"))?;
    if !m.consent_given {
        return Err(AppError::msg("Consentement non enregistré : l'écoute ne peut pas démarrer."));
    }
    Ok(m)
}

#[tauri::command]
pub async fn audio_start(app: AppHandle, state: State<'_, AppState>, meeting_id: String) -> AppResult<AudioStatus> {
    let s = {
        let conn = state.db.lock().map_err(|_| AppError::msg("Base verrouillée"))?;
        ensure_consent(&conn, &meeting_id)?;
        db::meeting_update(&conn, &meeting_id, MeetingPatch { status: Some("live".into()), ..Default::default() })?;
        settings::load(&conn)?
    };
    let audio = state.audio.clone();
    let dbh = state.db.clone();
    let sink: Arc<dyn EventSink> = Arc::new(TauriSink(app));
    tauri::async_runtime::spawn_blocking(move || {
        let source = crate::audio::mic::MicSource::open(&s.input_device)?;
        let model = s.whisper_model_path.clone();
        let threads = s.whisper_threads;
        audio.start(
            &meeting_id,
            dbh,
            Box::new(source),
            Box::new(move || crate::transcribe::load_transcriber(&model, threads)),
            sink,
            VadConfig::default(),
        )?;
        Ok(audio.status())
    })
    .await
    .map_err(|e| AppError::msg(e.to_string()))?
}

#[tauri::command]
pub fn audio_pause(state: State<'_, AppState>) -> AppResult<AudioStatus> {
    state.audio.pause()?;
    Ok(state.audio.status())
}

#[tauri::command]
pub fn audio_resume(state: State<'_, AppState>) -> AppResult<AudioStatus> {
    state.audio.resume()?;
    Ok(state.audio.status())
}

#[tauri::command]
pub fn audio_stop(state: State<'_, AppState>, discard: Option<bool>) -> AppResult<AudioStatus> {
    state.audio.stop(discard.unwrap_or(false))?;
    Ok(state.audio.status())
}

#[tauri::command]
pub fn audio_set_speaker(state: State<'_, AppState>, speaker: String) -> AppResult<()> {
    state.audio.set_speaker(&speaker)
}

#[tauri::command]
pub fn whisper_check(path: String) -> AppResult<u64> {
    crate::transcribe::check_model_file(&path)
}

// ---------- local LLM ----------

#[tauri::command]
pub async fn ollama_status(state: State<'_, AppState>) -> AppResult<OllamaStatus> {
    let s = with_db(&state, settings::load)?;
    Ok(llm::ollama_status(&s).await)
}

#[tauri::command]
pub async fn ollama_chat(state: State<'_, AppState>, messages: Vec<ChatMessage>, format: Option<Value>) -> AppResult<LlmReply> {
    let s = with_db(&state, settings::load)?;
    if !s.llm_enabled {
        return Err(AppError::msg("IA locale désactivée dans les réglages"));
    }
    llm::ollama_chat(&s, messages, format).await
}

// ---------- secrets ----------

#[tauri::command]
pub fn secret_set_api_key(provider: String, key: String) -> AppResult<()> {
    secrets::set_api_key(&provider, &key)
}

#[tauri::command]
pub fn secret_has_api_key(provider: String) -> bool {
    secrets::get_api_key(&provider).is_some()
}

#[tauri::command]
pub fn secret_delete_api_key(provider: String) -> AppResult<()> {
    secrets::delete_api_key(&provider)
}

// ---------- cloud (opt-in) ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudOutcome {
    transfer_id: String,
    content: String,
    provider: String,
    model: String,
}

/// Validates the request, logs the transfer (metadata only), then sends.
pub fn cloud_prepare(conn: &rusqlite::Connection, s: &AppSettings, req: &CloudRequest, has_key: bool) -> AppResult<db::CloudTransfer> {
    llm::check_cloud_gate(s, req, has_key).map_err(|r| AppError::msg(r.message()))?;
    let t = db::CloudTransfer {
        id: db::new_id("ct"),
        meeting_id: req.meeting_id.clone(),
        provider: s.cloud.label.clone(),
        model: s.cloud.model.clone(),
        purpose: req.purpose.clone(),
        bytes: req.payload.len() as i64,
        sha256: llm::sha256_hex(&req.payload),
        status: "pending".into(),
        error: None,
        created_at: db::now(),
    };
    db::transfer_log(conn, &t)?;
    Ok(t)
}

#[tauri::command]
pub async fn cloud_analyze(state: State<'_, AppState>, request: CloudRequest) -> AppResult<CloudOutcome> {
    let s = with_db(&state, settings::load)?;
    let key = secrets::get_api_key(&s.cloud.kind);
    let mut t = with_db(&state, |c| cloud_prepare(c, &s, &request, key.is_some()))?;
    let result = llm::cloud_send(&s, key.as_deref().unwrap_or_default(), &request.payload).await;
    match result {
        Ok(content) => {
            t.status = "sent".into();
            with_db(&state, |c| {
                db::transfer_log(c, &t)?;
                if let Some(mid) = &request.meeting_id {
                    db::cloud_result_insert(
                        c,
                        &db::CloudResult {
                            id: db::new_id("cr"),
                            meeting_id: mid.clone(),
                            transfer_id: t.id.clone(),
                            provider: t.provider.clone(),
                            model: t.model.clone(),
                            content: content.clone(),
                            created_at: db::now(),
                        },
                    )?;
                }
                Ok(())
            })?;
            Ok(CloudOutcome { transfer_id: t.id, content, provider: t.provider, model: t.model })
        }
        Err(e) => {
            t.status = "error".into();
            t.error = Some(e.to_string());
            with_db(&state, |c| db::transfer_log(c, &t))?;
            Err(e)
        }
    }
}

#[tauri::command]
pub fn cloud_transfers(state: State<'_, AppState>) -> AppResult<Vec<db::CloudTransfer>> {
    with_db(&state, db::transfer_list)
}

#[tauri::command]
pub fn cloud_results(state: State<'_, AppState>, meeting_id: String) -> AppResult<Vec<db::CloudResult>> {
    with_db(&state, |c| db::cloud_result_list(c, &meeting_id))
}

// ---------- exports ----------

/// Writes an export chosen by the user in the save dialog.
#[tauri::command]
pub fn export_save(path: String, text: Option<String>, bytes: Option<Vec<u8>>) -> AppResult<()> {
    let p = PathBuf::from(&path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !matches!(ext.as_str(), "md" | "json" | "pdf") {
        return Err(AppError::msg("Extension d'export non autorisée (md, json, pdf)"));
    }
    match (text, bytes) {
        (Some(t), _) => std::fs::write(&p, t)?,
        (None, Some(b)) => std::fs::write(&p, b)?,
        _ => return Err(AppError::msg("Rien à exporter")),
    }
    Ok(())
}

#[tauri::command]
pub fn retention_apply(state: State<'_, AppState>) -> AppResult<usize> {
    if state.audio.is_active() {
        return Ok(0);
    }
    with_db(&state, |c| {
        let s = settings::load(c)?;
        db::apply_retention(c, s.retention_days)
    })
}

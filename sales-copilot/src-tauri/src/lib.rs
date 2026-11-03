//! Smart & Strong — Sales Copilot (backend).

pub mod audio;
pub mod commands;
pub mod db;
pub mod error;
pub mod llm;
pub mod secrets;
pub mod settings;
pub mod transcribe;

use std::sync::{Arc, Mutex};
use tauri::Manager;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let (key, key_storage) = secrets::db_key(&data_dir)?;
            let conn = db::open(&data_dir.join("copilot.db"), Some(&key))?;
            // Optional first-launch configuration (see config.example.json).
            if settings::seed_from_file(&conn, &data_dir.join("config.json"))? {
                log::info!("settings initialised from config.json");
            }
            // Retention policy at start-up (also covers a previous crash).
            let s = settings::load(&conn)?;
            let purged = db::apply_retention(&conn, s.retention_days)?;
            if purged > 0 {
                log::info!("retention: purged content of {purged} meeting(s)");
            }
            app.manage(AppState {
                db: Arc::new(Mutex::new(conn)),
                audio: Arc::new(audio::AudioEngine::default()),
                data_dir,
                key_storage,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::settings_get,
            commands::settings_set,
            commands::kb_get,
            commands::kb_set,
            commands::prospect_list,
            commands::prospect_get,
            commands::prospect_upsert,
            commands::prospect_delete,
            commands::meeting_list,
            commands::meeting_get,
            commands::meeting_create,
            commands::meeting_update,
            commands::meeting_set_consent,
            commands::meeting_delete,
            commands::meeting_purge_content,
            commands::segment_list,
            commands::segment_add,
            commands::segment_update,
            commands::segment_delete,
            commands::audio_devices,
            commands::audio_status,
            commands::audio_start,
            commands::audio_pause,
            commands::audio_resume,
            commands::audio_stop,
            commands::audio_set_speaker,
            commands::whisper_check,
            commands::ollama_status,
            commands::ollama_chat,
            commands::secret_set_api_key,
            commands::secret_has_api_key,
            commands::secret_delete_api_key,
            commands::cloud_analyze,
            commands::cloud_transfers,
            commands::cloud_results,
            commands::export_save,
            commands::retention_apply,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the application");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<AppState>() {
                let _ = state.audio.stop(true);
                if let Ok(conn) = state.db.lock() {
                    if let Ok(s) = settings::load(&conn) {
                        let _ = db::apply_retention(&conn, s.retention_days);
                    }
                }
            }
        }
    });
}

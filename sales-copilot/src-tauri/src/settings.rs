//! Application settings, stored as one JSON document in the `settings` table.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CloudProvider {
    /// "anthropic" or "openai_compatible"
    pub kind: String,
    pub label: String,
    pub base_url: String,
    pub model: String,
}

impl Default for CloudProvider {
    fn default() -> Self {
        Self {
            kind: "anthropic".into(),
            label: "Anthropic (Claude)".into(),
            base_url: "https://api.anthropic.com".into(),
            model: "claude-opus-5-5".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    /// "local" (default) | "hybrid" | "deep". Ceiling for cloud usage; never automatic.
    pub ai_mode: String,
    pub ollama_url: String,
    pub ollama_model: String,
    pub llm_enabled: bool,
    pub llm_interval_sec: u32,
    pub whisper_model_path: String,
    pub whisper_threads: u32,
    pub input_device: String,
    /// Retention of retained meetings, in days.
    pub retention_days: i64,
    /// Default value of the "conserver ce rendez-vous" toggle. False by default.
    pub retain_by_default: bool,
    pub cloud: CloudProvider,
    pub show_disc_grid: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            ai_mode: "local".into(),
            ollama_url: "http://127.0.0.1:11434".into(),
            ollama_model: "qwen2.5:7b".into(),
            llm_enabled: true,
            llm_interval_sec: 20,
            whisper_model_path: String::new(),
            whisper_threads: 4,
            input_device: String::new(),
            retention_days: 30,
            retain_by_default: false,
            cloud: CloudProvider::default(),
            show_disc_grid: false,
        }
    }
}

/// The local LLM must stay on this machine: only loopback hosts are accepted.
pub fn is_loopback_url(url: &str) -> bool {
    let rest = url.strip_prefix("http://").or_else(|| url.strip_prefix("https://"));
    let Some(rest) = rest else { return false };
    let host = rest.split(['/', '?']).next().unwrap_or("");
    let host = if host.starts_with('[') {
        host.split(']').next().map(|h| format!("{h}]")).unwrap_or_default()
    } else {
        host.split(':').next().unwrap_or("").to_string()
    };
    matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]")
}

pub fn validate(s: &AppSettings) -> AppResult<()> {
    if !matches!(s.ai_mode.as_str(), "local" | "hybrid" | "deep") {
        return Err(AppError::msg("Mode IA invalide"));
    }
    if !is_loopback_url(&s.ollama_url) {
        return Err(AppError::msg(
            "L'adresse d'Ollama doit être locale (127.0.0.1 ou localhost) : l'IA locale ne doit jamais sortir de la machine.",
        ));
    }
    if !matches!(s.cloud.kind.as_str(), "anthropic" | "openai_compatible") {
        return Err(AppError::msg("Fournisseur cloud invalide"));
    }
    if !s.cloud.base_url.is_empty() && !s.cloud.base_url.starts_with("https://") {
        return Err(AppError::msg("L'URL du fournisseur cloud doit utiliser HTTPS"));
    }
    if s.llm_interval_sec < 5 {
        return Err(AppError::msg("Intervalle IA minimum : 5 secondes"));
    }
    Ok(())
}

pub fn load(conn: &Connection) -> AppResult<AppSettings> {
    Ok(match db::get_setting(conn, "app")? {
        Some(json) => serde_json::from_str(&json).unwrap_or_default(),
        None => AppSettings::default(),
    })
}

pub fn save(conn: &Connection, s: &AppSettings) -> AppResult<()> {
    validate(s)?;
    db::set_setting(conn, "app", &serde_json::to_string(s)?)
}

/// On first launch only (no settings stored yet), initial settings can be provided in
/// `config.json` next to the database (see `config.example.json`). Returns true if applied.
pub fn seed_from_file(conn: &Connection, path: &std::path::Path) -> AppResult<bool> {
    if db::get_setting(conn, "app")?.is_some() || !path.exists() {
        return Ok(false);
    }
    let s: AppSettings = serde_json::from_str(&std::fs::read_to_string(path)?)
        .map_err(|e| AppError::msg(format!("config.json invalide : {e}")))?;
    save(conn, &s)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_file_seeds_settings_once_and_is_validated() {
        let dir = std::env::temp_dir().join(format!("ss-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        let example = include_str!("../../config.example.json");
        std::fs::write(&path, example).unwrap();
        let conn = db::open_in_memory().unwrap();
        assert!(seed_from_file(&conn, &path).unwrap());
        let s = load(&conn).unwrap();
        assert_eq!(s.ai_mode, "local");
        assert!(!s.retain_by_default);
        // Second launch: stored settings win, the file is ignored.
        std::fs::write(&path, example.replace("\"local\"", "\"deep\"")).unwrap();
        assert!(!seed_from_file(&conn, &path).unwrap());
        assert_eq!(load(&conn).unwrap().ai_mode, "local");
        // A non-local Ollama URL in the file is rejected.
        let conn2 = db::open_in_memory().unwrap();
        std::fs::write(&path, example.replace("127.0.0.1", "10.1.2.3")).unwrap();
        assert!(seed_from_file(&conn2, &path).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

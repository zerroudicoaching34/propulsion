use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Base de données : {0}")]
    Db(#[from] rusqlite::Error),
    #[error("JSON : {0}")]
    Json(#[from] serde_json::Error),
    #[error("Fichier : {0}")]
    Io(#[from] std::io::Error),
    #[error("Réseau : {0}")]
    Http(#[from] reqwest::Error),
    #[error("{0}")]
    Msg(String),
}

impl AppError {
    pub fn msg(s: impl Into<String>) -> Self {
        AppError::Msg(s.into())
    }
}

// Errors cross the Tauri bridge as plain French messages.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

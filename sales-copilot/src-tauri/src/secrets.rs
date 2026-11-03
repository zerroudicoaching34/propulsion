//! Secrets: database key and cloud API keys. Stored in the macOS Keychain.
//! API keys never travel back to the web view.

use rand::RngCore;
use std::path::Path;

use crate::error::{AppError, AppResult};

pub const SERVICE: &str = "fr.smartandstrong.salescopilot";

fn entry(name: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, name).map_err(|e| AppError::msg(format!("Trousseau : {e}")))
}

fn random_hex_key() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Where the database key lives, shown in the UI for transparency.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyStorage {
    Keychain,
    File,
}

/// Returns the database key, creating it on first launch.
/// On macOS it lives in the Keychain. If the Keychain is unavailable (e.g. Linux CI),
/// it falls back to a 0600 file next to the database, and the UI says so.
pub fn db_key(data_dir: &Path) -> AppResult<(String, KeyStorage)> {
    let key_file = data_dir.join("db.key");
    if key_file.exists() {
        let k = std::fs::read_to_string(&key_file)?.trim().to_string();
        return Ok((k, KeyStorage::File));
    }
    if let Ok(e) = entry("database-key") {
        match e.get_password() {
            Ok(k) => return Ok((k, KeyStorage::Keychain)),
            Err(keyring::Error::NoEntry) => {
                let k = random_hex_key();
                if e.set_password(&k).is_ok() && e.get_password().ok().as_deref() == Some(k.as_str()) {
                    // Only trust the keychain if it persists across launches; on platforms where the
                    // backend is session-scoped we use the file fallback instead.
                    if cfg!(target_os = "macos") {
                        return Ok((k, KeyStorage::Keychain));
                    }
                    let _ = e.delete_credential();
                }
            }
            Err(_) => {}
        }
    }
    let k = random_hex_key();
    std::fs::write(&key_file, &k)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&key_file, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok((k, KeyStorage::File))
}

fn api_key_name(provider: &str) -> String {
    format!("cloud-api-key:{provider}")
}

pub fn set_api_key(provider: &str, key: &str) -> AppResult<()> {
    if key.trim().is_empty() {
        return Err(AppError::msg("Clé vide"));
    }
    entry(&api_key_name(provider))?
        .set_password(key.trim())
        .map_err(|e| AppError::msg(format!("Impossible d'enregistrer la clé dans le trousseau : {e}")))
}

pub fn get_api_key(provider: &str) -> Option<String> {
    entry(&api_key_name(provider)).ok()?.get_password().ok()
}

pub fn delete_api_key(provider: &str) -> AppResult<()> {
    match entry(&api_key_name(provider))?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::msg(format!("Trousseau : {e}"))),
    }
}

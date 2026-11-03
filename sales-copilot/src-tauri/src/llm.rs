//! Local LLM (Ollama, loopback only) and opt-in cloud analysis.
//!
//! Cloud calls go through `check_cloud_gate`, which refuses anything that was not
//! explicitly previewed and confirmed by the user, in a mode that allows it.
//! There is no automatic fallback from local to cloud.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};
use crate::settings::{is_loopback_url, AppSettings};

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStatus {
    pub reachable: bool,
    pub models: Vec<String>,
    pub configured_model_available: bool,
    pub message: Option<String>,
}

fn local_client(timeout: Duration) -> AppResult<reqwest::Client> {
    // `no_proxy`: a loopback call must never be routed through a system proxy.
    Ok(reqwest::Client::builder().timeout(timeout).no_proxy().build()?)
}

pub async fn ollama_status(settings: &AppSettings) -> OllamaStatus {
    if !is_loopback_url(&settings.ollama_url) {
        return OllamaStatus { reachable: false, models: vec![], configured_model_available: false, message: Some("Adresse Ollama non locale refusée".into()) };
    }
    let url = format!("{}/api/tags", settings.ollama_url.trim_end_matches('/'));
    let res = async {
        let client = local_client(Duration::from_secs(3))?;
        let v: Value = client.get(&url).send().await?.error_for_status()?.json().await?;
        AppResult::Ok(v)
    }
    .await;
    match res {
        Ok(v) => {
            let models: Vec<String> = v["models"]
                .as_array()
                .map(|a| a.iter().filter_map(|m| m["name"].as_str().map(String::from)).collect())
                .unwrap_or_default();
            let wanted = &settings.ollama_model;
            let available = models.iter().any(|m| m == wanted || m.trim_end_matches(":latest") == wanted);
            OllamaStatus {
                reachable: true,
                configured_model_available: available,
                message: if available { None } else { Some(format!("Modèle « {wanted} » absent : lancez `ollama pull {wanted}`")) },
                models,
            }
        }
        Err(_) => OllamaStatus {
            reachable: false,
            models: vec![],
            configured_model_available: false,
            message: Some("Ollama ne répond pas. Lancez l'application Ollama (ou `ollama serve`).".into()),
        },
    }
}

#[derive(Debug, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmReply {
    pub content: String,
    pub latency_ms: u64,
    pub model: String,
}

pub async fn ollama_chat(settings: &AppSettings, messages: Vec<ChatMessage>, format: Option<Value>) -> AppResult<LlmReply> {
    if !is_loopback_url(&settings.ollama_url) {
        return Err(AppError::msg("Adresse Ollama non locale refusée"));
    }
    let url = format!("{}/api/chat", settings.ollama_url.trim_end_matches('/'));
    let body = json!({
        "model": settings.ollama_model,
        "stream": false,
        "keep_alive": "15m",
        "format": format.unwrap_or(json!("json")),
        "options": { "temperature": 0.2, "num_ctx": 8192 },
        "messages": messages.iter().map(|m| json!({ "role": m.role, "content": m.content })).collect::<Vec<_>>(),
    });
    let started = Instant::now();
    let client = local_client(Duration::from_secs(120))?;
    let resp = client.post(&url).json(&body).send().await.map_err(|_| AppError::msg("Ollama ne répond pas"))?;
    let status = resp.status();
    let v: Value = resp.json().await?;
    if !status.is_success() {
        return Err(AppError::msg(format!("Ollama : {}", v["error"].as_str().unwrap_or("erreur"))));
    }
    Ok(LlmReply {
        content: v["message"]["content"].as_str().unwrap_or_default().to_string(),
        latency_ms: started.elapsed().as_millis() as u64,
        model: settings.ollama_model.clone(),
    })
}

// ---------------------------------------------------------------------------
// Cloud gate
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRequest {
    pub meeting_id: Option<String>,
    /// "excerpt_analysis" (mode hybrid or deep) | "deep_analysis" (mode deep only)
    pub purpose: String,
    /// The exact text shown to the user and confirmed.
    pub payload: String,
    /// SHA-256 (hex) of the previewed payload, computed by the UI at confirmation time.
    pub preview_sha256: String,
    /// Explicit confirmation from the dialog.
    pub confirmed: bool,
}

pub fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

#[derive(Debug, PartialEq)]
pub enum GateRefusal {
    LocalMode,
    PurposeNotAllowed,
    NotConfirmed,
    PayloadChanged,
    EmptyPayload,
    TooLarge,
    NoApiKey,
}

impl GateRefusal {
    pub fn message(&self) -> &'static str {
        match self {
            GateRefusal::LocalMode => "Mode 100 % local : aucun envoi vers le cloud n'est autorisé. Changez de mode dans Réglages si vous le souhaitez.",
            GateRefusal::PurposeNotAllowed => "Ce type d'analyse n'est pas autorisé dans le mode actuel (l'analyse complète requiert le mode « Analyse approfondie »).",
            GateRefusal::NotConfirmed => "Envoi refusé : confirmation explicite manquante.",
            GateRefusal::PayloadChanged => "Envoi refusé : le contenu ne correspond pas à celui prévisualisé.",
            GateRefusal::EmptyPayload => "Rien à envoyer.",
            GateRefusal::TooLarge => "Contenu trop volumineux (max 200 000 caractères).",
            GateRefusal::NoApiKey => "Aucune clé API enregistrée pour ce fournisseur (Réglages → Cloud).",
        }
    }
}

pub fn check_cloud_gate(settings: &AppSettings, req: &CloudRequest, has_key: bool) -> Result<(), GateRefusal> {
    match (settings.ai_mode.as_str(), req.purpose.as_str()) {
        ("local", _) => return Err(GateRefusal::LocalMode),
        ("hybrid", "excerpt_analysis") | ("deep", "excerpt_analysis") | ("deep", "deep_analysis") => {}
        _ => return Err(GateRefusal::PurposeNotAllowed),
    }
    if !req.confirmed {
        return Err(GateRefusal::NotConfirmed);
    }
    if req.payload.trim().is_empty() {
        return Err(GateRefusal::EmptyPayload);
    }
    if req.payload.chars().count() > 200_000 {
        return Err(GateRefusal::TooLarge);
    }
    if sha256_hex(&req.payload) != req.preview_sha256.to_lowercase() {
        return Err(GateRefusal::PayloadChanged);
    }
    if !has_key {
        return Err(GateRefusal::NoApiKey);
    }
    Ok(())
}

/// Sends the confirmed payload to the configured provider. Only call after `check_cloud_gate`.
pub async fn cloud_send(settings: &AppSettings, api_key: &str, payload: &str) -> AppResult<String> {
    let p = &settings.cloud;
    if !p.base_url.starts_with("https://") {
        return Err(AppError::msg("URL du fournisseur non sécurisée (HTTPS requis)"));
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(180)).build()?;
    let base = p.base_url.trim_end_matches('/');
    match p.kind.as_str() {
        "anthropic" => {
            let body = json!({
                "model": p.model,
                "max_tokens": 16000,
                "fallbacks": "default",
                "messages": [{ "role": "user", "content": payload }],
            });
            let resp = client
                .post(format!("{base}/v1/messages"))
                .header("x-api-key", api_key)
                .header("anthropic-version", "2026-10-21")
                .header("anthropic-beta", "server-side-fallback-2026-07-01")
                .json(&body)
                .send()
                .await?;
            let status = resp.status();
            let v: Value = resp.json().await?;
            if !status.is_success() {
                return Err(AppError::msg(format!("Fournisseur cloud ({status}) : {}", v["error"]["message"].as_str().unwrap_or("erreur"))));
            }
            if v["stop_reason"] == "refusal" {
                return Err(AppError::msg("Le fournisseur a refusé de traiter cette demande."));
            }
            let text = v["content"]
                .as_array()
                .map(|blocks| blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"))
                .unwrap_or_default();
            Ok(text)
        }
        "openai_compatible" => {
            let body = json!({ "model": p.model, "messages": [{ "role": "user", "content": payload }] });
            let resp = client.post(format!("{base}/chat/completions")).bearer_auth(api_key).json(&body).send().await?;
            let status = resp.status();
            let v: Value = resp.json().await?;
            if !status.is_success() {
                return Err(AppError::msg(format!("Fournisseur cloud ({status}) : {}", v["error"]["message"].as_str().unwrap_or("erreur"))));
            }
            Ok(v["choices"][0]["message"]["content"].as_str().unwrap_or_default().to_string())
        }
        other => Err(AppError::msg(format!("Fournisseur inconnu : {other}"))),
    }
}

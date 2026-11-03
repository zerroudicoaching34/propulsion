//! Contract test of the Ollama client against a local mock that speaks the
//! documented Ollama HTTP API (/api/tags, /api/chat). No real model involved.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use ss_copilot_lib::llm::{ollama_chat, ollama_status, ChatMessage};
use ss_copilot_lib::settings::AppSettings;

fn mock_ollama() -> (String, Arc<Mutex<Vec<Value>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_c = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut s = stream.unwrap();
            let mut buf = vec![0u8; 65536];
            let mut req = Vec::new();
            loop {
                let n = s.read(&mut buf).unwrap();
                req.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&req);
                if let Some(idx) = text.find("\r\n\r\n") {
                    let len = text
                        .lines()
                        .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if req.len() >= idx + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let text = String::from_utf8_lossy(&req).to_string();
            let body = text.split("\r\n\r\n").nth(1).unwrap_or("");
            let resp = if text.starts_with("GET /api/tags") {
                json!({ "models": [{ "name": "qwen2.5:7b" }, { "name": "mistral:latest" }] })
            } else {
                seen_c.lock().unwrap().push(serde_json::from_str(body).unwrap_or(Value::Null));
                json!({ "model": "qwen2.5:7b", "message": { "role": "assistant", "content": "{\"questions\":[],\"objections\":[],\"suggestion\":null,\"summary\":\"ok\"}" }, "done": true })
            };
            let payload = resp.to_string();
            let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", payload.len(), payload);
        }
    });
    (format!("http://127.0.0.1:{}", addr.port()), seen)
}

#[tokio::test]
async fn ollama_status_and_chat_follow_the_api_contract() {
    let (url, seen) = mock_ollama();
    let mut s = AppSettings { ollama_url: url, ..Default::default() };
    let st = ollama_status(&s).await;
    assert!(st.reachable);
    assert!(st.configured_model_available);
    s.ollama_model = "llama3:8b".into();
    assert!(!ollama_status(&s).await.configured_model_available);
    s.ollama_model = "qwen2.5:7b".into();

    let reply = ollama_chat(&s, vec![ChatMessage { role: "user".into(), content: "Bonjour".into() }], Some(json!({ "type": "object" })))
        .await
        .unwrap();
    assert!(reply.content.contains("summary"));
    let req = &seen.lock().unwrap()[0];
    assert_eq!(req["model"], "qwen2.5:7b");
    assert_eq!(req["stream"], false);
    assert_eq!(req["format"]["type"], "object");
    assert_eq!(req["messages"][0]["content"], "Bonjour");
}

#[tokio::test]
async fn non_local_ollama_urls_are_refused_without_any_request() {
    let s = AppSettings { ollama_url: "http://203.0.113.10:11434".into(), ..Default::default() };
    assert!(!ollama_status(&s).await.reachable);
    assert!(ollama_chat(&s, vec![], None).await.is_err());
}

#[tokio::test]
async fn unreachable_ollama_reports_unavailable() {
    let s = AppSettings { ollama_url: "http://127.0.0.1:9".into(), ..Default::default() };
    let st = ollama_status(&s).await;
    assert!(!st.reachable);
    assert!(st.message.unwrap().contains("Ollama"));
}

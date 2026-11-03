//! Encrypted SQLite (SQLCipher) storage with versioned migrations.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::error::AppResult;

/// Ordered list of migrations. Never edit a published migration: add a new one.
pub const MIGRATIONS: &[(i64, &str)] = &[(1, include_str!("../migrations/0001_init.sql"))];

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

/// Opens (or creates) the database. `key_hex` is a 64-char hex key; `None` opens without encryption (tests only).
pub fn open(path: &Path, key_hex: Option<&str>) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    if let Some(key) = key_hex {
        if key.len() != 64 || !key.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(crate::error::AppError::msg("Clé de chiffrement invalide"));
        }
        conn.execute_batch(&format!("PRAGMA key = \"x'{key}'\";"))?;
    }
    // Fails with "file is not a database" if the key is wrong.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))?;
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON;")?;
    migrate(&conn)?;
    Ok(conn)
}

pub fn open_in_memory() -> AppResult<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    migrate(&conn)?;
    Ok(conn)
}

pub fn schema_version(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", [], |r| r.get(0))?)
}

pub fn migrate(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
    )?;
    let current = schema_version(conn)?;
    for (version, sql) in MIGRATIONS {
        if *version > current {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(sql)?;
            tx.execute("INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)", params![version, now()])?;
            tx.commit()?;
        }
    }
    Ok(())
}

// ---------- settings & knowledge base ----------

pub fn get_setting(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn kb_get(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn.query_row("SELECT value FROM kb WHERE key = ?1", [key], |r| r.get(0)).optional()?)
}

pub fn kb_set(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    serde_json::from_str::<serde_json::Value>(value)?; // must be valid JSON
    conn.execute(
        "INSERT INTO kb(key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now()],
    )?;
    Ok(())
}

// ---------- prospects ----------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Prospect {
    pub id: String,
    pub first_name: String,
    pub last_name: String,
    pub email: String,
    pub phone: String,
    pub objective: String,
    pub current_situation: String,
    pub previous_attempts: String,
    pub obstacles: String,
    pub constraints: String,
    pub budget: String,
    pub autonomy: String,
    pub decision_criteria: String,
    pub coach_notes: String,
    pub created_at: String,
    pub updated_at: String,
}

const PROSPECT_COLS: &str = "id, first_name, last_name, email, phone, objective, current_situation, previous_attempts, obstacles, constraints, budget, autonomy, decision_criteria, coach_notes, created_at, updated_at";

fn row_to_prospect(r: &rusqlite::Row) -> rusqlite::Result<Prospect> {
    Ok(Prospect {
        id: r.get(0)?,
        first_name: r.get(1)?,
        last_name: r.get(2)?,
        email: r.get(3)?,
        phone: r.get(4)?,
        objective: r.get(5)?,
        current_situation: r.get(6)?,
        previous_attempts: r.get(7)?,
        obstacles: r.get(8)?,
        constraints: r.get(9)?,
        budget: r.get(10)?,
        autonomy: r.get(11)?,
        decision_criteria: r.get(12)?,
        coach_notes: r.get(13)?,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
    })
}

pub fn prospect_list(conn: &Connection) -> AppResult<Vec<Prospect>> {
    let mut stmt = conn.prepare(&format!("SELECT {PROSPECT_COLS} FROM prospects ORDER BY updated_at DESC"))?;
    let rows = stmt.query_map([], row_to_prospect)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn prospect_get(conn: &Connection, id: &str) -> AppResult<Option<Prospect>> {
    Ok(conn
        .query_row(&format!("SELECT {PROSPECT_COLS} FROM prospects WHERE id = ?1"), [id], row_to_prospect)
        .optional()?)
}

pub fn prospect_upsert(conn: &Connection, mut p: Prospect) -> AppResult<Prospect> {
    let ts = now();
    if p.id.is_empty() {
        p.id = new_id("pr");
        p.created_at = ts.clone();
    }
    if p.created_at.is_empty() {
        p.created_at = ts.clone();
    }
    p.updated_at = ts;
    conn.execute(
        &format!(
            "INSERT INTO prospects ({PROSPECT_COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
             ON CONFLICT(id) DO UPDATE SET first_name=excluded.first_name, last_name=excluded.last_name, email=excluded.email,
             phone=excluded.phone, objective=excluded.objective, current_situation=excluded.current_situation,
             previous_attempts=excluded.previous_attempts, obstacles=excluded.obstacles, constraints=excluded.constraints,
             budget=excluded.budget, autonomy=excluded.autonomy, decision_criteria=excluded.decision_criteria,
             coach_notes=excluded.coach_notes, updated_at=excluded.updated_at"
        ),
        params![
            p.id, p.first_name, p.last_name, p.email, p.phone, p.objective, p.current_situation, p.previous_attempts,
            p.obstacles, p.constraints, p.budget, p.autonomy, p.decision_criteria, p.coach_notes, p.created_at, p.updated_at
        ],
    )?;
    Ok(p)
}

/// Deletes a prospect and, by cascade, all their meetings, segments and cloud results.
pub fn prospect_delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM prospects WHERE id = ?1", [id])?;
    Ok(())
}

// ---------- meetings ----------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Meeting {
    pub id: String,
    pub prospect_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub scheduled_at: String,
    pub status: String,
    pub consent_given: bool,
    pub consent_at: Option<String>,
    pub retain: bool,
    pub decision: String,
    pub next_action: String,
    pub objection_kinds: String,
    pub coverage_covered: i64,
    pub coverage_total: i64,
    pub analysis_json: Option<String>,
    pub debrief_json: Option<String>,
    pub content_purged: bool,
    pub created_at: String,
    pub updated_at: String,
}

const MEETING_COLS: &str = "id, prospect_id, type, scheduled_at, status, consent_given, consent_at, retain, decision, next_action, objection_kinds, coverage_covered, coverage_total, analysis_json, debrief_json, content_purged, created_at, updated_at";

fn row_to_meeting(r: &rusqlite::Row) -> rusqlite::Result<Meeting> {
    Ok(Meeting {
        id: r.get(0)?,
        prospect_id: r.get(1)?,
        kind: r.get(2)?,
        scheduled_at: r.get(3)?,
        status: r.get(4)?,
        consent_given: r.get::<_, i64>(5)? != 0,
        consent_at: r.get(6)?,
        retain: r.get::<_, i64>(7)? != 0,
        decision: r.get(8)?,
        next_action: r.get(9)?,
        objection_kinds: r.get(10)?,
        coverage_covered: r.get(11)?,
        coverage_total: r.get(12)?,
        analysis_json: r.get(13)?,
        debrief_json: r.get(14)?,
        content_purged: r.get::<_, i64>(15)? != 0,
        created_at: r.get(16)?,
        updated_at: r.get(17)?,
    })
}

pub fn meeting_list(conn: &Connection, prospect_id: Option<&str>) -> AppResult<Vec<Meeting>> {
    let mut out = Vec::new();
    match prospect_id {
        Some(pid) => {
            let mut stmt = conn.prepare(&format!("SELECT {MEETING_COLS} FROM meetings WHERE prospect_id = ?1 ORDER BY scheduled_at DESC"))?;
            for m in stmt.query_map([pid], row_to_meeting)? {
                out.push(m?);
            }
        }
        None => {
            let mut stmt = conn.prepare(&format!("SELECT {MEETING_COLS} FROM meetings ORDER BY scheduled_at DESC"))?;
            for m in stmt.query_map([], row_to_meeting)? {
                out.push(m?);
            }
        }
    }
    Ok(out)
}

pub fn meeting_get(conn: &Connection, id: &str) -> AppResult<Option<Meeting>> {
    Ok(conn
        .query_row(&format!("SELECT {MEETING_COLS} FROM meetings WHERE id = ?1"), [id], row_to_meeting)
        .optional()?)
}

pub fn meeting_create(conn: &Connection, prospect_id: &str, kind: &str, scheduled_at: &str, retain: bool) -> AppResult<Meeting> {
    if kind != "R1" && kind != "R2" {
        return Err(crate::error::AppError::msg("Type de rendez-vous invalide (R1 ou R2)"));
    }
    let ts = now();
    let id = new_id("mt");
    conn.execute(
        "INSERT INTO meetings (id, prospect_id, type, scheduled_at, retain, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)",
        params![id, prospect_id, kind, scheduled_at, retain as i64, ts],
    )?;
    Ok(meeting_get(conn, &id)?.expect("just inserted"))
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MeetingPatch {
    pub scheduled_at: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub status: Option<String>,
    pub retain: Option<bool>,
    pub decision: Option<String>,
    pub next_action: Option<String>,
    pub objection_kinds: Option<String>,
    pub coverage_covered: Option<i64>,
    pub coverage_total: Option<i64>,
    pub analysis_json: Option<String>,
    pub debrief_json: Option<String>,
}

pub fn meeting_update(conn: &Connection, id: &str, p: MeetingPatch) -> AppResult<Meeting> {
    let m = meeting_get(conn, id)?.ok_or_else(|| crate::error::AppError::msg("Rendez-vous introuvable"))?;
    if let Some(k) = &p.kind {
        if k != "R1" && k != "R2" {
            return Err(crate::error::AppError::msg("Type de rendez-vous invalide"));
        }
    }
    conn.execute(
        "UPDATE meetings SET scheduled_at=?2, type=?3, status=?4, retain=?5, decision=?6, next_action=?7, objection_kinds=?8,
         coverage_covered=?9, coverage_total=?10, analysis_json=?11, debrief_json=?12, updated_at=?13 WHERE id=?1",
        params![
            id,
            p.scheduled_at.unwrap_or(m.scheduled_at),
            p.kind.unwrap_or(m.kind),
            p.status.unwrap_or(m.status),
            p.retain.unwrap_or(m.retain) as i64,
            p.decision.unwrap_or(m.decision),
            p.next_action.unwrap_or(m.next_action),
            p.objection_kinds.unwrap_or(m.objection_kinds),
            p.coverage_covered.unwrap_or(m.coverage_covered),
            p.coverage_total.unwrap_or(m.coverage_total),
            p.analysis_json.or(m.analysis_json),
            p.debrief_json.or(m.debrief_json),
            now()
        ],
    )?;
    Ok(meeting_get(conn, id)?.expect("exists"))
}

pub fn meeting_set_consent(conn: &Connection, id: &str, given: bool) -> AppResult<Meeting> {
    let at = if given { Some(now()) } else { None };
    let n = conn.execute(
        "UPDATE meetings SET consent_given=?2, consent_at=?3, updated_at=?4 WHERE id=?1",
        params![id, given as i64, at, now()],
    )?;
    if n == 0 {
        return Err(crate::error::AppError::msg("Rendez-vous introuvable"));
    }
    Ok(meeting_get(conn, id)?.expect("exists"))
}

/// Deletes the meeting entirely (row, transcript, analysis, debrief, cloud results).
pub fn meeting_delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM meetings WHERE id = ?1", [id])?;
    Ok(())
}

/// Removes the conversation content but keeps non-content metadata used by statistics.
pub fn meeting_purge_content(conn: &Connection, id: &str) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM segments WHERE meeting_id = ?1", [id])?;
    tx.execute("DELETE FROM cloud_results WHERE meeting_id = ?1", [id])?;
    tx.execute(
        "UPDATE meetings SET analysis_json = NULL, debrief_json = NULL, content_purged = 1, updated_at = ?2 WHERE id = ?1",
        params![id, now()],
    )?;
    tx.commit()?;
    Ok(())
}

/// Retention policy: content of non-retained meetings is purged (at start-up and on exit);
/// retained meetings are purged after `retention_days`.
pub fn apply_retention(conn: &Connection, retention_days: i64) -> AppResult<usize> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(retention_days.max(0))).to_rfc3339();
    let mut stmt = conn.prepare(
        "SELECT id FROM meetings WHERE content_purged = 0 AND (retain = 0 OR updated_at < ?1)
         AND (EXISTS (SELECT 1 FROM segments s WHERE s.meeting_id = meetings.id) OR analysis_json IS NOT NULL OR debrief_json IS NOT NULL)",
    )?;
    let ids: Vec<String> = stmt.query_map([cutoff], |r| r.get(0))?.collect::<Result<_, _>>()?;
    for id in &ids {
        meeting_purge_content(conn, id)?;
    }
    Ok(ids.len())
}

// ---------- segments ----------

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Segment {
    pub id: String,
    pub meeting_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub speaker: String,
    pub text: String,
    pub confidence: Option<f64>,
    pub source: String,
    pub edited: bool,
}

fn row_to_segment(r: &rusqlite::Row) -> rusqlite::Result<Segment> {
    Ok(Segment {
        id: r.get(0)?,
        meeting_id: r.get(1)?,
        start_ms: r.get(2)?,
        end_ms: r.get(3)?,
        speaker: r.get(4)?,
        text: r.get(5)?,
        confidence: r.get(6)?,
        source: r.get(7)?,
        edited: r.get::<_, i64>(8)? != 0,
    })
}

pub fn segment_list(conn: &Connection, meeting_id: &str) -> AppResult<Vec<Segment>> {
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, start_ms, end_ms, speaker, text, confidence, source, edited FROM segments WHERE meeting_id = ?1 ORDER BY start_ms, rowid",
    )?;
    let rows = stmt.query_map([meeting_id], row_to_segment)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn check_speaker(s: &str) -> AppResult<()> {
    match s {
        "coach" | "prospect" | "unknown" => Ok(()),
        _ => Err(crate::error::AppError::msg("Locuteur invalide")),
    }
}

pub fn segment_insert(conn: &Connection, mut s: Segment) -> AppResult<Segment> {
    check_speaker(&s.speaker)?;
    if s.id.is_empty() {
        s.id = new_id("sg");
    }
    conn.execute(
        "INSERT INTO segments (id, meeting_id, start_ms, end_ms, speaker, text, confidence, source, edited) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![s.id, s.meeting_id, s.start_ms, s.end_ms, s.speaker, s.text, s.confidence, s.source, s.edited as i64],
    )?;
    Ok(s)
}

pub fn segment_update(conn: &Connection, id: &str, speaker: Option<String>, text: Option<String>) -> AppResult<Segment> {
    let cur = conn
        .query_row(
            "SELECT id, meeting_id, start_ms, end_ms, speaker, text, confidence, source, edited FROM segments WHERE id = ?1",
            [id],
            row_to_segment,
        )
        .optional()?
        .ok_or_else(|| crate::error::AppError::msg("Segment introuvable"))?;
    let speaker = speaker.unwrap_or(cur.speaker);
    check_speaker(&speaker)?;
    let text = text.unwrap_or(cur.text);
    conn.execute("UPDATE segments SET speaker=?2, text=?3, edited=1 WHERE id=?1", params![id, speaker, text])?;
    Ok(Segment { speaker, text, edited: true, ..cur })
}

pub fn segment_delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM segments WHERE id = ?1", [id])?;
    Ok(())
}

// ---------- cloud log ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudTransfer {
    pub id: String,
    pub meeting_id: Option<String>,
    pub provider: String,
    pub model: String,
    pub purpose: String,
    pub bytes: i64,
    pub sha256: String,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
}

pub fn transfer_log(conn: &Connection, t: &CloudTransfer) -> AppResult<()> {
    conn.execute(
        "INSERT INTO cloud_transfers (id, meeting_id, provider, model, purpose, bytes, sha256, status, error, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, error = excluded.error",
        params![t.id, t.meeting_id, t.provider, t.model, t.purpose, t.bytes, t.sha256, t.status, t.error, t.created_at],
    )?;
    Ok(())
}

pub fn transfer_list(conn: &Connection) -> AppResult<Vec<CloudTransfer>> {
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, provider, model, purpose, bytes, sha256, status, error, created_at FROM cloud_transfers ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(CloudTransfer {
            id: r.get(0)?,
            meeting_id: r.get(1)?,
            provider: r.get(2)?,
            model: r.get(3)?,
            purpose: r.get(4)?,
            bytes: r.get(5)?,
            sha256: r.get(6)?,
            status: r.get(7)?,
            error: r.get(8)?,
            created_at: r.get(9)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudResult {
    pub id: String,
    pub meeting_id: String,
    pub transfer_id: String,
    pub provider: String,
    pub model: String,
    pub content: String,
    pub created_at: String,
}

pub fn cloud_result_insert(conn: &Connection, r: &CloudResult) -> AppResult<()> {
    conn.execute(
        "INSERT INTO cloud_results (id, meeting_id, transfer_id, provider, model, content, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![r.id, r.meeting_id, r.transfer_id, r.provider, r.model, r.content, r.created_at],
    )?;
    Ok(())
}

pub fn cloud_result_list(conn: &Connection, meeting_id: &str) -> AppResult<Vec<CloudResult>> {
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, transfer_id, provider, model, content, created_at FROM cloud_results WHERE meeting_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([meeting_id], |r| {
        Ok(CloudResult {
            id: r.get(0)?,
            meeting_id: r.get(1)?,
            transfer_id: r.get(2)?,
            provider: r.get(3)?,
            model: r.get(4)?,
            content: r.get(5)?,
            created_at: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

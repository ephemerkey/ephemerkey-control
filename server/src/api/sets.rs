//! Manager API — every endpoint requires an EK1 owner-key signature.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;

use crate::auth::{self, consume_challenge, parse_ek1, verify_sig};
use crate::db::{now, AppState};
use crate::error::ApiError;
use sqlx::Row;

fn parse_hex(field: &str, s: &str, expect_len: Option<usize>) -> Result<Vec<u8>, ApiError> {
    let bytes = hex::decode(s)
        .map_err(|_| ApiError::BadRequest(format!("{field}: invalid hex")))?;
    if let Some(n) = expect_len {
        if bytes.len() != n {
            return Err(ApiError::BadRequest(format!(
                "{field}: expected {n} bytes, got {}",
                bytes.len()
            )));
        }
    }
    Ok(bytes)
}

/// Look up the set and verify the EK1 header against its owner key.
/// `payload` is the request body for POSTs, the full request path
/// (lowercase set_id) for GETs.
async fn require_manager(
    st: &AppState,
    headers: &HeaderMap,
    set_id: &[u8],
    payload: &[u8],
) -> Result<Vec<u8>, ApiError> {
    let owner_pub: Vec<u8> = sqlx::query("SELECT owner_pub FROM sets WHERE set_id = ?")
        .bind(set_id)
        .fetch_optional(&st.db)
        .await?
        .ok_or(ApiError::NotFound("set not registered on this server — register it first"))?
        .get(0);
    let ek1 = parse_ek1(headers)?;
    consume_challenge(st, &ek1.nonce, "manager").await?;
    verify_sig(&owner_pub, auth::CTX_MANAGER, &ek1.nonce, payload, &ek1.sig)?;
    Ok(owner_pub)
}

#[derive(serde::Deserialize)]
struct CreateSetReq {
    owner_pub: String,
    name: Option<String>,
}

/// POST /api/sets — register a set. The signature is made with the key being
/// registered, proving possession; the server derives set_id from it.
pub async fn create_set(
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    let req: CreateSetReq = serde_json::from_slice(&body)
        .map_err(|e| ApiError::BadRequest(format!("bad json: {e}")))?;
    let owner_pub = parse_hex("owner_pub", &req.owner_pub, Some(32))?;

    let ek1 = parse_ek1(&headers)?;
    consume_challenge(&st, &ek1.nonce, "manager").await?;
    verify_sig(&owner_pub, auth::CTX_REGISTER, &ek1.nonce, &body, &ek1.sig)?;

    let set_id = auth::set_id_from_owner_pub(&owner_pub);
    let res = sqlx::query(
        "INSERT INTO sets (set_id, owner_pub, name, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(set_id) DO NOTHING",
    )
    .bind(set_id.as_slice())
    .bind(&owner_pub)
    .bind(&req.name)
    .bind(now())
    .execute(&st.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::Conflict("set already registered".into()));
    }
    Ok(Json(serde_json::json!({ "set_id": hex::encode(set_id) })))
}

/// GET /api/sets/{set_id} — roster with per-device config/ack state.
pub async fn roster(
    State(st): State<AppState>,
    Path(set_id_hex): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let set_id = parse_hex("set_id", &set_id_hex, Some(8))?;
    let path = format!("/api/sets/{}", set_id_hex.to_lowercase());
    require_manager(&st, &headers, &set_id, path.as_bytes()).await?;

    let set_row = sqlx::query("SELECT name, created_at FROM sets WHERE set_id = ?")
        .bind(&set_id)
        .fetch_one(&st.db)
        .await?;
    let devices = sqlx::query(
        "SELECT d.device_id, d.sign_pub, d.kx_pub, d.role, d.name, d.fw,
                d.enrolled_at, d.last_seen_at, d.acked_seq,
                (SELECT MAX(seq) FROM config_blobs c WHERE c.device_id = d.device_id) AS latest_seq
         FROM devices d WHERE d.set_id = ? ORDER BY d.enrolled_at",
    )
    .bind(&set_id)
    .fetch_all(&st.db)
    .await?;

    let devices: Vec<serde_json::Value> = devices
        .iter()
        .map(|r| {
            serde_json::json!({
                "device_id": hex::encode(r.get::<Vec<u8>, _>("device_id")),
                "sign_pub": hex::encode(r.get::<Vec<u8>, _>("sign_pub")),
                "kx_pub": hex::encode(r.get::<Vec<u8>, _>("kx_pub")),
                "role": r.get::<i64, _>("role"),
                "name": r.get::<Option<String>, _>("name"),
                "fw": r.get::<Option<String>, _>("fw"),
                "enrolled_at": r.get::<i64, _>("enrolled_at"),
                "last_seen_at": r.get::<Option<i64>, _>("last_seen_at"),
                "acked_seq": r.get::<i64, _>("acked_seq"),
                "latest_seq": r.get::<Option<i64>, _>("latest_seq"),
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "set_id": set_id_hex.to_lowercase(),
        "name": set_row.get::<Option<String>, _>("name"),
        "created_at": set_row.get::<i64, _>("created_at"),
        "devices": devices,
    })))
}

#[derive(serde::Deserialize)]
struct AddDeviceReq {
    device_id: String,
    sign_pub: String,
    kx_pub: String,
    role: i64,
    name: Option<String>,
    fw: Option<String>,
    // TODO: carry the raw self-signed enrollment doc and verify it against
    // sign_pub once the firmware COSE enrollment format is pinned.
}

/// POST /api/sets/{set_id}/devices — add a device from its enrollment doc
/// ("binding key information").
pub async fn add_device(
    State(st): State<AppState>,
    Path(set_id_hex): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    let set_id = parse_hex("set_id", &set_id_hex, Some(8))?;
    require_manager(&st, &headers, &set_id, &body).await?;

    let req: AddDeviceReq = serde_json::from_slice(&body)
        .map_err(|e| ApiError::BadRequest(format!("bad json: {e}")))?;
    let device_id = parse_hex("device_id", &req.device_id, None)?;
    let sign_pub = parse_hex("sign_pub", &req.sign_pub, Some(32))?;
    let kx_pub = parse_hex("kx_pub", &req.kx_pub, Some(32))?;
    if !matches!(req.role, 1 | 2) {
        return Err(ApiError::BadRequest("role must be 1 (generator) or 2 (lock-controller)".into()));
    }

    let res = sqlx::query(
        "INSERT INTO devices (device_id, set_id, sign_pub, kx_pub, role, name, fw, enrolled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(device_id) DO NOTHING",
    )
    .bind(&device_id)
    .bind(&set_id)
    .bind(&sign_pub)
    .bind(&kx_pub)
    .bind(req.role)
    .bind(&req.name)
    .bind(&req.fw)
    .bind(now())
    .execute(&st.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::Conflict("device already enrolled".into()));
    }
    Ok(Json(serde_json::json!({ "device_id": req.device_id })))
}

#[derive(serde::Deserialize)]
struct PutConfigReq {
    device_id: String,
    seq: i64,
    /// Sealed COSE_Encrypt0(COSE_Sign1(config)) — opaque to the server.
    blob_b64: String,
}

/// POST /api/sets/{set_id}/configs — store a sealed config blob for a device.
/// The server enforces seq monotonicity from plaintext metadata only; it
/// never sees inside the envelope. TODO: cross-check seq/target against the
/// COSE headers once the envelope format is pinned.
pub async fn put_config(
    State(st): State<AppState>,
    Path(set_id_hex): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    use base64::Engine as _;
    let set_id = parse_hex("set_id", &set_id_hex, Some(8))?;
    require_manager(&st, &headers, &set_id, &body).await?;

    let req: PutConfigReq = serde_json::from_slice(&body)
        .map_err(|e| ApiError::BadRequest(format!("bad json: {e}")))?;
    let device_id = parse_hex("device_id", &req.device_id, None)?;
    let blob = base64::engine::general_purpose::STANDARD
        .decode(&req.blob_b64)
        .map_err(|_| ApiError::BadRequest("blob_b64: invalid base64".into()))?;
    if blob.is_empty() || blob.len() > 4096 {
        return Err(ApiError::BadRequest("blob must be 1..=4096 bytes".into()));
    }

    // The blob must be a well-formed sealed envelope whose (unencrypted but
    // AEAD-authenticated) routing headers match the claimed device + seq.
    let (peek_seq, peek_target) = ephemerkey_envelope::peek(&blob)
        .map_err(|e| ApiError::BadRequest(format!("blob is not a sealed envelope: {e:?}")))?;
    if peek_seq != req.seq as u64 || peek_target != device_id.as_slice() {
        return Err(ApiError::BadRequest(
            "envelope header seq/target does not match request".into(),
        ));
    }

    let row = sqlx::query(
        "SELECT d.acked_seq,
                (SELECT MAX(seq) FROM config_blobs c WHERE c.device_id = d.device_id) AS latest_seq
         FROM devices d WHERE d.device_id = ? AND d.set_id = ?",
    )
    .bind(&device_id)
    .bind(&set_id)
    .fetch_optional(&st.db)
    .await?
    .ok_or(ApiError::NotFound("device not enrolled in this set"))?;
    let floor = row
        .get::<i64, _>("acked_seq")
        .max(row.get::<Option<i64>, _>("latest_seq").unwrap_or(0));
    if req.seq <= floor {
        return Err(ApiError::Conflict(format!(
            "seq {} not greater than current {floor}",
            req.seq
        )));
    }

    sqlx::query(
        "INSERT INTO config_blobs (set_id, device_id, seq, blob, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&set_id)
    .bind(&device_id)
    .bind(req.seq)
    .bind(&blob)
    .bind(now())
    .execute(&st.db)
    .await?;
    Ok(Json(serde_json::json!({ "device_id": req.device_id, "seq": req.seq })))
}

/// GET /api/sets/{set_id}/events — verified telemetry history.
pub async fn events(
    State(st): State<AppState>,
    Path(set_id_hex): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let set_id = parse_hex("set_id", &set_id_hex, Some(8))?;
    let path = format!("/api/sets/{}/events", set_id_hex.to_lowercase());
    require_manager(&st, &headers, &set_id, path.as_bytes()).await?;

    let rows = sqlx::query(
        "SELECT e.device_id, e.seq, e.rtc_ts, e.type, e.received_at, e.transport
         FROM events e JOIN devices d ON d.device_id = e.device_id
         WHERE d.set_id = ? ORDER BY e.received_at DESC LIMIT 500",
    )
    .bind(&set_id)
    .fetch_all(&st.db)
    .await?;
    let events: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "device_id": hex::encode(r.get::<Vec<u8>, _>("device_id")),
                "seq": r.get::<i64, _>("seq"),
                "rtc_ts": r.get::<Option<i64>, _>("rtc_ts"),
                "type": r.get::<i64, _>("type"),
                "received_at": r.get::<i64, _>("received_at"),
                "transport": r.get::<String, _>("transport"),
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "events": events })))
}

/// GET /api/sets/{set_id}/configs — history of pushed blobs ("what is out
/// there"), so the console can audit/recover independent of browser state.
pub async fn list_configs(
    State(st): State<AppState>,
    Path(set_id_hex): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let set_id = parse_hex("set_id", &set_id_hex, Some(8))?;
    let path = format!("/api/sets/{}/configs", set_id_hex.to_lowercase());
    require_manager(&st, &headers, &set_id, path.as_bytes()).await?;

    let rows = sqlx::query(
        "SELECT device_id, seq, LENGTH(blob) AS size, created_at, acked_at
         FROM config_blobs WHERE set_id = ? ORDER BY created_at DESC LIMIT 500",
    )
    .bind(&set_id)
    .fetch_all(&st.db)
    .await?;
    let configs: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "device_id": hex::encode(r.get::<Vec<u8>, _>("device_id")),
                "seq": r.get::<i64, _>("seq"),
                "size": r.get::<i64, _>("size"),
                "created_at": r.get::<i64, _>("created_at"),
                "acked_at": r.get::<Option<i64>, _>("acked_at"),
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "configs": configs })))
}

/// GET /api/sets/{set_id}/configs/{device_id}/{seq} — download a pushed blob
/// (still sealed to the device; useful for audit, re-push, sneakernet export).
pub async fn get_config_blob(
    State(st): State<AppState>,
    Path((set_id_hex, device_id_hex, seq)): Path<(String, String, i64)>,
    headers: HeaderMap,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    let set_id = parse_hex("set_id", &set_id_hex, Some(8))?;
    let device_id = parse_hex("device_id", &device_id_hex, None)?;
    let path = format!(
        "/api/sets/{}/configs/{}/{}",
        set_id_hex.to_lowercase(),
        device_id_hex.to_lowercase(),
        seq
    );
    require_manager(&st, &headers, &set_id, path.as_bytes()).await?;

    let row = sqlx::query(
        "SELECT blob FROM config_blobs WHERE set_id = ? AND device_id = ? AND seq = ?",
    )
    .bind(&set_id)
    .bind(&device_id)
    .bind(seq)
    .fetch_optional(&st.db)
    .await?
    .ok_or(ApiError::NotFound("no config blob at that seq"))?;
    let blob: Vec<u8> = row.get("blob");
    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
        blob,
    ))
}

fn check_blob_kind(kind: &str) -> Result<(), ApiError> {
    match kind {
        "source" | "keywrap" => Ok(()),
        k => Err(ApiError::BadRequest(format!("unknown blob kind '{k}'"))),
    }
}

/// POST /api/sets/{set_id}/blobs/{kind} — upsert a per-set opaque blob.
/// Body is the raw blob bytes (the signed payload). 'source' is the config
/// source-of-truth sealed to the owner-derived X25519 key; 'keywrap' is the
/// passphrase-wrapped owner keyfile. The server can read neither.
pub async fn put_set_blob(
    State(st): State<AppState>,
    Path((set_id_hex, kind)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    check_blob_kind(&kind)?;
    let set_id = parse_hex("set_id", &set_id_hex, Some(8))?;
    if body.is_empty() || body.len() > 256 * 1024 {
        return Err(ApiError::BadRequest("blob must be 1..=262144 bytes".into()));
    }
    require_manager(&st, &headers, &set_id, &body).await?;

    sqlx::query(
        "INSERT INTO set_blobs (set_id, kind, blob, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(set_id, kind) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at",
    )
    .bind(&set_id)
    .bind(&kind)
    .bind(body.as_ref())
    .bind(now())
    .execute(&st.db)
    .await?;
    Ok(Json(serde_json::json!({ "kind": kind, "size": body.len() })))
}

/// GET /api/sets/{set_id}/blobs/{kind}.
/// 'source' requires manager auth. 'keywrap' is deliberately public: it
/// exists to bootstrap a fresh browser *before* the key is available, and is
/// protected by its passphrase KDF (see DESIGN.md for the tradeoff).
pub async fn get_set_blob(
    State(st): State<AppState>,
    Path((set_id_hex, kind)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    check_blob_kind(&kind)?;
    let set_id = parse_hex("set_id", &set_id_hex, Some(8))?;
    if kind == "source" {
        let path = format!("/api/sets/{}/blobs/source", set_id_hex.to_lowercase());
        require_manager(&st, &headers, &set_id, path.as_bytes()).await?;
    }

    let row = sqlx::query("SELECT blob, updated_at FROM set_blobs WHERE set_id = ? AND kind = ?")
        .bind(&set_id)
        .bind(&kind)
        .fetch_optional(&st.db)
        .await?
        .ok_or(ApiError::NotFound("no stored blob of this kind"))?;
    let blob: Vec<u8> = row.get("blob");
    let updated_at: i64 = row.get("updated_at");
    Ok((
        [
            (
                axum::http::header::CONTENT_TYPE,
                "application/octet-stream".to_string(),
            ),
            (
                axum::http::header::HeaderName::from_static("x-ek-updated-at"),
                updated_at.to_string(),
            ),
        ],
        blob,
    ))
}

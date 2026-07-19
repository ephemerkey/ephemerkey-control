//! Public courier API — unauthenticated by design. Couriers ferry sealed
//! blobs they cannot read; the only state they learn is "device X has a
//! pending update at seq N".

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use sqlx::Row;

use crate::db::AppState;
use crate::error::ApiError;

#[derive(serde::Deserialize)]
pub struct IdentifyReq {
    pub device_id: String,
    // TODO once firmware IDENTITY/CHALLENGE_SIG frames exist: carry the
    // device-signed challenge here and verify against devices.sign_pub so a
    // courier can't probe pending-update state for arbitrary device ids.
    #[allow(dead_code)]
    pub challenge_sig: Option<String>,
}

/// POST /api/courier/identify → { pending, seq }
pub async fn identify(
    State(st): State<AppState>,
    Json(req): Json<IdentifyReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let device_id = hex::decode(&req.device_id)
        .map_err(|_| ApiError::BadRequest("device_id: invalid hex".into()))?;
    let row = sqlx::query(
        "SELECT d.acked_seq,
                (SELECT MAX(seq) FROM config_blobs c
                 WHERE c.device_id = d.device_id AND c.acked_at IS NULL) AS pending_seq
         FROM devices d WHERE d.device_id = ?",
    )
    .bind(&device_id)
    .fetch_optional(&st.db)
    .await?
    .ok_or(ApiError::NotFound)?;

    let pending_seq: Option<i64> = row.get("pending_seq");
    Ok(Json(serde_json::json!({
        "pending": pending_seq.is_some(),
        "seq": pending_seq,
        "acked_seq": row.get::<i64, _>("acked_seq"),
    })))
}

/// GET /api/courier/config/{device_id} — the sealed blob for the newest
/// unacked seq, as opaque bytes.
pub async fn fetch_config(
    State(st): State<AppState>,
    Path(device_id_hex): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let device_id = hex::decode(&device_id_hex)
        .map_err(|_| ApiError::BadRequest("device_id: invalid hex".into()))?;
    let row = sqlx::query(
        "SELECT seq, blob FROM config_blobs
         WHERE device_id = ? AND acked_at IS NULL ORDER BY seq DESC LIMIT 1",
    )
    .bind(&device_id)
    .fetch_optional(&st.db)
    .await?
    .ok_or(ApiError::NotFound)?;

    let seq: i64 = row.get("seq");
    let blob: Vec<u8> = row.get("blob");
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::HeaderName::from_static("x-ek-seq"), seq.to_string()),
        ],
        blob,
    ))
}

#[derive(serde::Deserialize)]
pub struct AckReq {
    pub device_id: String,
    pub seq: i64,
    /// Device-signed config-ack (COSE_Sign1), base64.
    pub ack_b64: String,
}

/// POST /api/courier/ack — verify a device-signed config-ack
/// (COSE_Sign1 over `{seq, sha256(sealed blob)}`) and record delivery.
pub async fn ack(
    State(st): State<AppState>,
    Json(req): Json<AckReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};

    let device_id = hex::decode(&req.device_id)
        .map_err(|_| ApiError::BadRequest("device_id: invalid hex".into()))?;
    let ack = base64::engine::general_purpose::STANDARD
        .decode(&req.ack_b64)
        .map_err(|_| ApiError::BadRequest("ack_b64: invalid base64".into()))?;

    let sign_pub: Vec<u8> = sqlx::query("SELECT sign_pub FROM devices WHERE device_id = ?")
        .bind(&device_id)
        .fetch_optional(&st.db)
        .await?
        .ok_or(ApiError::NotFound)?
        .get(0);
    let key_bytes: [u8; 32] = sign_pub
        .as_slice()
        .try_into()
        .map_err(|_| ApiError::BadRequest("stored sign_pub malformed".into()))?;
    let key = ephemerkey_envelope::VerifyingKey::from_bytes(&key_bytes)
        .map_err(|_| ApiError::BadRequest("stored sign_pub invalid".into()))?;

    let mut scratch = vec![0u8; ack.len() + 64];
    let (payload, _kid) = ephemerkey_envelope::sign1_verify(&ack, &mut scratch, &key)
        .map_err(|_| ApiError::Unauthorized("ack signature verification failed".into()))?;
    let (seq, hash) = ephemerkey_envelope::schema::ack_decode(payload)
        .map_err(|_| ApiError::BadRequest("malformed ack payload".into()))?;
    if seq != req.seq as u64 {
        return Err(ApiError::BadRequest("ack seq does not match request".into()));
    }

    let blob: Vec<u8> =
        sqlx::query("SELECT blob FROM config_blobs WHERE device_id = ? AND seq = ?")
            .bind(&device_id)
            .bind(req.seq)
            .fetch_optional(&st.db)
            .await?
            .ok_or(ApiError::NotFound)?
            .get(0);
    if Sha256::digest(&blob).as_slice() != hash {
        return Err(ApiError::Unauthorized("ack hash does not match stored blob".into()));
    }

    let now = crate::db::now();
    sqlx::query("UPDATE config_blobs SET acked_at = ? WHERE device_id = ? AND seq = ?")
        .bind(now)
        .bind(&device_id)
        .bind(req.seq)
        .execute(&st.db)
        .await?;
    sqlx::query(
        "UPDATE devices SET acked_seq = MAX(acked_seq, ?), last_seen_at = ? WHERE device_id = ?",
    )
    .bind(req.seq)
    .bind(now)
    .bind(&device_id)
    .execute(&st.db)
    .await?;
    Ok(Json(serde_json::json!({ "acked": req.seq })))
}

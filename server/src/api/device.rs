//! Device API — the ESP32-C3 side-channel. Devices poll for sealed config
//! blobs and push signed event batches; the server records last-seen.

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use sqlx::Row;

use crate::db::{now, AppState};
use crate::error::ApiError;

#[derive(serde::Deserialize)]
pub struct ConfigQuery {
    /// Highest seq the device already holds.
    #[serde(default)]
    pub after: i64,
}

/// GET /api/device/{device_id}/config?after=N → 200 sealed blob | 204.
pub async fn get_config(
    State(st): State<AppState>,
    Path(device_id_hex): Path<String>,
    Query(q): Query<ConfigQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let device_id = hex::decode(&device_id_hex)
        .map_err(|_| ApiError::BadRequest("device_id: invalid hex".into()))?;
    let touched = sqlx::query("UPDATE devices SET last_seen_at = ? WHERE device_id = ?")
        .bind(now())
        .bind(&device_id)
        .execute(&st.db)
        .await?;
    if touched.rows_affected() == 0 {
        return Err(ApiError::NotFound("device not enrolled"));
    }

    let row = sqlx::query(
        "SELECT seq, blob FROM config_blobs
         WHERE device_id = ? AND seq > ? ORDER BY seq DESC LIMIT 1",
    )
    .bind(&device_id)
    .bind(q.after)
    .fetch_optional(&st.db)
    .await?;

    match row {
        None => Ok(StatusCode::NO_CONTENT.into_response()),
        Some(row) => {
            let seq: i64 = row.get("seq");
            let blob: Vec<u8> = row.get("blob");
            Ok((
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                    (header::HeaderName::from_static("x-ek-seq"), seq.to_string()),
                ],
                blob,
            )
                .into_response())
        }
    }
}

/// POST /api/device/{device_id}/events — raw COSE_Sign1 body wrapping a
/// CBOR event batch. Verified against the enrolled device signing key;
/// UNIQUE(device_id, seq) dedupes redelivered batches.
pub async fn post_events(
    State(st): State<AppState>,
    Path(device_id_hex): Path<String>,
    body: Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    let device_id = hex::decode(&device_id_hex)
        .map_err(|_| ApiError::BadRequest("device_id: invalid hex".into()))?;
    let sign_pub: Vec<u8> = sqlx::query("SELECT sign_pub FROM devices WHERE device_id = ?")
        .bind(&device_id)
        .fetch_optional(&st.db)
        .await?
        .ok_or(ApiError::NotFound("device not enrolled"))?
        .get(0);
    let key_bytes: [u8; 32] = sign_pub
        .as_slice()
        .try_into()
        .map_err(|_| ApiError::BadRequest("stored sign_pub malformed".into()))?;
    let key = ephemerkey_envelope::VerifyingKey::from_bytes(&key_bytes)
        .map_err(|_| ApiError::BadRequest("stored sign_pub invalid".into()))?;

    let mut scratch = vec![0u8; body.len() + 64];
    let (payload, _kid) = ephemerkey_envelope::sign1_verify(&body, &mut scratch, &key)
        .map_err(|_| ApiError::Unauthorized("event batch signature verification failed".into()))?;

    let now = now();
    let mut inserted = 0u64;
    let iter = ephemerkey_envelope::schema::EventIter::new(payload)
        .map_err(|_| ApiError::BadRequest("malformed event batch".into()))?;
    for ev in iter {
        let ev = ev.map_err(|_| ApiError::BadRequest("malformed event".into()))?;
        let res = sqlx::query(
            "INSERT OR IGNORE INTO events
             (device_id, seq, rtc_ts, type, detail, chain_tag, received_at, transport)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'wifi')",
        )
        .bind(&device_id)
        .bind(ev.seq as i64)
        .bind(ev.rtc_ts as i64)
        .bind(ev.kind as i64)
        .bind(ev.detail)
        .bind(ev.chain_tag)
        .bind(now)
        .execute(&st.db)
        .await?;
        inserted += res.rows_affected();
    }

    sqlx::query("UPDATE devices SET last_seen_at = ? WHERE device_id = ?")
        .bind(now)
        .bind(&device_id)
        .execute(&st.db)
        .await?;
    Ok(Json(serde_json::json!({ "inserted": inserted })))
}

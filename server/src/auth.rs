//! Capability auth: no accounts. A manager proves possession of a set's
//! owner Ed25519 key by signing `context || nonce || SHA-256(payload)` over a
//! single-use server-issued nonce. `payload` is the request body for POSTs
//! and the full request path for GETs (binding the signature to the exact
//! resource). See DESIGN.md "API surface".

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::db::{now, AppState};
use crate::error::ApiError;

pub const CHALLENGE_TTL_S: i64 = 300;

/// Domain-separation contexts.
pub const CTX_REGISTER: &str = "ekctl-register-v1";
pub const CTX_MANAGER: &str = "ekctl-manager-v1";

#[derive(serde::Deserialize)]
pub struct ChallengeReq {
    /// 'manager' | 'courier' | 'device'
    pub purpose: String,
}

#[derive(serde::Serialize)]
pub struct ChallengeResp {
    pub nonce: String,
    pub ttl_s: i64,
}

pub async fn issue_challenge(
    State(st): State<AppState>,
    Json(req): Json<ChallengeReq>,
) -> Result<Json<ChallengeResp>, ApiError> {
    match req.purpose.as_str() {
        "manager" | "courier" | "device" => {}
        p => return Err(ApiError::BadRequest(format!("unknown purpose '{p}'"))),
    }
    let mut nonce = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    sqlx::query("INSERT INTO challenges (nonce, purpose, created_at) VALUES (?, ?, ?)")
        .bind(nonce.as_slice())
        .bind(&req.purpose)
        .bind(now())
        .execute(&st.db)
        .await?;
    Ok(Json(ChallengeResp {
        nonce: hex::encode(nonce),
        ttl_s: CHALLENGE_TTL_S,
    }))
}

/// Parsed `Authorization: EK1 <nonce_hex>:<sig_hex>` header.
pub struct Ek1 {
    pub nonce: Vec<u8>,
    pub sig: Signature,
}

pub fn parse_ek1(headers: &HeaderMap) -> Result<Ek1, ApiError> {
    let raw = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::Unauthorized("missing Authorization header".into()))?;
    let rest = raw
        .strip_prefix("EK1 ")
        .ok_or_else(|| ApiError::Unauthorized("expected EK1 scheme".into()))?;
    let (nonce_hex, sig_hex) = rest
        .split_once(':')
        .ok_or_else(|| ApiError::Unauthorized("malformed EK1 credential".into()))?;
    let nonce = hex::decode(nonce_hex)
        .map_err(|_| ApiError::Unauthorized("bad nonce hex".into()))?;
    let sig_bytes = hex::decode(sig_hex)
        .map_err(|_| ApiError::Unauthorized("bad signature hex".into()))?;
    let sig = Signature::from_slice(&sig_bytes)
        .map_err(|_| ApiError::Unauthorized("bad signature length".into()))?;
    Ok(Ek1 { nonce, sig })
}

/// Deletes the nonce (single use) and checks purpose + TTL.
pub async fn consume_challenge(
    st: &AppState,
    nonce: &[u8],
    purpose: &str,
) -> Result<(), ApiError> {
    let row: Option<(String, i64)> =
        sqlx::query_as("DELETE FROM challenges WHERE nonce = ? RETURNING purpose, created_at")
            .bind(nonce)
            .fetch_optional(&st.db)
            .await?;
    let (stored_purpose, created_at) =
        row.ok_or_else(|| ApiError::Unauthorized("unknown or reused nonce".into()))?;
    if stored_purpose != purpose {
        return Err(ApiError::Unauthorized("nonce purpose mismatch".into()));
    }
    if now() - created_at > CHALLENGE_TTL_S {
        return Err(ApiError::Unauthorized("challenge expired".into()));
    }
    Ok(())
}

/// Verify `sig` by `pub_key` over `context || nonce || SHA-256(payload)`.
pub fn verify_sig(
    pub_key: &[u8],
    context: &str,
    nonce: &[u8],
    payload: &[u8],
    sig: &Signature,
) -> Result<(), ApiError> {
    let key_bytes: [u8; 32] = pub_key
        .try_into()
        .map_err(|_| ApiError::Unauthorized("bad public key length".into()))?;
    let key = VerifyingKey::from_bytes(&key_bytes)
        .map_err(|_| ApiError::Unauthorized("invalid public key".into()))?;
    let mut msg = Vec::with_capacity(context.len() + nonce.len() + 32);
    msg.extend_from_slice(context.as_bytes());
    msg.extend_from_slice(nonce);
    msg.extend_from_slice(&Sha256::digest(payload));
    key.verify(&msg, sig)
        .map_err(|_| ApiError::Unauthorized("signature verification failed".into()))
}

/// set_id = SHA-256(owner_pub)[0..16] — 128-bit management id (harder to
/// enumerate than the original 64-bit; device binding uses owner_pub, not
/// this, so length is a control-plane choice).
pub fn set_id_from_owner_pub(owner_pub: &[u8]) -> [u8; 16] {
    let digest = Sha256::digest(owner_pub);
    digest[..16].try_into().unwrap()
}

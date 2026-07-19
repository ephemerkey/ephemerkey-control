mod api;
mod auth;
mod db;
mod error;
mod telemetry;

use axum::routing::{get, post};
use axum::{Json, Router};
use db::AppState;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "service": "ekctl-server" }))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=debug".into()),
        )
        .init();

    let db_path = std::env::var("EKCTL_DB").unwrap_or_else(|_| "ekctl.db".into());
    let listen = std::env::var("EKCTL_LISTEN").unwrap_or_else(|_| "127.0.0.1:8321".into());

    let pool = db::connect(&db_path).await.expect("open database");
    let state = AppState { db: pool };

    let api = Router::new()
        .route("/health", get(health))
        .route("/challenge", post(auth::issue_challenge))
        // Manager (owner-key signed)
        .route("/sets", post(api::sets::create_set))
        .route("/sets/{set_id}", get(api::sets::roster))
        .route("/sets/{set_id}/devices", post(api::sets::add_device))
        .route(
            "/sets/{set_id}/configs",
            get(api::sets::list_configs).post(api::sets::put_config),
        )
        .route(
            "/sets/{set_id}/configs/{device_id}/{seq}",
            get(api::sets::get_config_blob),
        )
        .route(
            "/sets/{set_id}/blobs/{kind}",
            get(api::sets::get_set_blob).post(api::sets::put_set_blob),
        )
        .route("/sets/{set_id}/events", get(api::sets::events))
        // Courier (public, blobs are opaque)
        .route("/courier/identify", post(api::courier::identify))
        .route("/courier/config/{device_id}", get(api::courier::fetch_config))
        .route("/courier/ack", post(api::courier::ack))
        // Device (ESP32-C3)
        .route("/device/{device_id}/config", get(api::device::get_config))
        .route("/device/{device_id}/events", post(api::device::post_events))
        .with_state(state);

    let mut app = Router::new().nest("/api", api).layer(TraceLayer::new_for_http());

    // Serve the built SPA when present (EKCTL_WEB_DIST or ../web/dist).
    let dist = std::env::var("EKCTL_WEB_DIST").unwrap_or_else(|_| "web/dist".into());
    if std::path::Path::new(&dist).is_dir() {
        let index = format!("{dist}/index.html");
        app = app.fallback_service(ServeDir::new(&dist).fallback(ServeFile::new(index)));
        tracing::info!(dist, "serving frontend");
    } else {
        tracing::info!(dist, "no frontend dist found; API only");
    }

    tracing::info!(%listen, db = %db_path, "ekctl-server listening");
    let listener = tokio::net::TcpListener::bind(&listen).await.expect("bind");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("server");
}

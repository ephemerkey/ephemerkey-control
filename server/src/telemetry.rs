//! Server-side validation of device-originated proofs.
//!
//! Reuses the firmware's confirm-TOTP receipt validator from
//! `ephemerkey-core` (the same code the lock runs), so receipts reported
//! over WiFi/serial are checked by identical logic. Wiring happens when
//! telemetry ingest lands (see api/device.rs).

#[allow(unused_imports)]
pub use ephemerkey_core::receipt::{Receipt, ReceiptCheck, ReceiptMode, Validator};

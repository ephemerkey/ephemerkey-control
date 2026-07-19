-- ephemerkey-control initial schema. See DESIGN.md "Data model".
-- No user accounts by design: management authority is possession of the
-- set's owner Ed25519 key; the server stores only sealed blobs + metadata.

CREATE TABLE sets (
    set_id     BLOB PRIMARY KEY,          -- 8 bytes = SHA-256(owner_pub)[0..8]
    owner_pub  BLOB NOT NULL UNIQUE,      -- 32-byte Ed25519 public key
    name       TEXT,
    created_at INTEGER NOT NULL           -- unix seconds
);

CREATE TABLE devices (
    device_id    BLOB PRIMARY KEY,        -- from the device enrollment doc
    set_id       BLOB NOT NULL REFERENCES sets(set_id) ON DELETE CASCADE,
    sign_pub     BLOB NOT NULL,           -- device Ed25519 (telemetry, acks)
    kx_pub       BLOB NOT NULL,           -- device X25519 (config sealing)
    role         INTEGER NOT NULL DEFAULT 0, -- 1 generator, 2 lock-controller
    name         TEXT,
    fw           TEXT,
    enrolled_at  INTEGER NOT NULL,
    last_seen_at INTEGER,
    acked_seq    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX devices_set ON devices(set_id);

CREATE TABLE config_blobs (
    id         INTEGER PRIMARY KEY,
    set_id     BLOB NOT NULL REFERENCES sets(set_id) ON DELETE CASCADE,
    device_id  BLOB NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,          -- mirrors COSE header; monotonic
    blob       BLOB NOT NULL,             -- sealed COSE_Encrypt0(COSE_Sign1(..)), opaque
    created_at INTEGER NOT NULL,
    acked_at   INTEGER,
    UNIQUE (device_id, seq)
);

CREATE TABLE events (
    id          INTEGER PRIMARY KEY,
    device_id   BLOB NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,         -- device-side event counter
    rtc_ts      INTEGER,
    type        INTEGER NOT NULL,         -- unlock/lock/duress/tamper/fence/power/config-ack
    detail      BLOB,
    chain_tag   BLOB,
    received_at INTEGER NOT NULL,
    transport   TEXT NOT NULL,            -- 'serial' | 'wifi'
    UNIQUE (device_id, seq)
);
CREATE INDEX events_device_time ON events(device_id, received_at);

CREATE TABLE challenges (
    nonce      BLOB PRIMARY KEY,          -- 32 random bytes, single use
    purpose    TEXT NOT NULL,             -- 'manager' | 'courier' | 'device'
    created_at INTEGER NOT NULL
);

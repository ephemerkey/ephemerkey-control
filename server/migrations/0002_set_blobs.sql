-- Per-set opaque blob store, guarding against browser-state loss.
--   'source'  — the manager's config source-of-truth, sealed client-side to
--               an owner-derived X25519 key (server cannot read it).
--   'keywrap' — the owner keyfile wrapped under a passphrase KDF
--               (Argon2id), enabling bootstrap on a fresh browser.
CREATE TABLE set_blobs (
    set_id     BLOB NOT NULL REFERENCES sets(set_id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('source', 'keywrap')),
    blob       BLOB NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (set_id, kind)
);

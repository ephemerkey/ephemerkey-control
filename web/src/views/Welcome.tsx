// Keyless gate: the three ways into a pool. Everything else in the manager
// UI requires the owner key, so this is the only screen without it.

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { importKeyFile, parseKeyQr } from "../lib/keys";
import { getKeywrapBlob } from "../lib/api";
import { unwrapKeyfile } from "../lib/backup";
import { setIdFromPub } from "../lib/keys";
import { decodeQrImage } from "../lib/qr";
import { usePool } from "../state";

// `manage` = reached from an active session ("add / manage pools"); it lists
// existing pools and lets you switch, and adopting a pool returns you to it.
export default function Welcome({ manage = false }: { manage?: boolean }) {
  const pool = usePool();
  const navigate = useNavigate();
  const [restoreSetId, setRestoreSetId] = useState("");
  const [restorePass, setRestorePass] = useState("");
  const [createPass, setCreatePass] = useState("");
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<{ setId: string; wrapped: Uint8Array } | null>(null);
  const [qrPass, setQrPass] = useState("");
  const [forgetId, setForgetId] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; kind: "ok" | "err"; text: string } | null>(null);

  const goManager = () => void navigate("/devices");
  const done = () => {
    if (manage) goManager();
  };

  async function create() {
    if (createPass.length < 8) {
      setNote({ id: "key", kind: "err", text: "choose a passphrase of at least 8 characters" });
      return;
    }
    setBusy(true);
    try {
      await pool.createPool(createPass);
      setCreatePass("");
      // The recovery-id screen (ManagerArea) takes over; its Continue navigates.
    } catch (e) {
      setNote({
        id: "key",
        kind: "err",
        text: `couldn't create pool: ${e}. Export your keyfile from Backup & keys before relying on it.`,
      });
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    try {
      pool.adopt(importKeyFile(await file.text()));
      done();
    } catch (e) {
      setNote({ id: "key", kind: "err", text: `import failed: ${e}` });
    }
  }

  async function scanKeyQr(file: File) {
    try {
      setQr(parseKeyQr(await decodeQrImage(file)));
      setNote(null);
    } catch (e) {
      setNote({ id: "qr", kind: "err", text: `couldn't read key QR: ${e}` });
    }
  }

  function importFromQr() {
    if (!qr) return;
    try {
      pool.adoptWrapped(qr.wrapped, qrPass);
      setQr(null);
      setQrPass("");
      done();
    } catch (e) {
      setNote({ id: "qr", kind: "err", text: `import failed: ${e}` });
    }
  }

  async function restore() {
    try {
      const target = restoreSetId.trim().toLowerCase();
      const wrapped = await getKeywrapBlob(target);
      const restored = importKeyFile(unwrapKeyfile(wrapped, restorePass));
      if (setIdFromPub(restored.pub) !== target) {
        throw new Error("recovered key does not match this set_id");
      }
      setRestorePass("");
      pool.adopt(restored);
      done();
    } catch (e) {
      setNote({ id: "restore", kind: "err", text: `restore failed: ${e}` });
    }
  }

  return (
    <section className="welcome">
      <h2>{manage ? "Pools" : "ephemerkey control"}</h2>
      <p className="stephint">
        A pool of ephemerkey devices is owned by one key. There are no accounts: holding the key is
        what makes you a manager, and sharing its keyfile is how you share the pool. This browser can
        hold several pools and switch between them.
      </p>

      {manage && pool.pools.length > 0 && (
        <div className="card">
          <h3>Your pools</h3>
          <p className="hint">
            These are the pools this browser knows about. Forgetting one removes it here only — the
            pool stays on the server, recoverable with its recovery id + passphrase, keyfile, or key
            QR.
          </p>
          {pool.pools.map((p) => (
            <div key={p.setId} className="row">
              <button
                data-testid={`pool-open-${p.setId}`}
                className={p.setId === pool.setId ? "primary" : ""}
                onClick={() => {
                  pool.switchPool(p.setId);
                  void navigate("/devices");
                }}
              >
                {p.encrypted ? "🔒 " : ""}
                {p.name || p.setId}
              </button>
              {p.setId === pool.setId && <span className="hint">active</span>}
              {forgetId === p.setId ? (
                <>
                  <span className="hint">forget on this browser?</span>
                  <button
                    className="danger"
                    data-testid={`pool-forget-confirm-${p.setId}`}
                    onClick={() => {
                      pool.forgetPool(p.setId);
                      setForgetId(null);
                    }}
                  >
                    Yes, forget
                  </button>
                  <button data-testid={`pool-forget-cancel-${p.setId}`} onClick={() => setForgetId(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  className="danger"
                  data-testid={`pool-forget-${p.setId}`}
                  onClick={() => setForgetId(p.setId)}
                >
                  forget
                </button>
              )}
            </div>
          ))}
          <p className="crumbs">
            <Link to="/devices">← back</Link>
          </p>
        </div>
      )}

      <div className="card">
        <h3>{manage ? "Add another pool" : "Start a new pool"}</h3>
        <p>
          Generates a fresh owner key and registers its set. Choose a passphrase: it encrypts the
          key in this browser and stores an encrypted backup on the server, so the pool is
          recoverable with its recovery id + this passphrase. Keep it — losing it (with no exported
          keyfile) means re-enrolling every device.
        </p>
        <div className="row">
          <input
            data-testid="create-pass"
            type="password"
            placeholder="passphrase (min 8 chars)"
            value={createPass}
            onChange={(e) => setCreatePass(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
          />
          <button className="primary" data-testid="owner-generate" disabled={busy} onClick={() => void create()}>
            {busy ? "creating…" : "Create pool"}
          </button>
        </div>
        {note?.id === "key" && <p className={`inline-status ${note.kind}`}>{note.text}</p>}
      </div>

      <div className="card">
        <h3>I have a keyfile or a printed key QR</h3>
        <p>From your own backup or a co-manager. The keyfile is unencrypted; the key QR needs its passphrase.</p>
        <div className="row">
          <label className="filebtn">
            Import keyfile…
            <input
              data-testid="owner-import"
              type="file"
              accept="application/json"
              hidden
              onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])}
            />
          </label>
          <label className="filebtn">
            Import from key QR (photo)…
            <input
              data-testid="owner-import-qr"
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => e.target.files?.[0] && scanKeyQr(e.target.files[0])}
            />
          </label>
        </div>
        {qr && (
          <div className="row" data-testid="qr-passphrase">
            <span className="hint">
              key QR for <code>{qr.setId}</code> — enter its passphrase
            </span>
            <input
              data-testid="qr-pass"
              type="password"
              placeholder="passphrase"
              value={qrPass}
              onChange={(e) => setQrPass(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && importFromQr()}
            />
            <button className="primary" data-testid="qr-import-btn" onClick={importFromQr}>
              Unlock &amp; import
            </button>
          </div>
        )}
        {note?.id === "qr" && (
          <p className={`inline-status ${note.kind}`} data-testid="status-qr">
            {note.text}
          </p>
        )}
      </div>

      <div className="card">
        <h3>Restore from server backup</h3>
        <p>If a passphrase backup was stored for your set.</p>
        <div className="row">
          <input
            data-testid="restore-setid"
            placeholder="set_id (32 hex chars)"
            value={restoreSetId}
            onChange={(e) => setRestoreSetId(e.target.value)}
          />
          <input
            data-testid="restore-pass"
            type="password"
            placeholder="passphrase"
            value={restorePass}
            onChange={(e) => setRestorePass(e.target.value)}
          />
          <button data-testid="restore-btn" onClick={restore}>
            Restore key
          </button>
        </div>
        {note?.id === "restore" && (
          <p className={`inline-status ${note.kind}`} data-testid="status-restore">
            {note.text}
          </p>
        )}
      </div>

      <p className="hint">
        Just here to program a device someone else manages? Use the <a href="/push">courier page</a> —
        no key needed.
      </p>
    </section>
  );
}

// Backup & keys: keyfile custody, passphrase backup, and the sealed source
// doc (auto-saved; manual controls + raw JSON live here). Secrets stay
// behind folds — nothing sensitive renders by default.

import { useState } from "react";
import { bytesToHex } from "@noble/hashes/utils";
import { exportKeyFile } from "../lib/keys";
import { putKeywrapBlob } from "../lib/api";
import { wrapKeyfile } from "../lib/backup";
import { usePool } from "../state";

export default function Backup() {
  const pool = usePool();
  const [backupPass, setBackupPass] = useState("");
  const [lockPass, setLockPass] = useState("");
  const [noteBackup, setNoteBackup] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [noteSource, setNoteSource] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const key = pool.key!;

  function exportFile() {
    const blob = new Blob([exportKeyFile(key)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ekctl-owner-${pool.setId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function storeKeywrap() {
    try {
      const wrapped = wrapKeyfile(exportKeyFile(key), backupPass);
      await putKeywrapBlob(key, pool.setId!, wrapped);
      setBackupPass("");
      setNoteBackup({ kind: "ok", text: "passphrase backup stored on server" });
    } catch (e) {
      setNoteBackup({ kind: "err", text: `backup failed: ${e}` });
    }
  }

  async function saveNow() {
    try {
      JSON.parse(pool.source);
      await pool.saveNow();
      setNoteSource({ kind: "ok", text: "config source sealed & saved" });
    } catch (e) {
      setNoteSource({ kind: "err", text: `source save failed: ${e}` });
    }
  }

  async function recover() {
    try {
      await pool.recoverSource();
      setNoteSource({ kind: "ok", text: "config source recovered from server" });
    } catch (e) {
      setNoteSource({ kind: "err", text: `source load failed: ${e}` });
    }
  }

  return (
    <section>
      <h2>Backup &amp; keys</h2>

      <div className="card">
        <h3>Owner keyfile</h3>
        <p>
          The keyfile is the pool: back it up somewhere safe, and send it to anyone who should
          co-manage. Losing every copy means physically re-enrolling all devices.
        </p>
        <div className="row">
          <button className="primary" data-testid="export-btn" onClick={exportFile}>
            Export keyfile
          </button>
          <button data-testid="forget-btn" className="danger" onClick={() => pool.forget()}>
            Forget key on this browser
          </button>
        </div>
        <div className="row">
          <input
            data-testid="pool-name"
            placeholder="pool name (this browser)"
            defaultValue={pool.pools.find((p) => p.setId === pool.setId)?.name ?? ""}
            onBlur={(e) => pool.renameActive(e.target.value)}
          />
          <span className="hint">a label for the switcher</span>
        </div>
        <details className="advanced">
          <summary>public key</summary>
          <p>
            <strong>owner_pub</strong> <code>{bytesToHex(key.pub)}</code>
          </p>
        </details>
      </div>

      <div className="card">
        <h3>Browser lock {pool.activeEncrypted ? "🔒" : ""}</h3>
        <p>
          Encrypt this pool&apos;s key in this browser under a passphrase (Argon2id → XChaCha20).
          You&apos;ll be asked for it each time the app loads. Protects a shared or stolen machine —
          without it the key sits in local storage in the clear.
        </p>
        {pool.activeEncrypted ? (
          <div className="row">
            <span className="inline-status ok">this pool is passphrase-protected in this browser</span>
            <button data-testid="lock-now" onClick={() => pool.lockNow()}>
              🔒 Lock now
            </button>
            <button
              data-testid="lock-clear"
              className="danger"
              onClick={() => {
                pool.clearBrowserPassphrase();
                setNoteBackup({ kind: "ok", text: "browser passphrase removed" });
              }}
            >
              Remove passphrase
            </button>
          </div>
        ) : (
          <div className="row">
            <input
              data-testid="lock-pass"
              type="password"
              placeholder="passphrase (min 8 chars)"
              value={lockPass}
              onChange={(e) => setLockPass(e.target.value)}
            />
            <button
              className="primary"
              data-testid="lock-set"
              onClick={() => {
                if (lockPass.length < 8) {
                  setNoteBackup({ kind: "err", text: "passphrase must be at least 8 characters" });
                  return;
                }
                pool.setBrowserPassphrase(lockPass);
                setLockPass("");
                pool.lockNow(); // require it right away, not just next load
              }}
            >
              Set passphrase &amp; lock
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Passphrase backup</h3>
        <p>
          Stores the keyfile on the server encrypted under a passphrase (Argon2id). Recover on any
          browser with just set_id + passphrase.
        </p>
        <div className="row">
          <input
            data-testid="backup-pass"
            type="password"
            placeholder="passphrase (min 8 chars)"
            value={backupPass}
            onChange={(e) => setBackupPass(e.target.value)}
          />
          <button data-testid="backup-btn" onClick={storeKeywrap}>
            Store backup on server
          </button>
        </div>
        {noteBackup && (
          <p className={`inline-status ${noteBackup.kind}`} data-testid="status-backup">
            {noteBackup.text}
          </p>
        )}
      </div>

      <div className="card">
        <h3>Config source doc</h3>
        <p>
          Every policy you edit lives here, auto-saved to the server sealed to your owner key — the
          server cannot read it, and any browser with your key can recover it. Current state:{" "}
          <em data-testid="save-state">{pool.saveState}</em>.
        </p>
        <div className="row">
          <button data-testid="source-save" onClick={saveNow}>
            Seal &amp; save now
          </button>
          <button data-testid="source-load" onClick={recover}>
            Recover from server
          </button>
        </div>
        <details className="advanced">
          <summary data-testid="source-toggle">raw JSON (contains secrets)</summary>
          <textarea
            data-testid="source-text"
            rows={12}
            value={pool.source}
            onChange={(e) => pool.setSource(e.target.value)}
          />
        </details>
        {noteSource && (
          <p className={`inline-status ${noteSource.kind}`} data-testid="status-source">
            {noteSource.text}
          </p>
        )}
      </div>
    </section>
  );
}

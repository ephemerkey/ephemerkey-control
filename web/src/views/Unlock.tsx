// Unlock gate: the active pool's key is passphrase-wrapped in this browser
// and must be decrypted before anything can be signed.

import { useState } from "react";
import { usePool } from "../state";

export default function Unlock() {
  const pool = usePool();
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      await pool.unlock(pass);
      setPass("");
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  }

  const other = pool.pools.filter((p) => p.setId !== pool.lockedSetId);

  return (
    <section className="welcome">
      <h2>🔒 Pool locked</h2>
      <div className="card">
        <p>
          This browser holds pool <code>{pool.lockedSetId}</code> encrypted under a passphrase.
          Enter it to unlock.
        </p>
        <div className="row">
          <input
            data-testid="unlock-pass"
            type="password"
            placeholder="passphrase"
            value={pass}
            autoFocus
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button className="primary" data-testid="unlock-btn" disabled={busy} onClick={submit}>
            {busy ? "unlocking…" : "Unlock"}
          </button>
        </div>
        {err && (
          <p className="inline-status err" data-testid="unlock-err">
            {err}
          </p>
        )}
        <p className="hint">
          Forgot it? The pool is unrecoverable from this browser, but if you stored a server
          passphrase backup you can{" "}
          <a data-testid="unlock-forget" onClick={() => pool.forget()}>
            remove it here
          </a>{" "}
          and restore from backup.
        </p>
      </div>

      {other.length > 0 && (
        <div className="card">
          <h3>Other pools</h3>
          {other.map((p) => (
            <button key={p.setId} data-testid={`switch-${p.setId}`} onClick={() => pool.switchPool(p.setId)}>
              {p.encrypted ? "🔒 " : ""}
              {p.name || p.setId}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// Keyless gate: the three ways into a pool. Everything else in the manager
// UI requires the owner key, so this is the only screen without it.

import { useState } from "react";
import { generateOwnerKey, importKeyFile } from "../lib/keys";
import { getKeywrapBlob } from "../lib/api";
import { unwrapKeyfile } from "../lib/backup";
import { setIdFromPub } from "../lib/keys";
import { usePool } from "../state";

export default function Welcome() {
  const pool = usePool();
  const [restoreSetId, setRestoreSetId] = useState("");
  const [restorePass, setRestorePass] = useState("");
  const [note, setNote] = useState<{ id: string; kind: "ok" | "err"; text: string } | null>(null);

  async function importFile(file: File) {
    try {
      pool.adopt(importKeyFile(await file.text()));
    } catch (e) {
      setNote({ id: "key", kind: "err", text: `import failed: ${e}` });
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
    } catch (e) {
      setNote({ id: "restore", kind: "err", text: `restore failed: ${e}` });
    }
  }

  return (
    <section className="welcome">
      <h2>ephemerkey control</h2>
      <p className="stephint">
        A pool of ephemerkey devices is owned by one key. There are no accounts: holding the key is
        what makes you a manager, and sharing its keyfile is how you share the pool.
      </p>

      <div className="card">
        <h3>Start a new pool</h3>
        <p>Generates a fresh owner key in this browser and registers its set.</p>
        <button className="primary" data-testid="owner-generate" onClick={() => pool.adopt(generateOwnerKey())}>
          Create pool
        </button>
        {note?.id === "key" && <p className={`inline-status ${note.kind}`}>{note.text}</p>}
      </div>

      <div className="card">
        <h3>I have a keyfile</h3>
        <p>From your own backup or a co-manager.</p>
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
      </div>

      <div className="card">
        <h3>Restore from server backup</h3>
        <p>If a passphrase backup was stored for your set.</p>
        <div className="row">
          <input
            data-testid="restore-setid"
            placeholder="set_id (16 hex chars)"
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

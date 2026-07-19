// Manager console: owner-key custody, set registration, roster, recovery.
// All authority is the key; anyone you give the keyfile to is a manager.
// The backend holds the durable copies (sealed source + keywrap); the
// browser is just a cache.

import { useEffect, useState } from "react";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { seal, sign1 } from "../lib/cose";
import {
  exportKeyFile,
  forgetOwnerKey,
  generateOwnerKey,
  importKeyFile,
  loadOwnerKey,
  OwnerKey,
  saveOwnerKey,
  setIdFromPub,
} from "../lib/keys";
import {
  CTX_REGISTER,
  getKeywrapBlob,
  getSourceBlob,
  putKeywrapBlob,
  putSourceBlob,
  signedGet,
  signedPost,
} from "../lib/api";
import { deriveKx, sealToKx, unsealWithSeed, unwrapKeyfile, wrapKeyfile } from "../lib/backup";

const SOURCE_TEMPLATE = JSON.stringify(
  { format: "ekctl-source-v1", devices: {}, notes: "" },
  null,
  2,
);

export default function Console() {
  const [key, setKey] = useState<OwnerKey | null>(() => loadOwnerKey());
  const [roster, setRoster] = useState<any | null>(null);
  const [status, setStatus] = useState<string>("");
  const [backupPass, setBackupPass] = useState("");
  const [restoreSetId, setRestoreSetId] = useState("");
  const [restorePass, setRestorePass] = useState("");
  const [source, setSource] = useState(SOURCE_TEMPLATE);
  const [devForm, setDevForm] = useState({ device_id: "", sign_pub: "", kx_pub: "", role: 2, name: "" });

  const setId = key ? setIdFromPub(key.pub) : null;

  useEffect(() => {
    setRoster(null);
  }, [setId]);

  function adopt(k: OwnerKey, how: string) {
    saveOwnerKey(k);
    setKey(k);
    setStatus(`owner key ${how}`);
  }

  async function importFile(file: File) {
    try {
      adopt(importKeyFile(await file.text()), "imported");
    } catch (e) {
      setStatus(`import failed: ${e}`);
    }
  }

  function exportFile() {
    if (!key) return;
    const blob = new Blob([exportKeyFile(key)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ekctl-owner-${setId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function registerSet() {
    if (!key) return;
    try {
      const res = await signedPost(key, CTX_REGISTER, "/api/sets", {
        owner_pub: bytesToHex(key.pub),
        name: null,
      });
      setStatus(`set registered: ${res.set_id}`);
    } catch (e) {
      setStatus(`register failed: ${e}`);
    }
  }

  async function loadRoster() {
    if (!key || !setId) return;
    try {
      setRoster(await signedGet(key, `/api/sets/${setId}`));
      setStatus("roster loaded");
    } catch (e) {
      setStatus(`roster failed: ${e}`);
    }
  }

  async function addDevice() {
    if (!key || !setId) return;
    try {
      await signedPost(key, "ekctl-manager-v1", `/api/sets/${setId}/devices`, {
        ...devForm,
        device_id: devForm.device_id.trim().toLowerCase(),
        name: devForm.name || null,
      });
      const enrolled = devForm.device_id.slice(0, 16);
      setDevForm({ device_id: "", sign_pub: "", kx_pub: "", role: 2, name: "" });
      await loadRoster();
      setStatus(`device ${enrolled} enrolled`);
    } catch (e) {
      setStatus(`add device failed: ${e}`);
    }
  }

  /** Sign1(config, owner) sealed to the device kx key, uploaded at next seq.
   *  Interim payload encoding: UTF-8 JSON of the device's entry in the
   *  source doc (the emulator's native format) until the integer-keyed
   *  CBOR config document is pinned. */
  async function pushConfig(d: any) {
    if (!key || !setId) return;
    try {
      const parsed = JSON.parse(source);
      const cfg = parsed.devices?.[d.device_id];
      if (!cfg) throw new Error(`source doc has no devices["${d.device_id}"]`);
      const seq = Math.max(d.latest_seq ?? 0, d.acked_seq ?? 0) + 1;
      // kid = owner_pub: carries the owner binding for TOFU enrollment
      // (a factory-fresh device adopts the first owner it hears).
      const inner = sign1(utf8ToBytes(JSON.stringify(cfg)), key.pub, key.priv);
      const sealed = seal(inner, hexToBytes(d.kx_pub), seq, hexToBytes(d.device_id));
      await signedPost(key, "ekctl-manager-v1", `/api/sets/${setId}/configs`, {
        device_id: d.device_id,
        seq,
        blob_b64: btoa(String.fromCharCode(...sealed)),
      });
      await loadRoster();
      setStatus(`config seq ${seq} sealed & pushed for ${d.device_id.slice(0, 16)}`);
    } catch (e) {
      setStatus(`push failed: ${e}`);
    }
  }

  // --- passphrase backup (keywrap) ---------------------------------------

  async function storeKeywrap() {
    if (!key || !setId) return;
    try {
      const wrapped = wrapKeyfile(exportKeyFile(key), backupPass);
      await putKeywrapBlob(key, setId, wrapped);
      setBackupPass("");
      setStatus("passphrase backup stored on server");
    } catch (e) {
      setStatus(`backup failed: ${e}`);
    }
  }

  async function restoreFromKeywrap() {
    try {
      const target = restoreSetId.trim().toLowerCase();
      const wrapped = await getKeywrapBlob(target);
      const restored = importKeyFile(unwrapKeyfile(wrapped, restorePass));
      if (setIdFromPub(restored.pub) !== target) {
        throw new Error("recovered key does not match this set_id");
      }
      setRestorePass("");
      adopt(restored, "restored from server backup");
    } catch (e) {
      setStatus(`restore failed: ${e}`);
    }
  }

  // --- config source (sealed to the owner-derived kx key) ----------------

  async function saveSource() {
    if (!key || !setId) return;
    try {
      JSON.parse(source); // syntax check before sealing
      const sealed = sealToKx(deriveKx(key.priv).pub, utf8ToBytes(source));
      const res = await putSourceBlob(key, setId, sealed);
      setStatus(`config source sealed & saved (${res.size} bytes)`);
    } catch (e) {
      setStatus(`source save failed: ${e}`);
    }
  }

  async function loadSource() {
    if (!key || !setId) return;
    try {
      const sealed = await getSourceBlob(key, setId);
      setSource(new TextDecoder().decode(unsealWithSeed(key.priv, sealed)));
      setStatus("config source recovered from server");
    } catch (e) {
      setStatus(`source load failed: ${e}`);
    }
  }

  return (
    <section>
      <h2>Manager console</h2>

      {!key ? (
        <>
          <div className="card">
            <p>
              No owner key. The owner key <em>is</em> the pool: generate one to create a new set,
              or import a keyfile a co-manager sent you.
            </p>
            <button data-testid="owner-generate" onClick={() => adopt(generateOwnerKey(), "generated")}>
              Generate owner key
            </button>{" "}
            <label className="filebtn">
              Import keyfile
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
            <p>If a passphrase backup was stored for your set:</p>
            <input
              data-testid="restore-setid"
              placeholder="set_id (16 hex chars)"
              value={restoreSetId}
              onChange={(e) => setRestoreSetId(e.target.value)}
            />{" "}
            <input
              data-testid="restore-pass"
              type="password"
              placeholder="passphrase"
              value={restorePass}
              onChange={(e) => setRestorePass(e.target.value)}
            />{" "}
            <button data-testid="restore-btn" onClick={restoreFromKeywrap}>
              Restore key
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="card">
            <p>
              <strong>set_id</strong> <code data-testid="set-id">{setId}</code>
              <br />
              <strong>owner_pub</strong> <code>{bytesToHex(key.pub)}</code>
            </p>
            <button data-testid="register-btn" onClick={registerSet}>
              Register set on backend
            </button>{" "}
            <button data-testid="roster-btn" onClick={loadRoster}>
              Load roster
            </button>{" "}
            <button data-testid="export-btn" onClick={exportFile}>
              Export keyfile
            </button>{" "}
            <button
              data-testid="forget-btn"
              onClick={() => {
                forgetOwnerKey();
                setKey(null);
                setStatus("key forgotten (this browser only)");
              }}
            >
              Forget key
            </button>
          </div>

          <div className="card">
            <h3>Add device</h3>
            <p>Paste the enrollment doc fields from a device in provisioning mode.</p>
            <input
              data-testid="dev-id"
              placeholder="device_id (hex)"
              value={devForm.device_id}
              onChange={(e) => setDevForm({ ...devForm, device_id: e.target.value })}
            />{" "}
            <input
              data-testid="dev-sign"
              placeholder="sign_pub (hex, 64 chars)"
              value={devForm.sign_pub}
              onChange={(e) => setDevForm({ ...devForm, sign_pub: e.target.value })}
            />{" "}
            <input
              data-testid="dev-kx"
              placeholder="kx_pub (hex, 64 chars)"
              value={devForm.kx_pub}
              onChange={(e) => setDevForm({ ...devForm, kx_pub: e.target.value })}
            />{" "}
            <select
              data-testid="dev-role"
              value={devForm.role}
              onChange={(e) => setDevForm({ ...devForm, role: Number(e.target.value) })}
            >
              <option value={1}>generator</option>
              <option value={2}>lock-controller</option>
            </select>{" "}
            <input
              data-testid="dev-name"
              placeholder="name"
              value={devForm.name}
              onChange={(e) => setDevForm({ ...devForm, name: e.target.value })}
            />{" "}
            <button data-testid="dev-add" onClick={addDevice}>
              Enroll device
            </button>
          </div>

          <div className="card">
            <h3>Passphrase backup</h3>
            <p>
              Stores your keyfile on the server, encrypted under a passphrase (Argon2id). Recover
              on any browser with set_id + passphrase. Without any backup, losing this browser
              means physically re-enrolling every device.
            </p>
            <input
              data-testid="backup-pass"
              type="password"
              placeholder="passphrase (min 8 chars)"
              value={backupPass}
              onChange={(e) => setBackupPass(e.target.value)}
            />{" "}
            <button data-testid="backup-btn" onClick={storeKeywrap}>
              Store backup on server
            </button>
          </div>

          <div className="card">
            <h3>Config source</h3>
            <p>
              The pool&apos;s source-of-truth. Saved sealed to your owner key — the server cannot
              read it; any browser with your key can recover it.
            </p>
            <textarea
              data-testid="source-text"
              rows={10}
              style={{ width: "100%", fontFamily: "monospace" }}
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
            <div>
              <button data-testid="source-save" onClick={saveSource}>
                Seal &amp; save to server
              </button>{" "}
              <button data-testid="source-load" onClick={loadSource}>
                Recover from server
              </button>
            </div>
          </div>
        </>
      )}

      {roster && (
        <div className="card">
          <h3 data-testid="roster-count">Roster — {roster.devices.length} device(s)</h3>
          <table>
            <thead>
              <tr>
                <th>device</th>
                <th>role</th>
                <th>fw</th>
                <th>last seen</th>
                <th>config</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {roster.devices.map((d: any) => (
                <tr key={d.device_id}>
                  <td>
                    <code>{d.device_id.slice(0, 16)}</code> {d.name}
                  </td>
                  <td>{d.role === 1 ? "generator" : "lock"}</td>
                  <td>{d.fw ?? "—"}</td>
                  <td>{d.last_seen_at ? new Date(d.last_seen_at * 1000).toLocaleString() : "never"}</td>
                  <td>
                    acked seq {d.acked_seq}
                    {d.latest_seq > d.acked_seq ? ` (seq ${d.latest_seq} pending)` : ""}
                  </td>
                  <td>
                    <button data-testid={`push-${d.device_id}`} onClick={() => pushConfig(d)}>
                      Seal &amp; push
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {status && (
        <p className="status" data-testid="status">
          {status}
        </p>
      )}

      <p className="hint">
        Next up here: enroll devices over WebSerial (provisioning mode), the slot/policy editor, and
        Review &amp; sign → seal per device. See DESIGN.md.
      </p>
    </section>
  );
}

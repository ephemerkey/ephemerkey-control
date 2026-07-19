// Manager console: owner-key custody, set registration, roster, recovery.
// All authority is the key; anyone you give the keyfile to is a manager.
// The backend holds the durable copies (sealed source + keywrap); the
// browser is just a cache. Every form reports success/errors inline.

import { useEffect, useState } from "react";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
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
import { Enrollment, parseEnrollment, seal, sign1 } from "../lib/cose";
import { defaultDeviceConfig, DeviceConfig } from "../lib/config";
import { EkSerial, webSerialSupported } from "../lib/serial";
import ConfigEditor from "./ConfigEditor";

const SOURCE_TEMPLATE = JSON.stringify(
  { format: "ekctl-source-v1", devices: {}, notes: "" },
  null,
  2,
);

type Note = { kind: "ok" | "err"; text: string };

function Status({ id, note }: { id: string; note?: Note }) {
  if (!note) return null;
  return (
    <p className={`inline-status ${note.kind}`} data-testid={`status-${id}`}>
      {note.text}
    </p>
  );
}

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function Console() {
  const [key, setKey] = useState<OwnerKey | null>(() => loadOwnerKey());
  const [roster, setRoster] = useState<any | null>(null);
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [backupPass, setBackupPass] = useState("");
  const [restoreSetId, setRestoreSetId] = useState("");
  const [restorePass, setRestorePass] = useState("");
  const [source, setSource] = useState(SOURCE_TEMPLATE);
  const [showSource, setShowSource] = useState(false);
  const [editDevice, setEditDevice] = useState("");
  // add-device flow
  const [enrollPaste, setEnrollPaste] = useState("");
  const [parsed, setParsed] = useState<Enrollment | null>(null);
  const [devName, setDevName] = useState("");
  const [devRole, setDevRole] = useState(2);
  const [manual, setManual] = useState({ device_id: "", sign_pub: "", kx_pub: "" });

  const setId = key ? setIdFromPub(key.pub) : null;

  const ok = (id: string, text: string) => setNotes((n) => ({ ...n, [id]: { kind: "ok", text } }));
  const err = (id: string, text: string) => setNotes((n) => ({ ...n, [id]: { kind: "err", text } }));

  useEffect(() => {
    setRoster(null);
  }, [setId]);

  // The source doc (JSON string) is the single source of truth; the
  // structured editor reads/writes one device's entry inside it.
  let parsedSource: any = null;
  try {
    parsedSource = JSON.parse(source);
  } catch {
    /* editor hidden while the JSON is invalid */
  }
  const editingCfg: DeviceConfig | null =
    editDevice && parsedSource?.devices?.[editDevice] ? parsedSource.devices[editDevice] : null;

  function updateEditingCfg(cfg: DeviceConfig) {
    const p = JSON.parse(source);
    p.devices[editDevice] = cfg;
    setSource(JSON.stringify(p, null, 2));
  }

  function openEditorFor(id: string) {
    if (!parsedSource) {
      err("source", "source doc JSON is invalid — fix it first");
      return;
    }
    const p = { format: "ekctl-source-v1", devices: {}, ...parsedSource };
    if (!p.devices[id]) {
      p.devices[id] = defaultDeviceConfig(2);
      setSource(JSON.stringify(p, null, 2));
    }
    setEditDevice(id);
  }

  function adopt(k: OwnerKey, how: string) {
    saveOwnerKey(k);
    setKey(k);
    ok("key", `owner key ${how}`);
  }

  async function importFile(file: File) {
    try {
      adopt(importKeyFile(await file.text()), "imported");
    } catch (e) {
      err("key", `import failed: ${e}`);
    }
  }

  async function registerSet() {
    if (!key) return;
    try {
      const res = await signedPost(key, CTX_REGISTER, "/api/sets", {
        owner_pub: bytesToHex(key.pub),
        name: null,
      });
      ok("key", `set registered: ${res.set_id}`);
    } catch (e) {
      err("key", `register failed: ${e}`);
    }
  }

  async function loadRoster() {
    if (!key || !setId) return;
    try {
      setRoster(await signedGet(key, `/api/sets/${setId}`));
      ok("roster", "roster loaded");
    } catch (e) {
      err("roster", `roster failed: ${e}`);
    }
  }

  // --- add device ---------------------------------------------------------

  /** Enrollment needs the set to exist server-side; register it on demand
   *  so "add device" works even if the user never clicked Register. */
  async function ensureRegistered() {
    if (!key) return;
    try {
      await signedPost(key, CTX_REGISTER, "/api/sets", {
        owner_pub: bytesToHex(key.pub),
        name: null,
      });
    } catch (e) {
      if (!String(e).includes("already registered")) throw e;
    }
  }

  async function enroll(fields: { device_id: string; sign_pub: string; kx_pub: string }) {
    if (!key || !setId) return;
    try {
      await ensureRegistered();
      await signedPost(key, "ekctl-manager-v1", `/api/sets/${setId}/devices`, {
        device_id: fields.device_id.trim().toLowerCase(),
        sign_pub: fields.sign_pub.trim().toLowerCase(),
        kx_pub: fields.kx_pub.trim().toLowerCase(),
        role: devRole,
        name: devName || null,
      });
      setParsed(null);
      setEnrollPaste("");
      setDevName("");
      await loadRoster();
      ok("devices", `device ${fields.device_id.slice(0, 16)}… enrolled`);
    } catch (e) {
      err("devices", `enroll failed: ${e}`);
    }
  }

  async function readFromDevice() {
    let serial: EkSerial | null = null;
    try {
      const port = await navigator.serial.requestPort();
      serial = new EkSerial(port);
      await serial.open();
      const enrollment = parseEnrollment(await serial.identify());
      setParsed(enrollment);
      ok("devices", `read identity of ${bytesToHex(enrollment.deviceId)} (fw ${enrollment.fw})`);
    } catch (e) {
      err("devices", `device read failed: ${e}`);
    } finally {
      await serial?.close().catch(() => {});
    }
  }

  function parsePaste() {
    try {
      const text = enrollPaste.trim();
      let bytes: Uint8Array;
      if (/^[0-9a-fA-F\s]+$/.test(text)) {
        bytes = hexToBytes(text.replace(/\s/g, ""));
      } else {
        const bin = atob(text);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      }
      const enrollment = parseEnrollment(bytes);
      setParsed(enrollment);
      ok("devices", `parsed identity of ${bytesToHex(enrollment.deviceId)} (fw ${enrollment.fw})`);
    } catch (e) {
      err("devices", `could not parse enrollment doc: ${e}`);
    }
  }

  /** Enroll a fabricated device and download its ekemu-compatible state
   *  file: `ekemu serial <file>` turns it into a live emulated device. */
  async function addMockDevice() {
    if (!key || !setId) return;
    const deviceId = crypto.getRandomValues(new Uint8Array(12));
    const signPriv = ed25519.utils.randomPrivateKey();
    const kxPriv = crypto.getRandomValues(new Uint8Array(32));
    const idHex = bytesToHex(deviceId);
    try {
      await ensureRegistered();
      await signedPost(key, "ekctl-manager-v1", `/api/sets/${setId}/devices`, {
        device_id: idHex,
        sign_pub: bytesToHex(ed25519.getPublicKey(signPriv)),
        kx_pub: bytesToHex(x25519.getPublicKey(kxPriv)),
        role: devRole,
        name: devName || `mock ${idHex.slice(0, 6)}`,
      });
      download(
        `ekemu-${idHex.slice(0, 8)}.json`,
        JSON.stringify(
          {
            device_id: idHex,
            sign_priv: bytesToHex(signPriv),
            kx_priv: bytesToHex(kxPriv),
            fw: "ekemu-0.1",
            owner_pub: null,
            seq: 0,
            config_b64: null,
            event_seq: 0,
            events: [],
            wifi_ssid: null,
            wifi_psk: null,
          },
          null,
          2,
        ),
      );
      setDevName("");
      await loadRoster();
      ok(
        "devices",
        `mock device ${idHex.slice(0, 16)}… enrolled — run: ekemu serial ekemu-${idHex.slice(0, 8)}.json`,
      );
    } catch (e) {
      err("devices", `mock device failed: ${e}`);
    }
  }

  // --- passphrase backup (keywrap) ---------------------------------------

  async function storeKeywrap() {
    if (!key || !setId) return;
    try {
      const wrapped = wrapKeyfile(exportKeyFile(key), backupPass);
      await putKeywrapBlob(key, setId, wrapped);
      setBackupPass("");
      ok("backup", "passphrase backup stored on server");
    } catch (e) {
      err("backup", `backup failed: ${e}`);
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
      err("restore", `restore failed: ${e}`);
    }
  }

  // --- config source (sealed to the owner-derived kx key) ----------------

  async function saveSource() {
    if (!key || !setId) return;
    try {
      JSON.parse(source); // syntax check before sealing
      const sealed = sealToKx(deriveKx(key.priv).pub, utf8ToBytes(source));
      const res = await putSourceBlob(key, setId, sealed);
      ok("source", `config source sealed & saved (${res.size} bytes)`);
    } catch (e) {
      err("source", `source save failed: ${e}`);
    }
  }

  async function loadSource() {
    if (!key || !setId) return;
    try {
      const sealed = await getSourceBlob(key, setId);
      setSource(new TextDecoder().decode(unsealWithSeed(key.priv, sealed)));
      ok("source", "config source recovered from server");
    } catch (e) {
      err("source", `source load failed: ${e}`);
    }
  }

  async function pushConfig(d: any) {
    if (!key || !setId) return;
    try {
      const parsedDoc = JSON.parse(source);
      const cfg = parsedDoc.devices?.[d.device_id];
      if (!cfg) throw new Error(`no config for this device yet — open its policies first`);
      const seq = Math.max(d.latest_seq ?? 0, d.acked_seq ?? 0) + 1;
      // kid = owner_pub: carries the owner binding for TOFU enrollment.
      const inner = sign1(utf8ToBytes(JSON.stringify(cfg)), key.pub, key.priv);
      const sealed = seal(inner, hexToBytes(d.kx_pub), seq, hexToBytes(d.device_id));
      await signedPost(key, "ekctl-manager-v1", `/api/sets/${setId}/configs`, {
        device_id: d.device_id,
        seq,
        blob_b64: btoa(String.fromCharCode(...sealed)),
      });
      await loadRoster();
      ok("roster", `config seq ${seq} sealed & pushed for ${d.device_id.slice(0, 16)}…`);
    } catch (e) {
      err("roster", `push failed: ${e}`);
    }
  }

  // --- render -------------------------------------------------------------

  if (!key) {
    return (
      <section>
        <h2>Manager console</h2>
        <div className="card">
          <h3>Owner key</h3>
          <p>
            No owner key. The owner key <em>is</em> the pool: generate one to create a new set, or
            import a keyfile a co-manager sent you.
          </p>
          <div className="row">
            <button className="primary" data-testid="owner-generate" onClick={() => adopt(generateOwnerKey(), "generated")}>
              Generate owner key
            </button>
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
          <Status id="key" note={notes.key} />
        </div>
        <div className="card">
          <h3>Restore from server backup</h3>
          <p>If a passphrase backup was stored for your set:</p>
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
            <button data-testid="restore-btn" onClick={restoreFromKeywrap}>
              Restore key
            </button>
          </div>
          <Status id="restore" note={notes.restore} />
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2>Manager console</h2>

      <div className="card">
        <h3>Owner key</h3>
        <p>
          <strong>set_id</strong> <code data-testid="set-id">{setId}</code>
        </p>
        <div className="row">
          <button className="primary" data-testid="register-btn" onClick={registerSet}>
            Register set on backend
          </button>
          <button data-testid="roster-btn" onClick={loadRoster}>
            Load roster
          </button>
          <button
            data-testid="export-btn"
            onClick={() => download(`ekctl-owner-${setId}.json`, exportKeyFile(key))}
          >
            Export keyfile
          </button>
          <button
            data-testid="forget-btn"
            onClick={() => {
              forgetOwnerKey();
              setKey(null);
              setNotes({});
            }}
          >
            Forget key
          </button>
        </div>
        <details className="advanced">
          <summary>details</summary>
          <p>
            <strong>owner_pub</strong> <code>{bytesToHex(key.pub)}</code>
          </p>
        </details>
        <Status id="key" note={notes.key} />
      </div>

      <div className="card">
        <h3>Passphrase backup</h3>
        <p>
          Stores your keyfile on the server, encrypted under a passphrase (Argon2id). Without any
          backup, losing this browser means physically re-enrolling every device.
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
        <Status id="backup" note={notes.backup} />
      </div>

      <div className="card">
        <h3>Add device</h3>
        <p>Get the enrollment doc from a device in provisioning mode, then enroll it.</p>
        <div className="row">
          {webSerialSupported() && (
            <button className="primary" data-testid="dev-read" onClick={readFromDevice}>
              Read from device (WebSerial)
            </button>
          )}
          <input
            data-testid="dev-paste"
            placeholder="…or paste enrollment doc (hex / base64)"
            value={enrollPaste}
            onChange={(e) => setEnrollPaste(e.target.value)}
          />
          <button data-testid="dev-parse" onClick={parsePaste}>
            Parse
          </button>
        </div>
        {parsed && (
          <div className="preview" data-testid="dev-preview">
            <code>{bytesToHex(parsed.deviceId)}</code> · fw {parsed.fw} · self-signature verified ✓
          </div>
        )}
        <div className="row">
          <input
            data-testid="dev-name"
            placeholder="name (e.g. front door)"
            value={devName}
            onChange={(e) => setDevName(e.target.value)}
          />
          <select data-testid="dev-role" value={devRole} onChange={(e) => setDevRole(Number(e.target.value))}>
            <option value={1}>generator</option>
            <option value={2}>lock-controller</option>
          </select>
          <button
            className="primary"
            data-testid="dev-add"
            disabled={!parsed}
            onClick={() =>
              parsed &&
              enroll({
                device_id: bytesToHex(parsed.deviceId),
                sign_pub: bytesToHex(parsed.signPub),
                kx_pub: bytesToHex(parsed.kxPub),
              })
            }
          >
            Enroll device
          </button>
          <button data-testid="dev-mock" onClick={addMockDevice}>
            Create mock device
          </button>
        </div>
        <details className="advanced">
          <summary data-testid="dev-advanced">manual entry</summary>
          <div className="row">
            <input
              data-testid="dev-id"
              placeholder="device_id (hex)"
              value={manual.device_id}
              onChange={(e) => setManual({ ...manual, device_id: e.target.value })}
            />
            <input
              data-testid="dev-sign"
              placeholder="sign_pub (64 hex)"
              value={manual.sign_pub}
              onChange={(e) => setManual({ ...manual, sign_pub: e.target.value })}
            />
            <input
              data-testid="dev-kx"
              placeholder="kx_pub (64 hex)"
              value={manual.kx_pub}
              onChange={(e) => setManual({ ...manual, kx_pub: e.target.value })}
            />
            <button data-testid="dev-add-manual" onClick={() => enroll(manual)}>
              Enroll (manual)
            </button>
          </div>
        </details>
        <Status id="devices" note={notes.devices} />
      </div>

      {roster && (
        <div className="card">
          <h3 data-testid="roster-count">Roster — {roster.devices.length} device(s)</h3>
          <table>
            <thead>
              <tr>
                <th>device</th>
                <th>role</th>
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
                  <td>{d.last_seen_at ? new Date(d.last_seen_at * 1000).toLocaleString() : "never"}</td>
                  <td>
                    acked {d.acked_seq}
                    {d.latest_seq > d.acked_seq ? ` · seq ${d.latest_seq} pending` : ""}
                  </td>
                  <td className="row">
                    <button data-testid={`edit-${d.device_id}`} onClick={() => openEditorFor(d.device_id)}>
                      Policies
                    </button>
                    <button className="primary" data-testid={`push-${d.device_id}`} onClick={() => pushConfig(d)}>
                      Seal &amp; push
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Status id="roster" note={notes.roster} />
        </div>
      )}

      <div className="card">
        <h3>Config &amp; policies</h3>
        {editDevice ? (
          <p>
            Editing <code>{editDevice.slice(0, 16)}</code> —{" "}
            <a data-testid="edit-close" onClick={() => setEditDevice("")}>
              close editor
            </a>
          </p>
        ) : (
          <p>Pick a device in the roster (Policies) or create a config below.</p>
        )}
        <div className="row">
          <NewConfig disabled={!parsedSource} onCreate={openEditorFor} />
        </div>
        {!parsedSource && (
          <p className="inline-status err">source doc JSON is invalid — fix it to use the editor</p>
        )}
        {editingCfg && (
          <ConfigEditor
            cfg={editingCfg}
            onChange={updateEditingCfg}
            onPush={(() => {
              const d = roster?.devices?.find((x: any) => x.device_id === editDevice);
              return d ? () => pushConfig(d) : undefined;
            })()}
          />
        )}
        <details
          className="advanced"
          open={showSource}
          onToggle={(e) => setShowSource((e.target as HTMLDetailsElement).open)}
        >
          <summary data-testid="source-toggle">source doc (JSON)</summary>
          <p>
            The pool&apos;s source-of-truth. Saved sealed to your owner key — the server cannot read
            it; any browser with your key can recover it.
          </p>
          <textarea
            data-testid="source-text"
            rows={10}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
        </details>
        <div className="row">
          <button className="primary" data-testid="source-save" onClick={saveSource}>
            Seal &amp; save to server
          </button>
          <button data-testid="source-load" onClick={loadSource}>
            Recover from server
          </button>
        </div>
        <Status id="source" note={notes.source} />
      </div>
    </section>
  );
}

function NewConfig({ disabled, onCreate }: { disabled: boolean; onCreate: (id: string) => void }) {
  const [id, setId] = useState("");
  return (
    <>
      <input
        data-testid="edit-device-create-id"
        placeholder="device_id for a new config"
        value={id}
        onChange={(e) => setId(e.target.value)}
      />
      <button
        data-testid="edit-device-create"
        disabled={disabled || !id.trim()}
        onClick={() => {
          onCreate(id.trim().toLowerCase());
          setId("");
        }}
      >
        New config
      </button>
    </>
  );
}

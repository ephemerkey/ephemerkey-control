// Add-device flow: read the enrollment doc over WebSerial, paste it, or
// create a mock device for testing; manual hex entry is the advanced
// fallback. Success lands you on the device's detail page.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { signedPost } from "../lib/api";
import { Enrollment, parseEnrollment } from "../lib/cose";
import { EkSerial, webSerialSupported } from "../lib/serial";
import { usePool } from "../state";
import { defaultSoftKey } from "../lib/config";

function downloadJson(filename: string, obj: unknown) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function AddDevice() {
  const pool = usePool();
  const navigate = useNavigate();
  const [enrollPaste, setEnrollPaste] = useState("");
  const [parsed, setParsed] = useState<Enrollment | null>(null);
  const [devName, setDevName] = useState("");
  const [devRole, setDevRole] = useState(2);
  const [manual, setManual] = useState({ device_id: "", sign_pub: "", kx_pub: "" });
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const ok = (text: string) => setNote({ kind: "ok", text });
  const err = (text: string) => setNote({ kind: "err", text });

  const [authName, setAuthName] = useState("");
  function addAuthenticator() {
    const doc = JSON.parse(pool.source);
    doc.authenticators = doc.authenticators ?? {};
    const id = crypto.randomUUID();
    doc.authenticators[id] = { name: authName || "authenticator", keys: [defaultSoftKey()] };
    pool.setSource(JSON.stringify(doc, null, 2));
    setAuthName("");
    navigate(`/authenticator/${id}`);
  }

  async function enroll(fields: { device_id: string; sign_pub: string; kx_pub: string }, stay = false) {
    if (!pool.key || !pool.setId) return;
    const id = fields.device_id.trim().toLowerCase();
    await signedPost(pool.key, "ekctl-manager-v1", `/api/sets/${pool.setId}/devices`, {
      device_id: id,
      sign_pub: fields.sign_pub.trim().toLowerCase(),
      kx_pub: fields.kx_pub.trim().toLowerCase(),
      role: devRole,
      name: devName || null,
    });
    await pool.refreshRoster();
    if (!stay) navigate(`/device/${id}`);
    return id;
  }

  async function readFromDevice() {
    let serial: EkSerial | null = null;
    try {
      const port = await navigator.serial.requestPort();
      serial = new EkSerial(port);
      await serial.open();
      const enrollment = parseEnrollment(await serial.identify());
      setParsed(enrollment);
      ok(`read identity of ${bytesToHex(enrollment.deviceId)} (fw ${enrollment.fw})`);
    } catch (e) {
      err(`device read failed: ${e}`);
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
      ok(`parsed identity of ${bytesToHex(enrollment.deviceId)} (fw ${enrollment.fw})`);
    } catch (e) {
      err(`could not parse enrollment doc: ${e}`);
    }
  }

  /** Fabricate a device, enroll it, download its ekemu state file. */
  async function addMock() {
    const deviceId = crypto.getRandomValues(new Uint8Array(12));
    const signPriv = ed25519.utils.randomPrivateKey();
    const kxPriv = crypto.getRandomValues(new Uint8Array(32));
    const idHex = bytesToHex(deviceId);
    try {
      await enroll(
        {
          device_id: idHex,
          sign_pub: bytesToHex(ed25519.getPublicKey(signPriv)),
          kx_pub: bytesToHex(x25519.getPublicKey(kxPriv)),
        },
        true,
      );
      downloadJson(`ekemu-${idHex.slice(0, 8)}.json`, {
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
      });
      ok(`mock ${idHex.slice(0, 16)}… enrolled — bring it to life with: ekemu serial ekemu-${idHex.slice(0, 8)}.json`);
    } catch (e) {
      err(`mock device failed: ${e}`);
    }
  }

  return (
    <section>
      <h2>Add device</h2>
      <p className="stephint">
        A device introduces itself with a self-signed <em>enrollment doc</em> (its id and public
        keys) while in provisioning mode. Enrolling it here binds it to your pool&apos;s roster; its
        secrets never leave the device.
      </p>

      <div className="card">
        <h3>1 · Get its identity</h3>
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
        <p className="hint">
          No hardware handy?{" "}
          <button data-testid="dev-mock" onClick={addMock}>
            Create mock device
          </button>{" "}
          — enrolls a fabricated device and downloads an <code>ekemu serial</code> state file that
          makes it a live emulated device.
        </p>
      </div>

      <div className="card">
        <h3>2 · Name &amp; enroll</h3>
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
              }).catch((e) => err(`enroll failed: ${e}`))
            }
          >
            Enroll device →
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
            <button
              data-testid="dev-add-manual"
              onClick={() => enroll(manual).catch((e) => err(`enroll failed: ${e}`))}
            >
              Enroll (manual) →
            </button>
          </div>
        </details>
        {note && (
          <p className={`inline-status ${note.kind}`} data-testid="status-devices">
            {note.text}
          </p>
        )}
      </div>

      <div className="card">
        <h3>Or add a plain authenticator app</h3>
        <p>
          A non-ephemerkey generator: an ordinary TOTP app (Google Authenticator, etc.) that holds
          a pool secret and mints its codes via a scanned QR. No hardware, no enrollment, no config
          push — and no geofence or display ritual. Use it as a backup code source or for a
          keyholder without a device.
        </p>
        <div className="row">
          <input
            data-testid="auth-new-name"
            placeholder="name (e.g. Alice's phone)"
            value={authName}
            onChange={(e) => setAuthName(e.target.value)}
          />
          <button className="primary" data-testid="auth-create" onClick={addAuthenticator}>
            Create authenticator →
          </button>
        </div>
      </div>
    </section>
  );
}

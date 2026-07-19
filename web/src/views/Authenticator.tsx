// A non-ephemerkey generator: a plain authenticator app that holds pool
// secrets. No enrollment, no config push — you scan a QR into the app and
// it mints codes any lock sharing that secret accepts. Lives in the source
// doc only. Secrets are masked; QR reveal is explicit.

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Link, useParams } from "react-router-dom";
import { Authenticator as Auth, defaultSoftKey, resolveSoftKey, SoftKey } from "../lib/config";
import { otpauthUri } from "../lib/otpauth";
import { usePool } from "../state";

function QR({ uri }: { uri: string }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    QRCode.toString(uri, { type: "svg", margin: 1, width: 180 }).then(setSvg).catch(() => setSvg(""));
  }, [uri]);
  return <div className="qr" data-testid="qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function SoftKeyCard({
  k,
  idx,
  devices,
  onChange,
  onRemove,
}: {
  k: SoftKey;
  idx: number;
  devices: Record<string, any>;
  onChange: (k: SoftKey) => void;
  onRemove: () => void;
}) {
  const [show, setShow] = useState(false);
  const resolved = resolveSoftKey(k, devices);
  const deviceIds = Object.keys(devices);

  return (
    <fieldset className="editor-row" data-testid={`soft-${idx}`}>
      <legend>{k.label || `key ${idx}`}</legend>
      <div className="row">
        <label className="field">
          label
          <input
            data-testid={`soft-${idx}-label`}
            value={k.label}
            onChange={(e) => onChange({ ...k, label: e.target.value })}
          />
        </label>
        <label className="field">
          source
          <select
            data-testid={`soft-${idx}-link`}
            value={k.link ? `${k.link.device}:${k.link.key}` : ""}
            onChange={(e) => {
              if (e.target.value === "") {
                onChange({ ...defaultSoftKey(), label: k.label });
              } else {
                const [device, key] = e.target.value.split(":");
                onChange({ label: k.label, digits: k.digits, link: { device, key: Number(key) } });
              }
            }}
          >
            <option value="">standalone secret</option>
            {deviceIds.flatMap((id) =>
              (devices[id].keys ?? []).map((_: any, ki: number) => (
                <option key={`${id}:${ki}`} value={`${id}:${ki}`}>
                  {(devices[id].name as string) || id.slice(0, 8)} · key {ki}
                </option>
              )),
            )}
          </select>
          <span className="fieldhelp">
            {k.link
              ? "mirrors a lock/generator key — its codes are accepted there"
              : "a standalone secret you'll also place on a lock to link it"}
          </span>
        </label>
      </div>

      {resolved ? (
        <>
          {show ? (
            <QR uri={otpauthUri({ label: k.label, secret: resolved.secret, digits: resolved.digits, period: k.period })} />
          ) : (
            <button data-testid={`soft-${idx}-show`} onClick={() => setShow(true)}>
              Show QR &amp; secret
            </button>
          )}
          {show && (
            <details className="advanced" open>
              <summary>otpauth URI (contains the secret)</summary>
              <code data-testid={`soft-${idx}-uri`}>
                {otpauthUri({ label: k.label, secret: resolved.secret, digits: resolved.digits, period: k.period })}
              </code>
            </details>
          )}
        </>
      ) : (
        <p className="inline-status err">linked device key no longer exists — relink or make standalone</p>
      )}
      <button className="danger" data-testid={`soft-${idx}-remove`} onClick={onRemove}>
        remove key
      </button>
    </fieldset>
  );
}

export default function Authenticator() {
  const { id = "" } = useParams();
  const pool = usePool();

  let doc: any = null;
  try {
    doc = JSON.parse(pool.source);
  } catch {
    /* handled below */
  }
  const auth: Auth | null = doc?.authenticators?.[id] ?? null;
  const devices: Record<string, any> = doc?.devices ?? {};

  function update(next: Auth) {
    const d = JSON.parse(pool.source);
    d.authenticators = d.authenticators ?? {};
    d.authenticators[id] = next;
    pool.setSource(JSON.stringify(d, null, 2));
  }

  if (!doc) {
    return (
      <section>
        <p className="inline-status err">source doc JSON is invalid — fix it under Backup &amp; keys</p>
      </section>
    );
  }
  if (!auth) {
    return (
      <section>
        <p className="crumbs">
          <Link to="/devices">← devices</Link>
        </p>
        <p>Authenticator not found.</p>
      </section>
    );
  }

  return (
    <section>
      <p className="crumbs">
        <Link to="/devices">← devices</Link>
      </p>
      <h2 data-testid="auth-header">📱 {auth.name}</h2>
      <p className="stephint">
        A plain authenticator app — no ephemerkey hardware. It holds pool secrets and mints their
        codes with a standard RFC 6238 algorithm, so a lock that shares a secret will accept them —
        but <strong>without any geofence, display ritual, or receipt chain</strong>. Scan a QR into
        the app. Every export widens who can mint these codes; treat it like handing out a key.
      </p>

      <label className="field">
        name
        <input data-testid="auth-name" value={auth.name} onChange={(e) => update({ ...auth, name: e.target.value })} />
      </label>

      {auth.keys.map((k, i) => (
        <SoftKeyCard
          key={i}
          k={k}
          idx={i}
          devices={devices}
          onChange={(nk) => update({ ...auth, keys: auth.keys.map((x, j) => (j === i ? nk : x)) })}
          onRemove={() => update({ ...auth, keys: auth.keys.filter((_, j) => j !== i) })}
        />
      ))}
      <button data-testid="auth-add-key" onClick={() => update({ ...auth, keys: [...auth.keys, defaultSoftKey()] })}>
        + add key
      </button>
    </section>
  );
}

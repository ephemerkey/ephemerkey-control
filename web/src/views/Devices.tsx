// Device list — the landing page. The roster loads itself; each device
// links to its detail page (status + policy workflow).

import { useState } from "react";
import { Link } from "react-router-dom";
import { usePool } from "../state";

export default function Devices() {
  const pool = usePool();
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function push(d: any) {
    try {
      setNote({ kind: "ok", text: `${await pool.pushDevice(d)} for ${d.device_id.slice(0, 16)}…` });
    } catch (e) {
      setNote({ kind: "err", text: `push failed: ${e}` });
    }
  }

  if (pool.rosterError) {
    return (
      <section>
        <h2>Devices</h2>
        <p className="inline-status err" data-testid="status-roster">
          {pool.rosterError}
        </p>
      </section>
    );
  }
  if (!pool.roster) {
    return (
      <section>
        <h2>Devices</h2>
        <p className="hint">loading roster…</p>
      </section>
    );
  }

  const devices = pool.roster.devices as any[];
  let authenticators: Record<string, any> = {};
  try {
    authenticators = JSON.parse(pool.source).authenticators ?? {};
  } catch {
    /* source JSON broken elsewhere — surfaced on Backup page */
  }
  const authIds = Object.keys(authenticators);
  // The role you configure in the wizard (source doc) is the real one — the
  // roster column only holds the enrollment-time hint. Prefer the config.
  let cfgDevices: Record<string, any> = {};
  try {
    cfgDevices = JSON.parse(pool.source).devices ?? {};
  } catch {
    /* invalid source surfaced elsewhere */
  }
  const roleOf = (d: any) => (cfgDevices[d.device_id]?.role ?? d.role) === 1 ? "generator" : "lock";

  async function publish() {
    setNote({ kind: "ok", text: "publishing…" });
    try {
      const r = await pool.publishAll();
      const parts = [`${r.published} device(s) sealed & delivered to the server`];
      if (r.skipped) parts.push(`${r.skipped} without a config skipped`);
      if (r.errors.length) parts.push(`${r.errors.length} failed`);
      setNote({ kind: r.errors.length ? "err" : "ok", text: parts.join("; ") });
    } catch (e) {
      setNote({ kind: "err", text: `publish failed: ${e}` });
    }
  }

  return (
    <section>
      <div className="row">
        <h2 data-testid="roster-count">Devices — {devices.length} device(s)</h2>
        <Link className="btnlink primary" data-testid="nav-add" to="/devices/add">
          + Add device
        </Link>
        {devices.length > 0 && (
          <button className="primary" data-testid="publish-btn" onClick={publish}>
            Publish all
          </button>
        )}
      </div>
      <p className="hint">
        Publish seals every device&apos;s current config, uploads the sealed artifacts to the server
        (couriers and ESP32 devices fetch them from there), and backs up your sealed source doc.
      </p>
      {devices.length === 0 ? (
        <div className="card" data-testid="roster-empty">
          <p>
            No devices yet. Put an ephemerkey into provisioning mode and{" "}
            <Link to="/devices/add">add your first device</Link> — or create a mock device to try
            the whole flow without hardware.
          </p>
        </div>
      ) : (
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
            {devices.map((d) => (
              <tr key={d.device_id}>
                <td>
                  <Link data-testid={`device-${d.device_id}`} to={`/device/${d.device_id}`}>
                    {d.name || d.device_id.slice(0, 16)}
                  </Link>
                  <div className="hint">
                    <code>{d.device_id.slice(0, 16)}</code>
                  </div>
                </td>
                <td>{roleOf(d)}</td>
                <td>{d.last_seen_at ? new Date(d.last_seen_at * 1000).toLocaleString() : "never"}</td>
                <td>
                  acked {d.acked_seq}
                  {d.latest_seq > d.acked_seq ? (
                    <span className="badge">seq {d.latest_seq} pending</span>
                  ) : null}
                </td>
                <td className="row">
                  <button className="primary" data-testid={`push-${d.device_id}`} onClick={() => push(d)}>
                    Seal &amp; push
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {authIds.length > 0 && (
        <>
          <h3 data-testid="auth-count">Authenticator apps — {authIds.length}</h3>
          <p className="hint">
            Non-ephemerkey generators: plain TOTP apps holding pool secrets. No geofence or ritual —
            they mint codes any lock sharing the secret accepts.
          </p>
          <table>
            <tbody>
              {authIds.map((id) => (
                <tr key={id}>
                  <td>
                    <Link data-testid={`auth-${id}`} to={`/authenticator/${id}`}>
                      📱 {authenticators[id].name || id.slice(0, 8)}
                    </Link>
                  </td>
                  <td>
                    {(authenticators[id].keys ?? []).length} key(s) · authenticator app
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {note && (
        <p className={`inline-status ${note.kind}`} data-testid="status-roster">
          {note.text}
        </p>
      )}
    </section>
  );
}

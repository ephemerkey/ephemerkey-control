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
  return (
    <section>
      <h2 data-testid="roster-count">Devices — {devices.length} device(s)</h2>
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
                <td>{d.role === 1 ? "generator" : "lock"}</td>
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
      {note && (
        <p className={`inline-status ${note.kind}`} data-testid="status-roster">
          {note.text}
        </p>
      )}
    </section>
  );
}

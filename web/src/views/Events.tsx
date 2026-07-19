// Pool event log — device-signed lock/unlock/tamper/config-ack events the
// server verified and stored, captured either over WiFi or on a courier
// sync. Read-only; the server checks each batch's signature before it lands.

import { useEffect, useState } from "react";
import { listEvents } from "../lib/api";
import { usePool } from "../state";

const EVENT_TYPES: Record<number, string> = {
  1: "unlock",
  2: "lock",
  3: "duress unlock",
  4: "tamper",
  5: "fence enter",
  6: "fence exit",
  7: "power",
  8: "config ack",
};

export default function Events() {
  const pool = usePool();
  const [events, setEvents] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    if (!pool.key || !pool.setId) return;
    try {
      const r = await listEvents(pool.key, pool.setId);
      setEvents(r.events);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool.setId]);

  const nameFor = (id: string) =>
    pool.roster?.devices?.find((d: any) => d.device_id === id)?.name || id.slice(0, 16);

  return (
    <section>
      <div className="row">
        <h2>Events</h2>
        <button data-testid="events-refresh" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <p className="hint">
        Device-signed events captured over WiFi or when a courier syncs online. Each batch&apos;s
        signature is verified by the server before it&apos;s stored.
      </p>
      {err && (
        <p className="inline-status err" data-testid="events-error">
          {err}
        </p>
      )}
      {events && events.length === 0 && (
        <div className="card" data-testid="events-empty">
          <p>No events yet. They arrive when a device reports in — over WiFi, or on the next courier sync.</p>
        </div>
      )}
      {events && events.length > 0 && (
        <table data-testid="events-table">
          <thead>
            <tr>
              <th>device</th>
              <th>event</th>
              <th>device time</th>
              <th>received</th>
              <th>via</th>
              <th>seq</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e, i) => (
              <tr key={i}>
                <td>{nameFor(e.device_id)}</td>
                <td>{EVENT_TYPES[e.type] ?? `type ${e.type}`}</td>
                <td>{e.rtc_ts ? new Date(e.rtc_ts * 1000).toLocaleString() : "—"}</td>
                <td>{new Date(e.received_at * 1000).toLocaleString()}</td>
                <td>{e.transport}</td>
                <td>{e.seq}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

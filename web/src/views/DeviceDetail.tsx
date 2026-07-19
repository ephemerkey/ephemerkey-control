// One device: status header + the policy workflow. Opening the page
// creates the device's config entry in the source doc if it has none, so
// there's nothing to do "in the right order" — just walk the steps.

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { defaultDeviceConfig, DeviceConfig } from "../lib/config";
import { usePool } from "../state";
import ConfigEditor from "./ConfigEditor";

export default function DeviceDetail() {
  const { id = "" } = useParams();
  const pool = usePool();
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  let parsedSource: any = null;
  try {
    parsedSource = JSON.parse(pool.source);
  } catch {
    /* handled below */
  }

  // Ensure this device has a config entry to edit — re-checked on every
  // source change so an async recover-from-server can't drop it.
  useEffect(() => {
    if (!parsedSource || parsedSource.devices?.[id]) return;
    const doc = { format: "ekctl-source-v1", devices: {}, ...parsedSource };
    const rosterDev = pool.roster?.devices?.find((d: any) => d.device_id === id);
    doc.devices[id] = defaultDeviceConfig(rosterDev?.role === 1 ? 1 : 2);
    pool.setSource(JSON.stringify(doc, null, 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, pool.source]);

  const rosterDev = pool.roster?.devices?.find((d: any) => d.device_id === id);
  const cfg: DeviceConfig | null = parsedSource?.devices?.[id] ?? null;

  function updateCfg(next: DeviceConfig) {
    const doc = JSON.parse(pool.source);
    doc.devices[id] = next;
    pool.setSource(JSON.stringify(doc, null, 2));
  }

  async function push() {
    if (!rosterDev) return;
    try {
      setNote({ kind: "ok", text: await pool.pushDevice(rosterDev) });
    } catch (e) {
      setNote({ kind: "err", text: `push failed: ${e}` });
    }
  }

  return (
    <section>
      <p className="crumbs">
        <Link to="/devices">← devices</Link>
      </p>
      <h2 data-testid="device-header">
        {rosterDev?.name || "device"} <code>{id.slice(0, 16)}</code>
      </h2>
      {rosterDev ? (
        <p className="hint">
          {rosterDev.role === 1 ? "generator" : "lock-controller"} · fw {rosterDev.fw ?? "?"} · last
          seen {rosterDev.last_seen_at ? new Date(rosterDev.last_seen_at * 1000).toLocaleString() : "never"} ·
          acked seq {rosterDev.acked_seq}
          {rosterDev.latest_seq > rosterDev.acked_seq ? ` (seq ${rosterDev.latest_seq} pending delivery)` : ""}
        </p>
      ) : (
        <p className="hint">not on the roster (yet) — the config below is saved but can&apos;t be pushed</p>
      )}
      {!parsedSource && (
        <p className="inline-status err">
          source doc JSON is invalid — fix it under Backup &amp; keys before editing policies
        </p>
      )}
      {cfg && (
        <ConfigEditor cfg={cfg} onChange={updateCfg} onPush={rosterDev ? push : undefined} />
      )}
      {note && (
        <p className={`inline-status ${note.kind}`} data-testid="status-push">
          {note.text}
        </p>
      )}
    </section>
  );
}

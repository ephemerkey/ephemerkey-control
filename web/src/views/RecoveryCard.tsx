// Shown once, right after a pool is created: the set_id is the recovery
// identifier — with the passphrase it restores the pool from the server
// backup. Prompt the manager to store or print it before moving on.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { exportKeyFile } from "../lib/keys";
import { usePool } from "../state";

export default function RecoveryCard() {
  const pool = usePool();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const setId = pool.justCreated!;

  function copy() {
    void navigator.clipboard?.writeText(setId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function exportKeyfile() {
    if (!pool.key) return;
    const blob = new Blob([exportKeyFile(pool.key)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ekctl-owner-${setId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function done() {
    pool.dismissCreated();
    void navigate("/devices");
  }

  return (
    <section className="welcome">
      <h2>✅ Pool created</h2>
      <div className="card print-card" data-testid="recovery-card">
        <h3>Save your recovery id</h3>
        <p>
          This is your pool&apos;s <strong>recovery id</strong>. With your passphrase it restores the
          pool on any browser (Restore from server backup). Store or print it now and keep it apart
          from the passphrase — losing both, with no exported keyfile, means re-enrolling every
          device.
        </p>
        <p className="recovery-id" data-testid="recovery-setid">
          {setId}
        </p>
        <p className="hint print-hide">passphrase: kept only by you — never printed or stored here.</p>
        <div className="row print-hide">
          <button data-testid="recovery-copy" onClick={copy}>
            {copied ? "copied ✓" : "Copy id"}
          </button>
          <button data-testid="recovery-print" onClick={() => window.print()}>
            Print
          </button>
          <button data-testid="recovery-export" onClick={exportKeyfile}>
            Export keyfile (stronger backup)
          </button>
        </div>
      </div>
      <div className="row print-hide">
        <button className="primary" data-testid="recovery-continue" onClick={done}>
          I&apos;ve saved it — continue
        </button>
      </div>
    </section>
  );
}

// Shown once, right after a pool is created: the set_id is the recovery
// identifier — with the passphrase it restores the pool from the server
// backup. Prompt the manager to store or print it before moving on.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import QRCode from "qrcode";
import { exportKeyFile, keyQrPayload, wrappedFor } from "../lib/keys";
import { usePool } from "../state";

function KeyQR({ payload }: { payload: string }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    QRCode.toString(payload, { type: "svg", margin: 1, width: 200, errorCorrectionLevel: "M" })
      .then(setSvg)
      .catch(() => setSvg(""));
  }, [payload]);
  return <div className="qr" data-testid="recovery-qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export default function RecoveryCard() {
  const pool = usePool();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const setId = pool.justCreated!;
  const wrapped = wrappedFor(setId);
  const qrPayload = wrapped ? keyQrPayload(setId, wrapped) : null;

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

        {qrPayload && (
          <div className="keyqr-block">
            <h4>Encrypted key backup</h4>
            <KeyQR payload={qrPayload} />
            <p className="hint">
              This QR is your key, still <strong>sealed under your passphrase</strong> — scanning it
              (Import from key QR) restores the pool without the server, but only with the
              passphrase. Safe to print; useless to anyone without it.
            </p>
            <details className="advanced print-hide">
              <summary data-testid="recovery-qr-toggle">backup text (if you can&apos;t scan)</summary>
              <code data-testid="recovery-qr-payload">{qrPayload}</code>
            </details>
          </div>
        )}

        <p className="hint print-hide">
          Your passphrase is never printed or stored here — keep it only in your head or a separate
          manager.
        </p>
        <div className="row print-hide">
          <button data-testid="recovery-copy" onClick={copy}>
            {copied ? "copied ✓" : "Copy id"}
          </button>
          <button data-testid="recovery-print" onClick={() => window.print()}>
            Print
          </button>
          <button data-testid="recovery-export" onClick={exportKeyfile}>
            Export keyfile (unencrypted)
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

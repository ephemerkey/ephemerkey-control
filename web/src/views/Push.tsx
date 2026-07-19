// Public courier page: connect a device over WebSerial and push its pending
// sealed config. Deliberately blind — this page never sees config contents,
// only "device X is now at seq N".

import { useState } from "react";
import { bytesToHex } from "@noble/hashes/utils";
import { courierAck, courierChallenge, courierFetchConfig, courierIdentify } from "../lib/api";
import { parseEnrollment } from "../lib/cose";
import { EkSerial, FrameType, webSerialSupported } from "../lib/serial";

type Step = { label: string; state: "todo" | "run" | "ok" | "fail"; note?: string };

const INITIAL: Step[] = [
  { label: "Connect device (WebSerial)", state: "todo" },
  { label: "Read device identity", state: "todo" },
  { label: "Check for pending update", state: "todo" },
  { label: "Fetch sealed config", state: "todo" },
  { label: "Push to device & verify ack", state: "todo" },
];

export default function Push() {
  const [steps, setSteps] = useState<Step[]>(INITIAL);
  const [busy, setBusy] = useState(false);

  function mark(i: number, state: Step["state"], note?: string) {
    setSteps((s) => s.map((st, j) => (j === i ? { ...st, state, note } : st)));
  }

  async function run() {
    setSteps(INITIAL);
    setBusy(true);
    let serial: EkSerial | null = null;
    try {
      mark(0, "run");
      const port = await navigator.serial.requestPort();
      serial = new EkSerial(port);
      await serial.open();
      mark(0, "ok");

      mark(1, "run");
      const identityDoc = await serial.identify();
      const enrollment = parseEnrollment(identityDoc);
      const deviceIdHex = bytesToHex(enrollment.deviceId);
      mark(1, "ok", `device ${deviceIdHex}`);

      mark(2, "run");
      // Prove physical possession: the device signs a server challenge.
      const nonce = await courierChallenge();
      const sigFrame = await serial.request(FrameType.Challenge, nonce);
      if (sigFrame.type !== FrameType.ChallengeSig) {
        throw new Error(`unexpected frame ${sigFrame.type}`);
      }
      const info = await courierIdentify(deviceIdHex, nonce, sigFrame.payload, identityDoc);
      if (!info.pending) {
        mark(2, "ok", `already current (acked seq ${info.acked_seq})`);
        setBusy(false);
        return;
      }
      mark(2, "ok", `seq ${info.seq} pending`);

      mark(3, "run");
      const { seq, blob } = await courierFetchConfig(deviceIdHex);
      mark(3, "ok", `${blob.length} sealed bytes`);

      mark(4, "run");
      const ack = await serial.pushConfig(seq, blob);
      await courierAck(deviceIdHex, seq, ack);
      mark(4, "ok", `device now at seq ${seq} (ack verified by server)`);
    } catch (e) {
      const i = steps.findIndex((s) => s.state === "run");
      mark(i >= 0 ? i : 0, "fail", String(e));
    } finally {
      await serial?.close().catch(() => {});
      setBusy(false);
    }
  }

  if (!webSerialSupported()) {
    return (
      <section>
        <h2>Push update</h2>
        <p>This browser has no WebSerial support — use a Chromium-based browser.</p>
      </section>
    );
  }

  return (
    <section>
      <h2>Push update</h2>
      <p>
        Plug in an ephemerkey and hold its provisioning button while connecting. You&apos;ll ferry an
        encrypted update you can&apos;t read; the device itself verifies it came from its owner.
      </p>
      <button onClick={run} disabled={busy}>
        {busy ? "Working…" : "Connect & update"}
      </button>
      <ol className="steps">
        {steps.map((s) => (
          <li key={s.label} data-state={s.state}>
            {s.label}
            {s.note ? <span className="note"> — {s.note}</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

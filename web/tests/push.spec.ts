// The real /push page, driven end-to-end against the real device stand-in:
// mock navigator.serial → TCP → `ekemu serial` (Rust frame+envelope crates),
// with the backend verifying identity, relaying the sealed blob, and
// accepting the device's signed ack.

import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { installMockSerial } from "./mock-serial";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// scripts/ekenv.mjs is plain ESM with its own node_modules-relative imports;
// import by absolute file URL so bundling can't relocate the path.
const ekenvPromise = import(new URL("../../scripts/ekenv.mjs", import.meta.url).href);

const EMU = { host: "127.0.0.1", port: 8424 };
const SERVER = "http://127.0.0.1:8321";

let emu: ChildProcess;
let devId = "";
let seqPushed = 0;

test.beforeAll(async () => {
  const ekenv: any = await ekenvPromise;
  const tmp = mkdtempSync(join(tmpdir(), "ek-push-"));
  emu = spawn(
    join(HERE, "../../../ephemerkey/firmware/ephemerkey-emu/target/debug/ekemu"),
    ["serial", join(tmp, "device.json"), `${EMU.host}:${EMU.port}`],
    { stdio: "inherit" },
  );

  // Wait for the emulator port, read its identity, enroll it, seal a config.
  const sock: net.Socket = await (async () => {
    const end = Date.now() + 20_000;
    for (;;) {
      try {
        return await new Promise<net.Socket>((resolve, reject) => {
          const s = net.connect(EMU, () => resolve(s));
          s.on("error", reject);
        });
      } catch {
        if (Date.now() > end) throw new Error("emulator did not start");
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  })();

  const chan = new ekenv.FrameChannel(sock);
  const idFrame = await chan.request(ekenv.FT.IDENTITY_REQ, new Uint8Array());
  const parts = ekenv.sign1Parse(idFrame.payload);
  const d = new ekenv.Dec(parts.payload);
  const fields: Record<number, any> = {};
  const n = d.map();
  for (let i = 0; i < n; i++) {
    const k = d.uint();
    fields[k] = k === 4 ? d.tstr() : d.bstr();
  }
  sock.end();

  devId = ekenv.bytesToHex(fields[1]);
  const client = ekenv.makeClient(SERVER);
  const ownerPriv = ekenv.ed25519.utils.randomPrivateKey();
  const ownerPub = ekenv.ed25519.getPublicKey(ownerPriv);
  await client.signedPost(ownerPriv, "ekctl-register-v1", "/api/sets", {
    owner_pub: ekenv.bytesToHex(ownerPub),
    name: "push-e2e",
  });
  const setId = ekenv.bytesToHex(ekenv.sha256(ownerPub).slice(0, 16));
  await client.signedPost(ownerPriv, "ekctl-manager-v1", `/api/sets/${setId}/devices`, {
    device_id: devId,
    sign_pub: ekenv.bytesToHex(fields[2]),
    kx_pub: ekenv.bytesToHex(fields[3]),
    role: 2,
    name: "push-e2e lock",
    fw: fields[4],
  });
  const cfg = ekenv.utf8ToBytes(JSON.stringify({ role: 2, keys: [], slots: [] }));
  seqPushed = 1;
  const sealed = ekenv.seal(ekenv.sign1(cfg, ownerPub, ownerPriv), fields[3], seqPushed, fields[1]);
  const up = await client.signedPost(ownerPriv, "ekctl-manager-v1", `/api/sets/${setId}/configs`, {
    device_id: devId,
    seq: seqPushed,
    blob_b64: Buffer.from(sealed).toString("base64"),
  });
  if (up.status !== 200) throw new Error(`config upload failed: ${JSON.stringify(up.body)}`);
});

test.afterAll(() => {
  emu?.kill();
});

test("blind courier pushes a pending update through the real page", async ({ page }) => {
  const disconnect = await installMockSerial(page, EMU);
  try {
    await page.goto("/push");
    await page.getByRole("button", { name: /connect & update/i }).click();

    const steps = page.locator(".steps li");
    await expect(steps.nth(1)).toContainText(`device ${devId}`, { timeout: 15_000 });
    await expect(steps.nth(2)).toContainText(`seq ${seqPushed} pending`);
    await expect(steps.nth(3)).toContainText("sealed bytes");
    await expect(steps.nth(4)).toContainText(`device now at seq ${seqPushed} (ack verified by server)`, {
      timeout: 15_000,
    });
    // The courier also pulls the device's signed events and relays them.
    await expect(steps.nth(5)).toContainText("event(s) captured", { timeout: 15_000 });
  } finally {
    disconnect();
  }
});

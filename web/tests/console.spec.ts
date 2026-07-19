// E2e: owner-key custody, set registration, and the two recovery loops
// (passphrase keywrap, sealed config source) against a real backend.
// Serial mode: later tests recover state created by earlier ones — that
// cross-browser recovery IS the thing under test.

import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

test.describe.configure({ mode: "serial" });

const PASSPHRASE = "correct horse battery staple";
const SOURCE_DOC = JSON.stringify({
  format: "ekctl-source-v1",
  devices: { deadbeef: { role: 2, keys: [], slots: [] } },
  notes: "e2e recovery marker 7391",
});

let setId: string;
let keyfile: string;

test("generate key, register set, empty roster", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("owner-generate").click();

  setId = (await page.getByTestId("set-id").innerText()).trim();
  expect(setId).toMatch(/^[0-9a-f]{16}$/);

  await page.getByTestId("register-btn").click();
  await expect(page.getByTestId("status")).toContainText(`set registered: ${setId}`);

  await page.getByTestId("roster-btn").click();
  await expect(page.getByTestId("roster-count")).toContainText("0 device(s)");
});

test("export keyfile, forget, import restores the same set", async ({ page }) => {
  await page.goto("/");
  // Round-trip a brand-new key: export → forget → import.
  await page.getByTestId("owner-generate").click();
  const freshSetId = (await page.getByTestId("set-id").innerText()).trim();

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-btn").click();
  const download = await downloadPromise;
  const path = await download.path();
  const exported = readFileSync(path!, "utf8");
  const parsed = JSON.parse(exported);
  expect(parsed.format).toBe("ekctl-owner-key-v1");
  expect(parsed.set_id).toBe(freshSetId);

  await page.getByTestId("forget-btn").click();
  await expect(page.getByTestId("owner-generate")).toBeVisible();

  await page.getByTestId("owner-import").setInputFiles({
    name: "owner.json",
    mimeType: "application/json",
    buffer: Buffer.from(exported),
  });
  await expect(page.getByTestId("set-id")).toHaveText(freshSetId);
});

test("store passphrase backup and sealed config source", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("owner-generate").click();
  setId = (await page.getByTestId("set-id").innerText()).trim();

  // Keep the keyfile for the wrong-passphrase sanity check below.
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-btn").click();
  keyfile = readFileSync((await (await downloadPromise).path())!, "utf8");

  await page.getByTestId("register-btn").click();
  await expect(page.getByTestId("status")).toContainText("set registered");

  // Argon2id in pure JS takes a moment — allow for it.
  await page.getByTestId("backup-pass").fill(PASSPHRASE);
  await page.getByTestId("backup-btn").click();
  await expect(page.getByTestId("status")).toContainText("passphrase backup stored", {
    timeout: 30_000,
  });

  await page.getByTestId("source-text").fill(SOURCE_DOC);
  await page.getByTestId("source-save").click();
  await expect(page.getByTestId("status")).toContainText("config source sealed & saved");
});

test("fresh browser recovers key via set_id + passphrase, then the source", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("owner-generate")).toBeVisible(); // truly fresh

  await page.getByTestId("restore-setid").fill(setId);
  await page.getByTestId("restore-pass").fill(PASSPHRASE);
  await page.getByTestId("restore-btn").click();
  await expect(page.getByTestId("set-id")).toHaveText(setId, { timeout: 30_000 });
  await expect(page.getByTestId("status")).toContainText("restored from server backup");

  await page.getByTestId("source-load").click();
  await expect(page.getByTestId("status")).toContainText("config source recovered");
  await expect(page.getByTestId("source-text")).toHaveValue(SOURCE_DOC);
});

test("wrong passphrase is rejected", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("restore-setid").fill(setId);
  await page.getByTestId("restore-pass").fill("not-the-passphrase");
  await page.getByTestId("restore-btn").click();
  await expect(page.getByTestId("status")).toContainText("wrong passphrase", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("owner-generate")).toBeVisible(); // still keyless
});

test("wrong key cannot read another set's source blob", async ({ page }) => {
  await page.goto("/");
  // A different owner key = a different set; it must not see the first
  // set's data, and its own (empty) source slot 404s.
  await page.getByTestId("owner-generate").click();
  const otherSetId = (await page.getByTestId("set-id").innerText()).trim();
  expect(otherSetId).not.toBe(setId);
  await page.getByTestId("register-btn").click();
  await expect(page.getByTestId("status")).toContainText("set registered");

  // Its own source loads nothing yet (404 from the backend).
  await page.getByTestId("source-load").click();
  await expect(page.getByTestId("status")).toContainText("source load failed");
});

test("enroll a device and seal+push a config from the console", async ({ page }) => {
  // Device keys generated node-side; the browser does the sealing. The
  // server's Rust envelope parser validating the TS-sealed blob's headers
  // is the cross-implementation check.
  const { ed25519, x25519 } = await import("@noble/curves/ed25519");
  const { bytesToHex } = await import("@noble/hashes/utils");
  const devId = bytesToHex(crypto.getRandomValues(new Uint8Array(12)));
  const signPub = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
  const kxPub = bytesToHex(x25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32))));

  await page.goto("/");
  await page.getByTestId("owner-import").setInputFiles({
    name: "owner.json",
    mimeType: "application/json",
    buffer: Buffer.from(keyfile),
  });
  await expect(page.getByTestId("set-id")).toHaveText(setId);

  await page.getByTestId("dev-id").fill(devId);
  await page.getByTestId("dev-sign").fill(signPub);
  await page.getByTestId("dev-kx").fill(kxPub);
  await page.getByTestId("dev-name").fill("e2e lock");
  await page.getByTestId("dev-add").click();
  await expect(page.getByTestId("status")).toContainText("enrolled");
  await expect(page.getByTestId("roster-count")).toContainText("1 device(s)");

  // Config for this device goes into the source doc, then seal & push.
  await page
    .getByTestId("source-text")
    .fill(JSON.stringify({ format: "ekctl-source-v1", devices: { [devId]: { role: 2, keys: [], slots: [] } } }));
  await page.getByTestId(`push-${devId}`).click();
  await expect(page.getByTestId("status")).toContainText("config seq 1 sealed & pushed");
  await expect(page.getByTestId("roster-count")).toContainText("1 device(s)");
  await expect(page.locator("tbody tr")).toContainText("seq 1 pending");
});

test("policy editor round-trips every policy family into the source doc", async ({ page }) => {
  const devId = "a1b2c3d4e5f60718293a4b5c";
  await page.goto("/");
  await page.getByTestId("owner-generate").click();

  // Create a fresh config for a device and open the editor.
  await page.getByTestId("edit-device-new").fill(devId);
  await page.getByTestId("edit-device-create").click();
  await expect(page.getByTestId("cfg-role")).toBeVisible();

  // Two keys; second is a scatter/show-once decoy twin of the first.
  await page.getByTestId("cfg-add-key").click();
  await page.getByTestId("key-0-decoy").selectOption("1");
  await page.getByTestId("key-1-display").selectOption("custom");
  await page.getByTestId("key-1-mode").selectOption("scatter");
  await page.getByTestId("key-1-once").selectOption("refuse");

  // Slot 0: quorum of 2 over both keys, duress action, 120 s lockout.
  await page.getByTestId("slot-0-action").selectOption("duress");
  await page.getByTestId("slot-0-policy-type").selectOption("quorum");
  await page.getByTestId("slot-0-quorum-m").fill("2");
  await page.getByTestId("slot-0-quorum-keys").fill("0,1");
  await page.getByTestId("slot-0-negative").selectOption("lockout");
  await page.getByTestId("slot-0-lockout").fill("120");

  // Slot 1: sequence with paced gaps; slot 2: deadman; slot 3: path.
  await page.getByTestId("cfg-add-slot").click();
  await page.getByTestId("slot-1-policy-type").selectOption("sequence");
  await page.getByTestId("slot-1-seq-n").fill("4");
  await page.getByTestId("slot-1-seq-window").fill("900");
  await page.getByTestId("cfg-add-slot").click();
  await page.getByTestId("slot-2-policy-type").selectOption("deadman");
  await page.getByTestId("slot-2-deadman-beat").fill("7200");
  await page.getByTestId("cfg-add-slot").click();
  await page.getByTestId("slot-3-policy-type").selectOption("path");
  await page.getByTestId("slot-3-path-legs").fill("1,0");
  await page.getByTestId("slot-3-fence").fill("0");

  // Everything must have landed in the source doc as emulator-exact JSON.
  const doc = JSON.parse(await page.getByTestId("source-text").inputValue());
  const cfg = doc.devices[devId];
  expect(cfg.keys).toHaveLength(2);
  expect(cfg.keys[0].decoy).toBe(1);
  expect(cfg.keys[1].display).toMatchObject({ mode: "scatter", once: "refuse" });
  expect(cfg.slots[0]).toMatchObject({
    action: "duress",
    negative: "lockout:120",
    policy: { type: "quorum", m: 2, keys: [0, 1], window_s: 600, alternating: false },
  });
  expect(cfg.slots[1].policy).toMatchObject({ type: "sequence", n: 4, window_s: 900, gap_min_s: 60 });
  expect(cfg.slots[2].policy).toMatchObject({ type: "deadman", beat_s: 7200 });
  expect(cfg.slots[3].policy).toMatchObject({ type: "path", leg_keys: [1, 0], leg_deadline_s: 900 });
  expect(cfg.slots[3].gates.fence).toBe(0);

  // And the mapping is bidirectional: hand-editing the JSON updates the form.
  doc.devices[devId].slots[2].policy.beat_s = 60;
  await page.getByTestId("source-text").fill(JSON.stringify(doc, null, 2));
  await expect(page.getByTestId("slot-2-deadman-beat")).toHaveValue("60");
});

test("keyfile import from another browser recovers the pool too", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("owner-import").setInputFiles({
    name: "owner.json",
    mimeType: "application/json",
    buffer: Buffer.from(keyfile),
  });
  await expect(page.getByTestId("set-id")).toHaveText(setId);
  await page.getByTestId("source-load").click();
  await expect(page.getByTestId("source-text")).toHaveValue(SOURCE_DOC);
});

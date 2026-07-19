// E2e: owner-key custody, set registration, device enrollment (incl. the
// mock-device generator), the policy editor, and both recovery loops —
// against a real backend, with per-form inline statuses.
// Serial mode: later tests recover state created by earlier ones.

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

async function openSourceText(page: any) {
  const details = page.getByTestId("source-text");
  if (!(await details.isVisible())) await page.getByTestId("source-toggle").click();
}

test("generate key, register set, empty roster", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("owner-generate").click();

  setId = (await page.getByTestId("set-id").innerText()).trim();
  expect(setId).toMatch(/^[0-9a-f]{16}$/);

  await page.getByTestId("register-btn").click();
  await expect(page.getByTestId("status-key")).toContainText(`set registered: ${setId}`);

  await page.getByTestId("roster-btn").click();
  await expect(page.getByTestId("roster-count")).toContainText("0 device(s)");
  await expect(page.getByTestId("status-roster")).toContainText("roster loaded");
});

test("export keyfile, forget, import restores the same set", async ({ page }) => {
  await page.goto("/");
  // Round-trip a brand-new key: export → forget → import.
  await page.getByTestId("owner-generate").click();
  const freshSetId = (await page.getByTestId("set-id").innerText()).trim();

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-btn").click();
  const download = await downloadPromise;
  const exported = readFileSync((await download.path())!, "utf8");
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

  // Keep the keyfile for later cross-browser tests.
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-btn").click();
  keyfile = readFileSync((await (await downloadPromise).path())!, "utf8");

  await page.getByTestId("register-btn").click();
  await expect(page.getByTestId("status-key")).toContainText("set registered");

  // Argon2id in pure JS takes a moment — allow for it.
  await page.getByTestId("backup-pass").fill(PASSPHRASE);
  await page.getByTestId("backup-btn").click();
  await expect(page.getByTestId("status-backup")).toContainText("passphrase backup stored", {
    timeout: 30_000,
  });

  await openSourceText(page);
  await page.getByTestId("source-text").fill(SOURCE_DOC);
  await page.getByTestId("source-save").click();
  await expect(page.getByTestId("status-source")).toContainText("config source sealed & saved");
});

test("fresh browser recovers key via set_id + passphrase, then the source", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("owner-generate")).toBeVisible(); // truly fresh

  await page.getByTestId("restore-setid").fill(setId);
  await page.getByTestId("restore-pass").fill(PASSPHRASE);
  await page.getByTestId("restore-btn").click();
  await expect(page.getByTestId("set-id")).toHaveText(setId, { timeout: 30_000 });
  await expect(page.getByTestId("status-key")).toContainText("restored from server backup");

  await page.getByTestId("source-load").click();
  await expect(page.getByTestId("status-source")).toContainText("config source recovered");
  await openSourceText(page);
  await expect(page.getByTestId("source-text")).toHaveValue(SOURCE_DOC);
});

test("wrong passphrase is rejected inline", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("restore-setid").fill(setId);
  await page.getByTestId("restore-pass").fill("not-the-passphrase");
  await page.getByTestId("restore-btn").click();
  await expect(page.getByTestId("status-restore")).toContainText("wrong passphrase", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("owner-generate")).toBeVisible(); // still keyless
});

test("a different key is a different set with no access to the source", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("owner-generate").click();
  const otherSetId = (await page.getByTestId("set-id").innerText()).trim();
  expect(otherSetId).not.toBe(setId);
  await page.getByTestId("register-btn").click();
  await expect(page.getByTestId("status-key")).toContainText("set registered");

  await page.getByTestId("source-load").click();
  await expect(page.getByTestId("status-source")).toContainText("source load failed");
});

test("manual enroll (advanced) and seal+push from the console", async ({ page }) => {
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

  await page.getByTestId("dev-name").fill("e2e lock");
  await page.getByTestId("dev-advanced").click();
  await page.getByTestId("dev-id").fill(devId);
  await page.getByTestId("dev-sign").fill(signPub);
  await page.getByTestId("dev-kx").fill(kxPub);
  await page.getByTestId("dev-add-manual").click();
  await expect(page.getByTestId("status-devices")).toContainText("enrolled");
  await expect(page.getByTestId("roster-count")).toContainText("1 device(s)");

  // Config for this device via the source doc, then seal & push.
  await openSourceText(page);
  await page
    .getByTestId("source-text")
    .fill(JSON.stringify({ format: "ekctl-source-v1", devices: { [devId]: { role: 2, keys: [], slots: [] } } }));
  await page.getByTestId(`push-${devId}`).click();
  await expect(page.getByTestId("status-roster")).toContainText("config seq 1 sealed & pushed");
  await expect(page.locator("tbody tr")).toContainText("seq 1 pending");
});

test("mock device: one click enrolls it and downloads an ekemu state file", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("owner-import").setInputFiles({
    name: "owner.json",
    mimeType: "application/json",
    buffer: Buffer.from(keyfile),
  });
  await expect(page.getByTestId("set-id")).toHaveText(setId);

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("dev-mock").click();
  const download = await downloadPromise;
  const state = JSON.parse(readFileSync((await download.path())!, "utf8"));
  expect(state.device_id).toMatch(/^[0-9a-f]{24}$/);
  expect(state.sign_priv).toMatch(/^[0-9a-f]{64}$/);
  expect(state.kx_priv).toMatch(/^[0-9a-f]{64}$/);
  expect(state.owner_pub).toBeNull();
  expect(state.seq).toBe(0);

  await expect(page.getByTestId("status-devices")).toContainText("ekemu serial");
  await expect(page.getByTestId("roster-count")).toContainText("2 device(s)");
});

test("mock device auto-registers a never-registered set", async ({ page }) => {
  // Regression: with a fresh key and no explicit "Register set", creating a
  // mock device must register the set on demand instead of failing 404.
  await page.goto("/");
  await page.getByTestId("owner-generate").click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("dev-mock").click();
  await downloadPromise;
  await expect(page.getByTestId("status-devices")).toContainText("ekemu serial");
  await expect(page.getByTestId("roster-count")).toContainText("1 device(s)");
});

test("policy workflow round-trips every policy family into the source doc", async ({ page }) => {
  const devId = "a1b2c3d4e5f60718293a4b5c";
  await page.goto("/");
  await page.getByTestId("owner-generate").click();

  // Create a fresh config for a device — the wizard opens on step 1 (Device).
  await page.getByTestId("edit-device-create-id").fill(devId);
  await page.getByTestId("edit-device-create").click();
  await expect(page.getByTestId("cfg-role")).toBeVisible();

  // Step 2 — keys: two keys; second is a scatter/show-once decoy twin.
  await page.getByTestId("step-keys").click();
  await page.getByTestId("cfg-add-key").click();
  await page.getByTestId("key-0-adv").click();
  await page.getByTestId("key-0-decoy").selectOption("1");
  await page.getByTestId("key-1-adv").click();
  await page.getByTestId("key-1-display").selectOption("custom");
  await page.getByTestId("key-1-mode").selectOption("scatter");
  await page.getByTestId("key-1-once").selectOption("refuse");

  // Step 3 — rituals, one at a time via policy cards.
  await page.getByTestId("step-rituals").click();
  // Ritual 0: quorum of 2 over both keys, duress action, 120 s lockout.
  await page.getByTestId("slot-0-action").selectOption("duress");
  await page.getByTestId("slot-0-policy-quorum").click();
  await page.getByTestId("slot-0-quorum-m").fill("2");
  await page.getByTestId("slot-0-quorum-keys").fill("0,1");
  await page.getByTestId("slot-0-adv").click();
  await page.getByTestId("slot-0-negative").selectOption("lockout");
  await page.getByTestId("slot-0-lockout").fill("120");
  // Ritual 1: paced sequence; 2: deadman; 3: path (adding selects the new one).
  await page.getByTestId("cfg-add-slot").click();
  await page.getByTestId("slot-1-policy-sequence").click();
  await page.getByTestId("slot-1-seq-n").fill("4");
  await page.getByTestId("slot-1-seq-window").fill("900");
  await page.getByTestId("cfg-add-slot").click();
  await page.getByTestId("slot-2-policy-deadman").click();
  await page.getByTestId("slot-2-deadman-beat").fill("7200");
  await page.getByTestId("cfg-add-slot").click();
  await page.getByTestId("slot-3-policy-path").click();
  await page.getByTestId("slot-3-path-legs").fill("1,0");
  await page.getByTestId("slot-3-adv").click();
  await page.getByTestId("slot-3-fence").fill("0");

  // Step 4 — review reads back the contract in plain language.
  await page.getByTestId("step-review").click();
  const review = page.getByTestId("cfg-review");
  await expect(review).toContainText("2 distinct keys");
  await expect(review).toContainText("DURESS-UNLOCK");
  await expect(review).toContainText("locks out for 120s");
  await expect(review).toContainText("every 7200s");

  // Everything must have landed in the source doc as emulator-exact JSON.
  await openSourceText(page);
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
  await page.getByTestId("step-rituals").click();
  await page.getByTestId("slot-tab-2").click();
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
  await openSourceText(page);
  const val = await page.getByTestId("source-text").inputValue();
  expect(JSON.parse(val).devices).toBeDefined();
});
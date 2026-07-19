// E2e for the routed manager app: welcome gate, auto-registration,
// auto-loading roster, add-device flow (incl. mock devices), the policy
// workflow on device detail pages, backup/recovery loops.
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
let mockId: string;

async function openSourceText(page: any) {
  if (!(await page.getByTestId("source-text").isVisible())) {
    await page.getByTestId("source-toggle").click();
  }
}

test("create pool: everything loads itself", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("owner-generate").click();

  // Landed on Devices with the set registered and roster loaded — no
  // buttons pressed beyond "Create pool".
  setId = (await page.getByTestId("set-id").innerText()).trim();
  expect(setId).toMatch(/^[0-9a-f]{16}$/);
  await expect(page.getByTestId("roster-count")).toContainText("0 device(s)");
  await expect(page.getByTestId("roster-empty")).toBeVisible();
});

test("export keyfile, forget, import restores the same set", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("owner-generate").click();
  const freshSetId = (await page.getByTestId("set-id").innerText()).trim();

  await page.getByTestId("nav-backup").click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-btn").click();
  const exported = readFileSync((await (await downloadPromise).path())!, "utf8");
  expect(JSON.parse(exported).set_id).toBe(freshSetId);

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

  await page.getByTestId("nav-backup").click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-btn").click();
  keyfile = readFileSync((await (await downloadPromise).path())!, "utf8");

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

  // The source doc recovered itself on key load.
  await page.getByTestId("nav-backup").click();
  await openSourceText(page);
  await expect(page.getByTestId("source-text")).toHaveValue(SOURCE_DOC, { timeout: 10_000 });
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

test("a different key is a different set with no stored source", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("owner-generate").click();
  const otherSetId = (await page.getByTestId("set-id").innerText()).trim();
  expect(otherSetId).not.toBe(setId);

  await page.getByTestId("nav-backup").click();
  await page.getByTestId("source-load").click();
  await expect(page.getByTestId("status-source")).toContainText("source load failed");
});

test("manual enroll (advanced) lands on the device page; push works", async ({ page }) => {
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

  await page.getByTestId("nav-add").click();
  await page.getByTestId("dev-name").fill("e2e lock");
  await page.getByTestId("dev-advanced").click();
  await page.getByTestId("dev-id").fill(devId);
  await page.getByTestId("dev-sign").fill(signPub);
  await page.getByTestId("dev-kx").fill(kxPub);
  await page.getByTestId("dev-add-manual").click();

  // Enrolling navigates straight to the device page, which self-creates a
  // default config — push works immediately from the review step.
  await expect(page.getByTestId("device-header")).toContainText(devId.slice(0, 16));
  await page.getByTestId("step-review").click();
  await page.getByTestId("cfg-push").click();
  await expect(page.getByTestId("status-push")).toContainText("config seq 1 sealed & pushed");

  await page.getByTestId("nav-devices").click();
  await expect(page.getByTestId("roster-count")).toContainText("1 device(s)");
  await expect(page.locator("tbody tr")).toContainText("seq 1 pending");
});

test("mock device auto-registers a never-registered set", async ({ page }) => {
  // Regression: fresh key, no explicit registration, straight to mock.
  await page.goto("/");
  await page.getByTestId("owner-generate").click();
  await page.getByTestId("nav-add").click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("dev-mock").click();
  const state = JSON.parse(readFileSync((await (await downloadPromise).path())!, "utf8"));
  expect(state.device_id).toMatch(/^[0-9a-f]{24}$/);
  expect(state.sign_priv).toMatch(/^[0-9a-f]{64}$/);
  expect(state.owner_pub).toBeNull();
  await expect(page.getByTestId("status-devices")).toContainText("ekemu serial");
  await page.getByTestId("nav-devices").click();
  await expect(page.getByTestId("roster-count")).toContainText("1 device(s)");
});

test("policy workflow on a mock device round-trips every family", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("owner-import").setInputFiles({
    name: "owner.json",
    mimeType: "application/json",
    buffer: Buffer.from(keyfile),
  });
  await expect(page.getByTestId("set-id")).toHaveText(setId);

  await page.getByTestId("nav-add").click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("dev-mock").click();
  mockId = JSON.parse(readFileSync((await (await downloadPromise).path())!, "utf8")).device_id;

  await page.getByTestId("nav-devices").click();
  await page.getByTestId(`device-${mockId}`).click();
  await expect(page.getByTestId("device-header")).toContainText(mockId.slice(0, 16));

  // Secrets are masked by default; the reveal toggle is explicit.
  await page.getByTestId("step-keys").click();
  await expect(page.getByTestId("key-0-secret")).toHaveAttribute("type", "password");
  await page.getByTestId("key-0-reveal").click();
  await expect(page.getByTestId("key-0-secret")).toHaveAttribute("type", "text");

  await page.getByTestId("cfg-add-key").click();
  await page.getByTestId("key-0-adv").click();
  await page.getByTestId("key-0-decoy").selectOption("1");
  await page.getByTestId("key-1-adv").click();
  await page.getByTestId("key-1-display").selectOption("custom");
  await page.getByTestId("key-1-mode").selectOption("scatter");
  await page.getByTestId("key-1-once").selectOption("refuse");

  // Zones & times: define a named zone the gates can reference.
  await page.getByTestId("step-zones").click();
  await page.getByTestId("cfg-add-zone").click();
  await page.getByTestId("zone-0-name").fill("workshop");
  await page.getByTestId("zone-0-lat").fill("52.1");
  await page.getByTestId("zone-0-radius").fill("250");

  await page.getByTestId("step-rituals").click();
  await page.getByTestId("slot-0-action").selectOption("duress");
  await page.getByTestId("slot-0-policy-quorum").click();
  await page.getByTestId("slot-0-quorum-m").fill("2");
  await page.getByTestId("slot-0-quorum-keys").fill("0,1");
  await page.getByTestId("slot-0-adv").click();
  await page.getByTestId("slot-0-negative").selectOption("lockout");
  await page.getByTestId("slot-0-lockout").fill("120");
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
  await page.getByTestId("slot-3-fence").selectOption({ label: "workshop" });

  // Review reads back the contract, and push works right here.
  await page.getByTestId("step-review").click();
  const review = page.getByTestId("cfg-review");
  await expect(review).toContainText("2 distinct keys");
  await expect(review).toContainText("DURESS-UNLOCK");
  await expect(review).toContainText("locks out for 120s");
  await expect(review).toContainText("only inside zone 'workshop'");
  await page.getByTestId("cfg-push").click();
  await expect(page.getByTestId("status-push")).toContainText("sealed & pushed");

  // Emulator-exact JSON landed in the source doc.
  await page.getByTestId("nav-backup").click();
  await openSourceText(page);
  const doc = JSON.parse(await page.getByTestId("source-text").inputValue());
  const cfg = doc.devices[mockId];
  expect(cfg.keys[0].decoy).toBe(1);
  expect(cfg.keys[1].display).toMatchObject({ mode: "scatter", once: "refuse" });
  expect(cfg.slots[0]).toMatchObject({
    action: "duress",
    negative: "lockout:120",
    policy: { type: "quorum", m: 2, keys: [0, 1], window_s: 600, alternating: false },
  });
  expect(cfg.slots[1].policy).toMatchObject({ type: "sequence", n: 4, window_s: 900 });
  expect(cfg.slots[2].policy).toMatchObject({ type: "deadman", beat_s: 7200 });
  expect(cfg.slots[3].policy).toMatchObject({ type: "path", leg_keys: [1, 0] });
  expect(cfg.slots[3].gates.fence).toBe(0);
  expect(cfg.zones[0]).toMatchObject({ name: "workshop", lat: 52.1, radius_m: 250 });

  // Bidirectional: hand-edit the JSON, the wizard follows (client-side nav).
  doc.devices[mockId].slots[2].policy.beat_s = 60;
  await page.getByTestId("source-text").fill(JSON.stringify(doc, null, 2));
  await page.getByTestId("nav-devices").click();
  await page.getByTestId(`device-${mockId}`).click();
  await page.getByTestId("step-rituals").click();
  await page.getByTestId("slot-tab-2").click();
  await expect(page.getByTestId("slot-2-deadman-beat")).toHaveValue("60");
});

test("keyfile import from another browser recovers the pool + configs", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("owner-import").setInputFiles({
    name: "owner.json",
    mimeType: "application/json",
    buffer: Buffer.from(keyfile),
  });
  await expect(page.getByTestId("set-id")).toHaveText(setId);
  // Roster and source doc arrive on their own.
  await expect(page.getByTestId("roster-count")).toContainText("2 device(s)");
  await page.getByTestId("nav-backup").click();
  await openSourceText(page);
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await page.getByTestId("source-text").inputValue()).devices[mockId]
          ? "has-config"
          : "missing";
      } catch {
        return "unparsed";
      }
    })
    .toBe("has-config");
});
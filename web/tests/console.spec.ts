// E2e for the routed manager app: welcome gate, auto-registration,
// auto-loading roster, add-device flow (incl. mock devices), the policy
// workflow on device detail pages, backup/recovery loops.
// Serial mode: later tests recover state created by earlier ones.

import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import QRCode from "qrcode";

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
  if (!(await page.getByTestId("source-text").isVisible())) {
    await page.getByTestId("source-toggle").click();
  }
}

const POOLPASS = "poolpass123";

// Creating a pool now requires a passphrase (encrypts at rest + server backup).
async function newPool(page: any, pass = POOLPASS) {
  await page.getByTestId("create-pass").fill(pass);
  await page.getByTestId("owner-generate").click();
  // The "save your recovery id" screen appears once — acknowledge it.
  await expect(page.getByTestId("recovery-setid")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("recovery-continue").click();
  await expect(page.getByTestId("set-id")).toBeVisible({ timeout: 30_000 });
}

test("creating a pool prompts to save the recovery id", async ({ page }) => {
  await page.goto("/devices");
  await page.getByTestId("create-pass").fill(POOLPASS);
  await page.getByTestId("owner-generate").click();
  const shown = (await page.getByTestId("recovery-setid").innerText()).trim();
  expect(shown).toMatch(/^[0-9a-f]{32}$/);
  await expect(page.getByTestId("recovery-card")).toContainText("recovery id");
  await page.getByTestId("recovery-continue").click();
  await expect(page.getByTestId("set-id")).toHaveText(shown);
});

test("key QR round-trips: create, then import from a photo + passphrase", async ({ page, browser }) => {
  await page.goto("/devices");
  await page.getByTestId("create-pass").fill(POOLPASS);
  await page.getByTestId("owner-generate").click();
  const sid = (await page.getByTestId("recovery-setid").innerText()).trim();
  await page.getByTestId("recovery-qr-toggle").click();
  const payload = (await page.getByTestId("recovery-qr-payload").innerText()).trim();
  await page.getByTestId("recovery-continue").click();

  // A printed QR photographed = this payload rendered to an image.
  const png = await QRCode.toBuffer(payload, { width: 512, margin: 2 });

  // Fresh browser (no local key): import from the QR image, still gated by
  // the passphrase.
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await p2.goto("/devices");
  await p2.getByTestId("owner-import-qr").setInputFiles({ name: "qr.png", mimeType: "image/png", buffer: png });
  await expect(p2.getByTestId("qr-passphrase")).toBeVisible({ timeout: 15_000 });
  await p2.getByTestId("qr-pass").fill("wrongpass");
  await p2.getByTestId("qr-import-btn").click();
  await expect(p2.getByTestId("status-qr")).toContainText("wrong passphrase", { timeout: 30_000 });
  await p2.getByTestId("qr-pass").fill(POOLPASS);
  await p2.getByTestId("qr-import-btn").click();
  await expect(p2.getByTestId("set-id")).toHaveText(sid, { timeout: 30_000 });
  await ctx.close();
});

test("create pool: everything loads itself", async ({ page }) => {
  await page.goto("/devices");
  await newPool(page);

  // Landed on Devices with the set registered and roster loaded — no
  // buttons pressed beyond "Create pool".
  setId = (await page.getByTestId("set-id").innerText()).trim();
  expect(setId).toMatch(/^[0-9a-f]{32}$/);
  await expect(page.getByTestId("roster-count")).toContainText("0 device(s)");
  await expect(page.getByTestId("roster-empty")).toBeVisible();
});

test("export keyfile, forget, import restores the same set", async ({ page }) => {
  await page.goto("/devices");
  await newPool(page);
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
  await page.goto("/devices");
  await newPool(page);
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
  await page.goto("/devices");
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
  await page.goto("/devices");
  await page.getByTestId("restore-setid").fill(setId);
  await page.getByTestId("restore-pass").fill("not-the-passphrase");
  await page.getByTestId("restore-btn").click();
  await expect(page.getByTestId("status-restore")).toContainText("wrong passphrase", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("owner-generate")).toBeVisible(); // still keyless
});

test("a different key is a different set with no stored source", async ({ page }) => {
  await page.goto("/devices");
  await newPool(page);
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

  await page.goto("/devices");
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
  await page.goto("/devices");
  await newPool(page);
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

test("lock selects generator minter keys; generator defines them", async ({ page }) => {
  await page.goto("/devices");
  await page.getByTestId("owner-import").setInputFiles({
    name: "owner.json",
    mimeType: "application/json",
    buffer: Buffer.from(keyfile),
  });
  await expect(page.getByTestId("set-id")).toHaveText(setId);

  // --- Generator G: DEFINES two minting keys (with a zone + display) ---
  await page.getByTestId("nav-add").click();
  await page.getByTestId("dev-role").selectOption("1"); // generator
  let dl = page.waitForEvent("download");
  await page.getByTestId("dev-mock").click();
  const genId = JSON.parse(readFileSync((await (await dl).path())!, "utf8")).device_id;

  await page.getByTestId("nav-devices").click();
  await page.getByTestId(`device-${genId}`).click();
  await page.getByTestId("step-keys").click();
  await page.getByTestId("cfg-add-key").click(); // now 2 keys
  await page.getByTestId("key-1-adv").click();
  await page.getByTestId("key-1-display").selectOption("custom");
  await page.getByTestId("key-1-mode").selectOption("scatter");
  await page.getByTestId("key-1-once").selectOption("refuse");

  // --- Lock L: SELECTS G's keys, owns its confirm, builds rituals ---
  await page.getByTestId("nav-add").click();
  dl = page.waitForEvent("download");
  await page.getByTestId("dev-mock").click(); // role defaults to lock
  const lockId = JSON.parse(readFileSync((await (await dl).path())!, "utf8")).device_id;

  await page.getByTestId("nav-devices").click();
  await page.getByTestId(`device-${lockId}`).click();
  await page.getByTestId("step-keys").click();
  // Both of G's keys appear as selectable minters; pick both (become key 0,1).
  await page.getByTestId("lock-minter-0").check();
  await page.getByTestId("lock-minter-1").check();
  // The lock owns its receipt-confirm secret.
  await page.getByTestId("lock-confirm-secret").fill("lock-confirm-secret-x");

  // A zone for the fence gate.
  await page.getByTestId("step-zones").click();
  await page.getByTestId("cfg-add-zone").click();
  await page.getByTestId("zone-0-name").fill("workshop");
  await page.getByTestId("zone-0-exact").click();
  await page.getByTestId("zone-0-lat").fill("52.1");
  await page.getByTestId("zone-0-radius").fill("250");

  // Rituals reference the selected minter keys.
  await page.getByTestId("step-rituals").click();
  await page.getByTestId("slot-0-action").selectOption("duress");
  await page.getByTestId("slot-0-policy-quorum").click();
  await page.getByTestId("slot-0-quorum-m").fill("2");
  await page.getByTestId("slot-0-quorum-key-0").check();
  await page.getByTestId("slot-0-quorum-key-1").check();
  await page.getByTestId("slot-0-quorum-paced").check();
  await page.getByTestId("slot-0-adv").click();
  await page.getByTestId("slot-0-negative").selectOption("lockout");
  await page.getByTestId("slot-0-lockout").fill("120");
  await page.getByTestId("slot-0-fence").selectOption({ label: "workshop" });
  await page.getByTestId("cfg-add-slot").click();
  await page.getByTestId("slot-1-key").selectOption("1"); // its own key (not 0)
  await page.getByTestId("slot-1-policy-sequence").click();
  await page.getByTestId("slot-1-seq-n").fill("4");

  await page.getByTestId("step-review").click();
  await expect(page.getByTestId("cfg-review")).toContainText("DURESS-UNLOCK");
  await page.getByTestId("cfg-push").click();
  await expect(page.getByTestId("status-push")).toContainText("sealed & pushed");

  // Source doc: the LOCK's keys are minter references (no invented secrets),
  // it owns confirm, and the generator DEFINES the secrets + display.
  await page.getByTestId("nav-backup").click();
  await openSourceText(page);
  const doc = JSON.parse(await page.getByTestId("source-text").inputValue());
  const L = doc.devices[lockId];
  const G = doc.devices[genId];
  expect(L.keys[0].source).toMatchObject({ device: genId, key: 0 });
  expect(L.keys[1].source).toMatchObject({ device: genId, key: 1 });
  expect(L.keys[0].secret ?? "").toBe(""); // no standalone secret on a lock key
  expect(L.confirm).toMatchObject({ secret: "lock-confirm-secret-x", mode: "sequence" });
  expect(L.slots[0].policy).toMatchObject({ type: "quorum", m: 2, keys: [0, 1] });
  expect(L.slots[0].gates.fence).toBe(0);
  expect(G.role).toBe(1);
  expect(G.keys[1].display).toMatchObject({ mode: "scatter", once: "refuse" });
  expect(G.keys[0].secret.length).toBeGreaterThan(0); // generator OWNS the secret
});

test("non-ephemerkey generator: authenticator with a linked QR key", async ({ page }) => {
  await page.goto("/devices");
  await page.getByTestId("owner-import").setInputFiles({
    name: "owner.json",
    mimeType: "application/json",
    buffer: Buffer.from(keyfile),
  });
  await expect(page.getByTestId("set-id")).toHaveText(setId);
  // Wait for the async source recovery to land before editing, so it can't
  // clobber the new authenticator (roster carries devices from earlier tests).
  await expect(page.getByTestId("roster-count")).toContainText("device(s)");
  await page.getByTestId("nav-backup").click();
  await openSourceText(page);
  await expect
    .poll(async () => {
      try {
        return Object.keys(JSON.parse(await page.getByTestId("source-text").inputValue()).devices).length;
      } catch {
        return 0;
      }
    })
    .toBeGreaterThan(0);

  // Create a plain authenticator (no hardware, no enrollment).
  await page.getByTestId("nav-add").click();
  await page.getByTestId("auth-new-name").fill("Alice phone");
  await page.getByTestId("auth-create").click();
  await expect(page.getByTestId("auth-header")).toContainText("Alice phone");

  // Link its key to the mock lock's key 0 (single source of truth) and
  // reveal the QR + otpauth URI.
  await page.getByTestId("soft-0-label").fill("front door");
  const opt = page.locator('[data-testid="soft-0-link"] option', { hasText: "key 0" }).first();
  await page.getByTestId("soft-0-link").selectOption(await opt.getAttribute("value") as string);
  await page.getByTestId("soft-0-show").click();
  await expect(page.getByTestId("qr").locator("svg")).toBeVisible();
  await expect(page.getByTestId("soft-0-uri")).toContainText("otpauth://totp/");
  await expect(page.getByTestId("soft-0-uri")).toContainText("algorithm=SHA1");

  // It shows up in the Devices list under authenticators, not the roster.
  await page.getByTestId("nav-devices").click();
  await expect(page.getByTestId("auth-count")).toContainText("Authenticator apps — 1");
});

test("config linter flags two rituals sharing a key (unreachable ritual)", async ({ page }) => {
  await page.goto("/devices");
  await page.getByTestId("owner-import").setInputFiles({
    name: "owner.json",
    mimeType: "application/json",
    buffer: Buffer.from(keyfile),
  });
  await expect(page.getByTestId("set-id")).toHaveText(setId);

  // Generator with two minter keys, then a lock that selects both.
  await page.getByTestId("nav-add").click();
  await page.getByTestId("dev-role").selectOption("1");
  let dl = page.waitForEvent("download");
  await page.getByTestId("dev-mock").click();
  await (await dl).path();
  await page.getByTestId("nav-devices").click();
  await page.locator('[data-testid^="device-"]').last().click();
  await page.getByTestId("step-keys").click();
  await page.getByTestId("cfg-add-key").click(); // generator now has 2 keys

  await page.getByTestId("nav-add").click();
  dl = page.waitForEvent("download");
  await page.getByTestId("dev-mock").click(); // lock
  const lockId = JSON.parse(readFileSync((await (await dl).path())!, "utf8")).device_id;
  await page.getByTestId("nav-devices").click();
  await page.getByTestId(`device-${lockId}`).click();
  await page.getByTestId("step-keys").click();
  await page.getByTestId("lock-minter-0").check();
  await page.getByTestId("lock-minter-1").check();

  // Two rituals both default to key 0 → the second is unreachable.
  await page.getByTestId("step-rituals").click();
  await page.getByTestId("cfg-add-slot").click();
  await page.getByTestId("step-review").click();
  await expect(page.getByTestId("cfg-lint-error")).toContainText("can never advance on this key");

  // Give ritual 1 its own key → clean.
  await page.getByTestId("step-rituals").click();
  await page.getByTestId("slot-tab-1").click();
  await page.getByTestId("slot-1-key").selectOption("1");
  await page.getByTestId("step-review").click();
  await expect(page.getByTestId("cfg-lint-error")).toHaveCount(0);
});

test("keyfile import from another browser recovers the pool + configs", async ({ page }) => {
  await page.goto("/devices");
  await page.getByTestId("owner-import").setInputFiles({
    name: "owner.json",
    mimeType: "application/json",
    buffer: Buffer.from(keyfile),
  });
  await expect(page.getByTestId("set-id")).toHaveText(setId);
  // Roster and source doc arrive on their own.
  await expect(page.getByTestId("roster-count")).toContainText("device(s)");
  await page.getByTestId("nav-backup").click();
  await openSourceText(page);
  await expect
    .poll(async () => {
      try {
        return Object.keys(JSON.parse(await page.getByTestId("source-text").inputValue()).devices).length;
      } catch {
        return 0;
      }
    })
    .toBeGreaterThan(0);
});

test("switching a device's role updates its shown role", async ({ page }) => {
  await page.goto("/devices");
  await page.getByTestId("owner-import").setInputFiles({
    name: "owner.json",
    mimeType: "application/json",
    buffer: Buffer.from(keyfile),
  });
  await expect(page.getByTestId("set-id")).toHaveText(setId);
  // The mock device enrolled as a lock in an earlier test.
  await page.locator("tbody tr td", { hasText: "lock" }).first().waitFor();

  await page.locator('[data-testid^="device-"]').first().click();
  await page.getByTestId("cfg-role").selectOption("1"); // -> generator
  await expect(page.getByTestId("device-role")).toContainText("generator");

  await page.getByTestId("nav-devices").click();
  await expect(page.locator("tbody")).toContainText("generator");
});

test("manual enroll validates hex fields to catch typos", async ({ page }) => {
  const { ed25519, x25519 } = await import("@noble/curves/ed25519");
  const { bytesToHex } = await import("@noble/hashes/utils");
  await page.goto("/devices");
  await page.getByTestId("owner-import").setInputFiles({
    name: "owner.json",
    mimeType: "application/json",
    buffer: Buffer.from(keyfile),
  });
  await expect(page.getByTestId("set-id")).toHaveText(setId);

  await page.getByTestId("nav-add").click();
  await page.getByTestId("dev-advanced").click();
  await page.getByTestId("dev-id").fill(bytesToHex(crypto.getRandomValues(new Uint8Array(12))));
  // A sign_pub one char short — invalid, enroll stays disabled.
  await page.getByTestId("dev-sign").fill(bytesToHex(ed25519.getPublicKey(ed25519.utils.randomPrivateKey())).slice(0, 63));
  await page.getByTestId("dev-kx").fill(bytesToHex(x25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32)))));
  await expect(page.getByTestId("dev-add-manual")).toBeDisabled();
  // Fix it → enabled.
  await page.getByTestId("dev-sign").fill(bytesToHex(ed25519.getPublicKey(ed25519.utils.randomPrivateKey())));
  await expect(page.getByTestId("dev-add-manual")).toBeEnabled();
  // A non-hex char is rejected too.
  await page.getByTestId("dev-kx").fill("zz" + "0".repeat(62));
  await expect(page.getByTestId("dev-add-manual")).toBeDisabled();
});

test("events view loads and shows the empty state for a new pool", async ({ page }) => {
  await page.goto("/devices");
  await newPool(page);
  await page.getByTestId("nav-events").click();
  await expect(page.getByTestId("events-empty")).toBeVisible();
  await page.getByTestId("events-refresh").click();
  await expect(page.getByTestId("events-empty")).toBeVisible();
});

test("landing chooses between manage and program flows", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("landing-manage")).toBeVisible();
  await expect(page.getByTestId("landing-program")).toBeVisible();
  await page.getByTestId("landing-program").click();
  await expect(page).toHaveURL(/\/push$/);
  await page.goto("/");
  await page.getByTestId("landing-manage").click();
  await expect(page.getByTestId("owner-generate")).toBeVisible();
});

test("a created pool is encrypted at rest; Lock now requires the passphrase", async ({ page }) => {
  await page.goto("/devices");
  await newPool(page); // creates encrypted-by-default under POOLPASS
  const id = (await page.getByTestId("set-id").innerText()).trim();

  // Re-lock mid-session from the sidebar; access now needs the passphrase.
  await page.getByTestId("lock-now-nav").click();
  await expect(page.getByTestId("unlock-pass")).toBeVisible();
  await page.getByTestId("unlock-pass").fill("wrongpass");
  await page.getByTestId("unlock-btn").click();
  await expect(page.getByTestId("unlock-err")).toContainText("wrong passphrase", { timeout: 30_000 });
  await page.getByTestId("unlock-pass").fill(POOLPASS);
  await page.getByTestId("unlock-btn").click();
  await expect(page.getByTestId("set-id")).toHaveText(id, { timeout: 30_000 });

  // Survives a full reload (still locked at rest).
  await page.reload();
  await expect(page.getByTestId("unlock-pass")).toBeVisible();
  await page.getByTestId("unlock-pass").fill(POOLPASS);
  await page.getByTestId("unlock-btn").click();
  await expect(page.getByTestId("set-id")).toHaveText(id, { timeout: 30_000 });
});

test("forget a pool removes it from this browser only", async ({ page }) => {
  await page.goto("/devices");
  await newPool(page);
  const drop = (await page.getByTestId("set-id").innerText()).trim(); // will be forgotten
  await page.getByTestId("nav-pools").click();
  await newPool(page);
  const active = (await page.getByTestId("set-id").innerText()).trim(); // stays active

  // Forget the non-active pool from the manage list (inline confirm), so no
  // switch/unlock happens.
  await page.getByTestId("nav-pools").click();
  await page.getByTestId(`pool-forget-${drop}`).click();
  await page.getByTestId(`pool-forget-confirm-${drop}`).click();

  // Gone here; the active pool survives.
  await expect(page.getByTestId(`pool-open-${drop}`)).toHaveCount(0);
  await expect(page.getByTestId(`pool-open-${active}`)).toBeVisible();

  // The server copy is intact — restore the forgotten one via the keywrap it
  // stored on creation.
  await page.getByTestId("restore-setid").fill(drop);
  await page.getByTestId("restore-pass").fill(POOLPASS);
  await page.getByTestId("restore-btn").click();
  await expect(page.getByTestId("set-id")).toHaveText(drop, { timeout: 30_000 });
});

test("change passphrase re-wraps browser and server; old fails, new works", async ({ page }) => {
  await page.goto("/devices");
  await newPool(page);
  const id = (await page.getByTestId("set-id").innerText()).trim();

  await page.getByTestId("nav-backup").click();
  // Wrong current passphrase is rejected.
  await page.getByTestId("change-old").fill("wrongcurrent");
  await page.getByTestId("change-new").fill("brandnewpass1");
  await page.getByTestId("change-confirm").fill("brandnewpass1");
  await page.getByTestId("change-btn").click();
  await expect(page.getByTestId("status-backup")).toContainText("current passphrase is wrong", {
    timeout: 30_000,
  });
  // Correct change.
  await page.getByTestId("change-old").fill(POOLPASS);
  await page.getByTestId("change-new").fill("brandnewpass1");
  await page.getByTestId("change-confirm").fill("brandnewpass1");
  await page.getByTestId("change-btn").click();
  await expect(page.getByTestId("status-backup")).toContainText("passphrase changed", { timeout: 30_000 });

  // Reload: the OLD passphrase no longer unlocks; the new one does.
  await page.reload();
  await page.getByTestId("unlock-pass").fill(POOLPASS);
  await page.getByTestId("unlock-btn").click();
  await expect(page.getByTestId("unlock-err")).toContainText("wrong passphrase", { timeout: 30_000 });
  await page.getByTestId("unlock-pass").fill("brandnewpass1");
  await page.getByTestId("unlock-btn").click();
  await expect(page.getByTestId("set-id")).toHaveText(id, { timeout: 30_000 });

  // And the SERVER keywrap moved too: a fresh browser restores with the new
  // passphrase, not the old.
  const ctx = await page.context().browser()!.newContext();
  const p2 = await ctx.newPage();
  await p2.goto("/devices");
  await p2.getByTestId("restore-setid").fill(id);
  await p2.getByTestId("restore-pass").fill("brandnewpass1");
  await p2.getByTestId("restore-btn").click();
  await expect(p2.getByTestId("set-id")).toHaveText(id, { timeout: 30_000 });
  await ctx.close();
});

test("forgetting the active pool shows the pool list, not a surprise unlock", async ({ page }) => {
  await page.goto("/devices");
  await newPool(page);
  const other = (await page.getByTestId("set-id").innerText()).trim();
  await page.getByTestId("nav-pools").click();
  await newPool(page);
  const active = (await page.getByTestId("set-id").innerText()).trim();

  // Forget the ACTIVE pool.
  await page.getByTestId("nav-pools").click();
  await page.getByTestId(`pool-forget-${active}`).click();
  await page.getByTestId(`pool-forget-confirm-${active}`).click();

  // We land on the pool list (the other pool), NOT an unlock gate or a
  // phantom pool. No sidebar set-id (no active key), no unlock prompt.
  await expect(page.getByTestId(`pool-open-${other}`)).toBeVisible();
  await expect(page.getByTestId("unlock-pass")).toHaveCount(0);
  await expect(page.getByTestId("set-id")).toHaveCount(0);

  // Explicitly opening the other pool asks for its passphrase (we chose it).
  await page.getByTestId(`pool-open-${other}`).click();
  await expect(page.getByTestId("unlock-pass")).toBeVisible();
  await page.getByTestId("unlock-pass").fill(POOLPASS);
  await page.getByTestId("unlock-btn").click();
  await expect(page.getByTestId("set-id")).toHaveText(other, { timeout: 30_000 });

  // Forgetting the last pool drops to the create/import gate.
  await page.getByTestId("nav-pools").click();
  await page.getByTestId(`pool-forget-${other}`).click();
  await page.getByTestId(`pool-forget-confirm-${other}`).click();
  await expect(page.getByTestId("owner-generate")).toBeVisible();
});

test("two pools coexist; switching to another prompts for its passphrase", async ({ page }) => {
  await page.goto("/devices");
  await newPool(page);
  const first = (await page.getByTestId("set-id").innerText()).trim();
  await page.getByTestId("nav-pools").click();
  await newPool(page);
  const second = (await page.getByTestId("set-id").innerText()).trim();
  expect(second).not.toBe(first);

  // Both pools are encrypted, so selecting the other locks to its unlock gate.
  await expect(page.getByTestId("pool-switcher")).toBeVisible();
  await page.getByTestId("pool-switcher").selectOption(first);
  await expect(page.getByTestId("unlock-pass")).toBeVisible();
  await page.getByTestId("unlock-pass").fill(POOLPASS);
  await page.getByTestId("unlock-btn").click();
  await expect(page.getByTestId("set-id")).toHaveText(first, { timeout: 30_000 });
});

test("publish seals every configured device and uploads", async ({ page }) => {
  await page.goto("/devices");
  await page.getByTestId("owner-import").setInputFiles({
    name: "owner.json",
    mimeType: "application/json",
    buffer: Buffer.from(keyfile),
  });
  await expect(page.getByTestId("set-id")).toHaveText(setId);
  await expect(page.getByTestId("roster-count")).toContainText("device(s)");
  await page.getByTestId("publish-btn").click();
  await expect(page.getByTestId("status-roster")).toContainText("sealed & delivered", { timeout: 20_000 });
});

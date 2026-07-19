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
let mockId: string;

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

test("policy workflow on a mock device round-trips every family", async ({ page }) => {
  await page.goto("/devices");
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
  // display rituals & receipt chains are generator-side: not offered here
  await expect(page.getByTestId("key-0-chain")).toHaveCount(0);

  // Zones & times: define a named zone the gates can reference.
  await page.getByTestId("step-zones").click();
  await page.getByTestId("cfg-add-zone").click();
  await page.getByTestId("zone-0-name").fill("workshop");

  // Map picker: clicking places the center; the slider drives the radius.
  await page.getByTestId("zone-0-map").click({ position: { x: 200, y: 120 } });
  await page.getByTestId("zone-0-exact").click();
  await expect.poll(async () => page.getByTestId("zone-0-lat").inputValue()).not.toBe("0");
  await page.getByTestId("zone-0-radius-slider").fill("50"); // log scale ≈ 316 m
  await expect.poll(async () => Number(await page.getByTestId("zone-0-radius").inputValue())).toBeGreaterThan(100);

  // Exact fields override for precision.
  await page.getByTestId("zone-0-lat").fill("52.1");
  await page.getByTestId("zone-0-radius").fill("250");

  await page.getByTestId("step-rituals").click();
  await page.getByTestId("slot-0-action").selectOption("duress");
  await page.getByTestId("slot-0-policy-quorum").click();
  await page.getByTestId("slot-0-quorum-m").fill("2");
  await page.getByTestId("slot-0-quorum-key-0").check();
  await page.getByTestId("slot-0-quorum-key-1").check();
  await page.getByTestId("slot-0-quorum-paced").check(); // paced quorum: 60-300s cadence
  await page.getByTestId("slot-0-adv").click();
  await page.getByTestId("slot-0-negative").selectOption("lockout");
  await page.getByTestId("slot-0-lockout").fill("120");
  await page.getByTestId("slot-0-veto-delay").fill("90"); // coercion brake
  await page.getByTestId("slot-0-veto-key").selectOption("1");
  await page.getByTestId("slot-0-budget").fill("3"); // dies after 3 fires
  await page.getByTestId("cfg-add-slot").click();
  await page.getByTestId("slot-1-policy-sequence").click();
  await page.getByTestId("slot-1-seq-n").fill("4");
  await page.getByTestId("slot-1-seq-window").fill("900");
  await page.getByTestId("slot-1-seq-jitter").fill("45"); // randomized pacing variant
  await page.getByTestId("cfg-add-slot").click();
  await page.getByTestId("slot-2-policy-deadman").click();
  await page.getByTestId("slot-2-deadman-beat").fill("7200");
  await page.getByTestId("cfg-add-slot").click();
  await page.getByTestId("slot-3-policy-path").click();
  await page.getByTestId("slot-3-leg-add").click();
  await page.getByTestId("slot-3-leg-add").click();
  await page.getByTestId("slot-3-leg-0").selectOption("1");
  await page.getByTestId("slot-3-leg-1").selectOption("0");
  await page.getByTestId("slot-3-adv").click();
  await page.getByTestId("slot-3-fence").selectOption({ label: "workshop" });

  // Review reads back the contract, and push works right here.
  await page.getByTestId("step-review").click();
  const review = page.getByTestId("cfg-review");
  await expect(review).toContainText("2 distinct keys");
  await expect(review).toContainText("DURESS-UNLOCK");
  await expect(review).toContainText("locks out for 120s");
  await expect(review).toContainText("paced 60\u2013300s apart");
  await expect(review).toContainText("jitter up to 45s");
  await expect(review).toContainText("only inside zone 'workshop'");
  await expect(review).toContainText("arms for 90s before firing — key 1 can veto");
  await expect(review).toContainText("dies after 3 fire(s)");
  await expect(page.getByTestId("cfg-crit")).toContainText(
    "budget, quorum-pace, seq-jitter, veto, zones",
  );

  // --- generator phase: same pool, a generator's view of its keys ---
  await page.getByTestId("step-device").click();
  await page.getByTestId("cfg-role").selectOption("1");
  await expect(page.getByTestId("step-rituals")).toHaveCount(0); // no lock rituals on a generator
  await page.getByTestId("step-keys").click();
  await page.getByTestId("key-0-adv").click();
  await page.getByTestId("key-0-zone").selectOption({ label: "workshop" });
  await page.getByTestId("key-0-chain").selectOption("on"); // witness chain
  await page.getByTestId("key-0-chain-elapsed").fill("1200");
  await page.getByTestId("key-1-adv").click();
  await page.getByTestId("key-1-display").selectOption("custom");
  await page.getByTestId("key-1-mode").selectOption("scatter");
  await page.getByTestId("key-1-once").selectOption("refuse");
  await page.getByTestId("step-review").click();
  const genReview = page.getByTestId("cfg-review");
  await expect(genReview).toContainText("Generator");
  await expect(genReview).toContainText("only inside zone 'workshop'");
  await expect(genReview).toContainText("chained: requires the lock's lock receipt, then a 1200s cooling-off");
  await expect(page.getByTestId("cfg-crit")).toContainText("chain");
  // back to lock role for the push + JSON checks below
  await page.getByTestId("step-device").click();
  await page.getByTestId("cfg-role").selectOption("2");
  await page.getByTestId("step-review").click();
  await page.getByTestId("cfg-push").click();
  await expect(page.getByTestId("status-push")).toContainText("sealed & pushed");

  // Emulator-exact JSON landed in the source doc.
  await page.getByTestId("nav-backup").click();
  await openSourceText(page);
  const doc = JSON.parse(await page.getByTestId("source-text").inputValue());
  const cfg = doc.devices[mockId];
  expect(cfg.keys[0].decoy).toBe(1);
  expect(cfg.keys[0].chain).toMatchObject({ mode: "sequence", action: "lock", min_elapsed_s: 1200 });
  expect(cfg.keys[0].zone).toBe(0);
  expect(cfg.slots[0]).toMatchObject({ veto_delay_s: 90, veto_key: 1, budget: 3 });
  expect(cfg.keys[1].display).toMatchObject({ mode: "scatter", once: "refuse" });
  expect(cfg.slots[0]).toMatchObject({
    action: "duress",
    negative: "lockout:120",
    policy: {
      type: "quorum", m: 2, keys: [0, 1], window_s: 600, alternating: false,
      gap_min_s: 60, gap_max_s: 300,
    },
  });
  expect(cfg.slots[1].policy).toMatchObject({ type: "sequence", n: 4, window_s: 900, jitter_s: 45 });
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

  // A synthetic device page self-creates a clean default config (1 key,
  // 1 slot). Add a second key and a second ritual.
  await page.goto("/device/1111111111111111111111aa");
  await page.getByTestId("step-keys").click();
  await page.getByTestId("cfg-add-key").click();
  await page.getByTestId("step-rituals").click();
  await page.getByTestId("cfg-add-slot").click();

  // Both rituals default to key 0 → the second is unreachable.
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

// Config document types — field-for-field parity with the firmware core's
// scenario schema (ephemerkey-emu src/main.rs: KeyCfg/SlotCfg/GatesCfg/
// PolicyCfg). The editor produces exactly this JSON; it is the sealed
// payload until the integer-keyed CBOR config document is pinned, and the
// emulator can run it directly.

export type DisplayMode = "plain" | "scatter";
export type OnceMode = "unlimited" | "refuse" | "decoy";
export type SlotAction = "unlock" | "lock" | "duress";
export type NegativeAction = string; // "reset" | "lockout:<secs>" | "silent"

export interface KeyDisplay {
  mode: DisplayMode;
  dwell_ms: number; // scatter dwell per burst, default 800
  reveal_s: number; // reveal window length, default 5
  once: OnceMode; // re-reveal behavior within one TOTP step
  gap_min_s: number; // minimum gap between reveals
}

/** Receipt chain: this key's generator refuses to mint codes until fed
 *  the lock's receipt code, then a cooling-off. The lock's attest button
 *  re-mints a fresh state receipt whenever one goes missing. */
export interface KeyChain {
  secret: string; // the lock's confirm secret
  digits: number;
  mode: "sequence" | "time" | "both"; // sequence = ageless (any travel time)
  action: "lock" | "unlock"; // which receipt feeds the chain
  min_elapsed_s: number; // cooling-off after feeding
  max_age_s: number; // accepted receipt age for TIME proofs (travel time)
}

/** Where a lock-controller key's codes are MINTED. A lock validates codes;
 *  it can't invent a secret nothing produces, so each of its keys references
 *  a minter elsewhere in the pool — an ephemerkey generator key or a
 *  third-party authenticator key. Resolved to the real secret only at push. */
export type KeySource =
  | { device: string; key: number } // an ephemerkey generator's key
  | { auth: string; key: number }; // a third-party authenticator's key

export interface KeyDef {
  // On a GENERATOR these are the minting secrets (defined here). On a
  // LOCK-CONTROLLER a key instead carries `source` and `secret` is filled in
  // (resolved) only when the config is sealed for the device.
  secret: string; // raw TOTP secret; never leaves the manager's browser unsealed
  digits: number; // 4..10, default 6
  decoy?: number; // index of this key's decoy twin in keys[]
  display?: KeyDisplay;
  chain?: KeyChain;
  /** Generator zone binding: this key's codes only mint inside zones[zone]
   *  — a code then proves where it was minted (zone-keyed secrets). */
  zone?: number;
  /** Lock-controller only: the minter whose codes this key validates. */
  source?: KeySource;
}

export interface Minter {
  ref: KeySource;
  label: string;
  secret: string;
  digits: number;
}

/** Every key that mints codes in the pool: generator device keys + resolved
 *  authenticator keys. `nameOf` labels a device id (roster names live on the
 *  server, not the source doc). */
export function enumerateMinters(doc: any, nameOf: (id: string) => string): Minter[] {
  const out: Minter[] = [];
  const devices: Record<string, DeviceConfig> = doc?.devices ?? {};
  for (const [id, cfg] of Object.entries(devices)) {
    if (cfg?.role !== 1) continue; // generators only
    (cfg.keys ?? []).forEach((k, i) => {
      out.push({ ref: { device: id, key: i }, label: `${nameOf(id)} · key ${i}`, secret: k.secret, digits: k.digits });
    });
  }
  const auths: Record<string, Authenticator> = doc?.authenticators ?? {};
  for (const [id, a] of Object.entries(auths)) {
    (a.keys ?? []).forEach((sk, i) => {
      const r = resolveSoftKey(sk, devices);
      if (r) out.push({ ref: { auth: id, key: i }, label: `📱 ${a.name || id.slice(0, 6)} · ${sk.label}`, secret: r.secret, digits: r.digits });
    });
  }
  return out;
}

/** The concrete secret+digits a key resolves to (following a lock source). */
export function resolveKeySecret(k: KeyDef, doc: any): { secret: string; digits: number } | null {
  if (k.source) {
    if ("device" in k.source) {
      const dk = doc?.devices?.[k.source.device]?.keys?.[k.source.key];
      return dk ? { secret: dk.secret, digits: dk.digits } : null;
    }
    const sk = doc?.authenticators?.[k.source.auth]?.keys?.[k.source.key];
    return sk ? resolveSoftKey(sk, doc?.devices ?? {}) : null;
  }
  return k.secret ? { secret: k.secret, digits: k.digits } : null;
}

/** Resolve a config for sealing: lock keys become plain {secret,digits}
 *  (minters resolved); generator configs are already concrete. */
export function flattenDeviceConfig(cfg: DeviceConfig, doc: any): DeviceConfig {
  if (cfg.role === 1) return cfg;
  const keys = cfg.keys.map((k) => {
    const r = resolveKeySecret(k, doc);
    const out: KeyDef = { secret: r?.secret ?? "", digits: r?.digits ?? 6 };
    if (k.decoy !== undefined) out.decoy = k.decoy;
    return out;
  });
  return { ...cfg, keys };
}

export function defaultChain(): KeyChain {
  const raw = crypto.getRandomValues(new Uint8Array(20));
  return {
    secret: Array.from(raw, (b) => String.fromCharCode(33 + (b % 94))).join(""),
    digits: 6,
    mode: "sequence",
    action: "lock",
    min_elapsed_s: 1800,
    max_age_s: 3600,
  };
}

export type Policy =
  | { type: "always" }
  | {
      type: "sequence";
      n: number;
      window_s: number;
      gap_min_s: number;
      gap_max_s: number;
      delay_min_s: number;
      delay_max_s: number;
      /** 0 = fixed rhythm; >0 = each step the device secretly tightens the
       *  accept window by up to this many seconds (randomized pacing). */
      jitter_s: number;
    }
  | { type: "path"; leg_keys: number[]; leg_deadline_s: number; delay_max_s: number }
  | { type: "deadman"; beat_s: number }
  | {
      type: "quorum";
      m: number;
      keys: number[];
      window_s: number;
      alternating: boolean;
      /** Paced quorum: contributions must keep this generation cadence.
       *  0 / 65535 = unpaced. */
      gap_min_s: number;
      gap_max_s: number;
    };

export const QUORUM_UNPACED_MAX = 65535;

export interface SlotGates {
  fence?: number; // fence-table index the lock must be inside
  stillness_s: number; // seconds of stillness required (0 = none)
  calendar?: number; // calendar-window index that must be open
}

export interface SlotDef {
  key: number; // index into keys[]
  action: SlotAction;
  policy: Policy;
  progress: boolean;
  reset_on_invalid: boolean;
  negative: NegativeAction;
  gates: SlotGates;
  /** Veto window: 0 = fire immediately; >0 = arm, fire after this many
   *  seconds unless a valid code from veto_key cancels. */
  veto_delay_s?: number;
  veto_key?: number;
  /** 0/undefined = unlimited; otherwise the slot dies after N fires. */
  budget?: number;
}

/** A geofence. Gates reference zones by index; `name` is for humans.
 *  (Circle-only for now; upstream design also allows polygons.) */
export interface Zone {
  name: string;
  lat: number;
  lon: number;
  radius_m: number;
}

/** A recurring time window. Gates reference windows by index. */
export interface CalendarWindow {
  name: string;
  days: number[]; // 0 = Sunday … 6 = Saturday
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

/** A non-ephemerkey generator: a plain authenticator app (or any RFC 6238
 *  device) that holds pool secrets and mints their codes. No crypto
 *  identity, no enrollment, no sealed config — it lives only in the source
 *  doc and is delivered as otpauth QR codes. Its keys either carry their
 *  own secret or LINK to a lock/generator key (single source of truth) so
 *  the codes it produces are accepted by that device. */
export interface SoftKey {
  label: string;
  digits: number;
  period?: number;
  /** Standalone secret; ignored when `link` is set. */
  secret?: string;
  /** Mirror a device key: {device: source-doc device id, key: index}. */
  link?: { device: string; key: number };
}

export interface Authenticator {
  name: string;
  keys: SoftKey[];
}

export function defaultSoftKey(): SoftKey {
  const raw = crypto.getRandomValues(new Uint8Array(20));
  return {
    label: "code",
    digits: 6,
    secret: Array.from(raw, (b) => String.fromCharCode(33 + (b % 94))).join(""),
  };
}

/** Resolve a soft key's effective secret+digits, following a link. */
export function resolveSoftKey(
  k: SoftKey,
  devices: Record<string, DeviceConfig>,
): { secret: string; digits: number } | null {
  if (k.link) {
    const dk = devices[k.link.device]?.keys?.[k.link.key];
    return dk ? { secret: dk.secret, digits: dk.digits } : null;
  }
  return k.secret ? { secret: k.secret, digits: k.digits } : null;
}

/** The lock's confirm-TOTP receipt identity — the one secret a lock OWNS,
 *  because it MINTS receipts (on every fire/relock). Validators (a
 *  generator's receipt chain, the manager's event/receipt checks) hold the
 *  same secret to verify. */
export interface ConfirmDef {
  secret: string;
  digits: number;
  mode: "sequence" | "time" | "both";
}

export function defaultConfirm(): ConfirmDef {
  const raw = crypto.getRandomValues(new Uint8Array(20));
  return {
    secret: Array.from(raw, (b) => String.fromCharCode(33 + (b % 94))).join(""),
    digits: 6,
    mode: "sequence",
  };
}

export interface DeviceConfig {
  role: 1 | 2; // 1 generator, 2 lock-controller
  keys: KeyDef[];
  slots: SlotDef[];
  // Referenced by slot gates; unknown to the emulator's serde (ignored
  // there — its virtual env drives gate state) and carried to firmware
  // once the zone/calendar tables land in the pinned config doc.
  zones?: Zone[];
  calendars?: CalendarWindow[];
  /** Lock-controller: the receipt-minting identity this lock owns. */
  confirm?: ConfirmDef;
}

export function defaultZone(n: number): Zone {
  return { name: `zone ${n}`, lat: 0, lon: 0, radius_m: 100 };
}

export function defaultCalendar(n: number): CalendarWindow {
  return { name: `window ${n}`, days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
}

export const DEFAULT_DISPLAY: KeyDisplay = {
  mode: "plain",
  dwell_ms: 800,
  reveal_s: 5,
  once: "unlimited",
  gap_min_s: 0,
};

export function defaultKey(): KeyDef {
  const raw = crypto.getRandomValues(new Uint8Array(20));
  return { secret: Array.from(raw, (b) => String.fromCharCode(33 + (b % 94))).join(""), digits: 6 };
}

export function defaultPolicy(type: Policy["type"]): Policy {
  switch (type) {
    case "always":
      return { type: "always" };
    case "sequence":
      return { type: "sequence", n: 3, window_s: 600, gap_min_s: 60, gap_max_s: 300, delay_min_s: 0, delay_max_s: 60, jitter_s: 0 };
    case "path":
      return { type: "path", leg_keys: [], leg_deadline_s: 900, delay_max_s: 60 };
    case "deadman":
      return { type: "deadman", beat_s: 3600 };
    case "quorum":
      return { type: "quorum", m: 2, keys: [], window_s: 600, alternating: false, gap_min_s: 0, gap_max_s: QUORUM_UNPACED_MAX };
  }
}

export function defaultSlot(): SlotDef {
  return {
    key: 0,
    action: "unlock",
    policy: defaultPolicy("always"),
    progress: false,
    reset_on_invalid: true,
    negative: "reset",
    gates: { stillness_s: 0 },
  };
}

export function defaultDeviceConfig(role: 1 | 2): DeviceConfig {
  // A generator DEFINES its minting keys; a lock-controller SELECTS minter
  // keys (starts empty) and owns only its receipt-confirm secret.
  if (role === 1) return { role, keys: [defaultKey()], slots: [defaultSlot()] };
  return { role, keys: [], slots: [defaultSlot()], confirm: defaultConfirm() };
}

/** Feature tags a config's security depends on — becomes its `crit` list.
 *  A device that doesn't recognize an entry must refuse the config
 *  (frame error 7) rather than silently not enforce it. */
export function configFeatures(cfg: DeviceConfig): string[] {
  const f = new Set<string>();
  for (const s of cfg.slots) {
    if (s.policy.type === "sequence" && (s.policy.jitter_s ?? 0) > 0) f.add("seq-jitter");
    if (s.policy.type === "quorum" && (s.policy.gap_max_s ?? QUORUM_UNPACED_MAX) < QUORUM_UNPACED_MAX) {
      f.add("quorum-pace");
    }
    if (s.gates.fence !== undefined) f.add("zones");
    if (s.gates.calendar !== undefined) f.add("calendars");
    if ((s.veto_delay_s ?? 0) > 0) f.add("veto");
    if ((s.budget ?? 0) > 0) f.add("budget");
  }
  for (const k of cfg.keys) {
    if (k.chain) f.add("chain");
    if (k.zone !== undefined) f.add("zones");
  }
  return [...f].sort();
}

/** The keys a slot can match a code against (its dispatch keys). */
export function slotKeys(s: SlotDef): number[] {
  if (s.policy.type === "path") return [...new Set(s.policy.leg_keys)];
  if (s.policy.type === "quorum") return [...new Set(s.policy.keys)];
  return [s.key];
}

export interface LintIssue {
  level: "error" | "warn";
  msg: string;
}

/** Config sanity for a lock-controller. The engine dispatches a code to the
 *  FIRST slot (by index) whose key matches, then stops — so two slots that
 *  share a key make the later one unreachable (silent: a ritual the manager
 *  believes is armed can never fire). Rituals are told apart by key, never
 *  chosen by the person entering codes. */
export function lintConfig(cfg: DeviceConfig, doc?: any): LintIssue[] {
  if (cfg.role !== 2) return [];
  const issues: LintIssue[] = [];
  // Lock keys must resolve to a minter (a generator or authenticator key).
  cfg.keys.forEach((k, i) => {
    if (!k.source && !k.secret) {
      issues.push({ level: "error", msg: `key ${i} has no minter — pick a generator or authenticator key that produces its codes.` });
    } else if (k.source && doc && !resolveKeySecret(k, doc)) {
      issues.push({ level: "error", msg: `key ${i}'s minter no longer exists in the pool — re-select it.` });
    } else if (!k.source && k.secret) {
      issues.push({ level: "warn", msg: `key ${i} is a standalone secret — confirm you load it into a generator or authenticator app, or it can never be minted.` });
    }
  });
  const owners = new Map<number, number[]>(); // key index -> slot indices
  cfg.slots.forEach((s, si) => {
    for (const k of slotKeys(s)) {
      const list = owners.get(k) ?? [];
      list.push(si);
      owners.set(k, list);
    }
  });
  for (const [k, slotsUsing] of owners) {
    if (slotsUsing.length > 1) {
      const [first, ...rest] = slotsUsing;
      issues.push({
        level: "error",
        msg: `key ${k} feeds rituals ${slotsUsing.join(" & ")}: a code for it only ever reaches ritual ${first} (lowest index) — ritual(s) ${rest.join(", ")} can never advance on this key. Give each ritual its own key.`,
      });
    }
  }
  cfg.slots.forEach((s, si) => {
    if (s.policy.type === "quorum" && s.policy.keys.length < s.policy.m) {
      issues.push({ level: "error", msg: `ritual ${si}: quorum needs ${s.policy.m} keys but only ${s.policy.keys.length} are listed — it can never complete.` });
    }
    if (s.policy.type === "path" && s.policy.leg_keys.length < 2) {
      issues.push({ level: "warn", msg: `ritual ${si}: a walk-the-path with fewer than 2 legs is just a single-code check.` });
    }
  });
  return issues;
}

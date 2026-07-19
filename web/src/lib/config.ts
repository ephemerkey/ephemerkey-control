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

export interface KeyDef {
  secret: string; // raw TOTP secret; never leaves the manager's browser unsealed
  digits: number; // 4..10, default 6
  decoy?: number; // index of this key's decoy twin in keys[]
  display?: KeyDisplay;
  chain?: KeyChain;
  /** Generator zone binding: this key's codes only mint inside zones[zone]
   *  — a code then proves where it was minted (zone-keyed secrets). */
  zone?: number;
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

export interface DeviceConfig {
  role: 1 | 2; // 1 generator, 2 lock-controller
  keys: KeyDef[];
  slots: SlotDef[];
  // Referenced by slot gates; unknown to the emulator's serde (ignored
  // there — its virtual env drives gate state) and carried to firmware
  // once the zone/calendar tables land in the pinned config doc.
  zones?: Zone[];
  calendars?: CalendarWindow[];
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
  return { role, keys: [defaultKey()], slots: [defaultSlot()] };
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

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

export interface KeyDef {
  secret: string; // raw TOTP secret; never leaves the manager's browser unsealed
  digits: number; // 4..10, default 6
  decoy?: number; // index of this key's decoy twin in keys[]
  display?: KeyDisplay;
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
    }
  | { type: "path"; leg_keys: number[]; leg_deadline_s: number; delay_max_s: number }
  | { type: "deadman"; beat_s: number }
  | { type: "quorum"; m: number; keys: number[]; window_s: number; alternating: boolean };

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
}

export interface DeviceConfig {
  role: 1 | 2; // 1 generator, 2 lock-controller
  keys: KeyDef[];
  slots: SlotDef[];
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
      return { type: "sequence", n: 3, window_s: 600, gap_min_s: 60, gap_max_s: 300, delay_min_s: 0, delay_max_s: 60 };
    case "path":
      return { type: "path", leg_keys: [], leg_deadline_s: 900, delay_max_s: 60 };
    case "deadman":
      return { type: "deadman", beat_s: 3600 };
    case "quorum":
      return { type: "quorum", m: 2, keys: [], window_s: 600, alternating: false };
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

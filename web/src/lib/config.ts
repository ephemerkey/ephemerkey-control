// Config document types, mirroring the shapes the firmware core already
// implements (see ephemerkey/firmware/ephemerkey-emu/scenarios/*.json and
// ephemerkey-core policy.rs). The console edits these; sealing converts to
// the canonical integer-keyed CBOR + COSE envelope once that format is
// pinned jointly with firmware (ephemerkey/DESIGN-management.md §Encoding).

export type DisplayMode = "plain" | "scatter" | "short" | "once";

export interface KeyDisplay {
  mode: DisplayMode;
  dwell_ms?: number;
  reveal_s?: number;
  once?: "decoy" | "real";
  gap_min_s?: number;
}

export interface KeyDef {
  secret: string; // raw TOTP secret; never leaves the manager's browser unsealed
  digits: number; // 4..10
  decoy?: number; // index of the decoy key paired with this one
  display?: KeyDisplay;
}

export type Policy =
  | { type: "always" }
  | {
      type: "sequence";
      n: number;
      window_s: number;
      gap_min_s?: number;
      gap_max_s?: number;
      delay_min_s?: number;
      delay_max_s?: number;
    }
  | { type: "path"; legs: number[] } // ordered zone-key ids
  | { type: "deadman"; beat_s: number }
  | { type: "quorum"; m: number; n: number; keys: number[]; window_s: number; alternating?: boolean };

export type SlotAction = "unlock" | "lock" | "duress-unlock";

export interface SlotDef {
  key: number; // index into keys[]
  action: SlotAction;
  policy: Policy;
  progress?: boolean;
  reset_on_invalid?: boolean;
  negative?: string; // e.g. "lockout:300"
}

export interface DeviceConfig {
  role: 1 | 2; // 1 generator, 2 lock-controller
  keys: KeyDef[];
  slots: SlotDef[];
  // zones/device-opts follow as the editor grows (DESIGN-management.md map 6/9)
}

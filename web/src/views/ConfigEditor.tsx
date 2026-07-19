// Guided config workflow for one device. Four steps — Device, Keys,
// Rituals (slots, one at a time, policy picked from described cards),
// Review & push — writing emulator-exact JSON (lib/config.ts) into the
// source doc as you go. The raw JSON stays visible in the console's
// advanced fold; this is the human path.

import { useState } from "react";
import {
  defaultKey,
  defaultPolicy,
  defaultSlot,
  DeviceConfig,
  DEFAULT_DISPLAY,
  KeyDef,
  Policy,
  SlotDef,
} from "../lib/config";

const POLICY_CARDS: { type: Policy["type"]; title: string; tagline: string; use: string }[] = [
  {
    type: "always",
    title: "Master key",
    tagline: "Any single valid code fires the action immediately.",
    use: "everyday access; an override key kept in a safe",
  },
  {
    type: "sequence",
    title: "Paced sequence",
    tagline:
      "Several valid codes in a row, humanly paced: enforced gaps between entries, then a randomized delay before the action fires.",
    use: "forces a deliberate, unhurried unlock — defeats smash-and-grab and rushed coercion",
  },
  {
    type: "path",
    title: "Walk the path",
    tagline:
      "Codes from specific keys in a fixed order, each leg within a deadline. With zone keys, the generator only mints a zone's codes inside that zone.",
    use: "proves a route was actually walked (home → transit → site)",
  },
  {
    type: "deadman",
    title: "Dead man's switch",
    tagline: "A valid code must arrive every beat; miss one and the action fires on its own.",
    use: "auto-lock or alert when check-ins stop",
  },
  {
    type: "quorum",
    title: "Quorum",
    tagline: "M distinct keys out of a named group, together within a window; optionally strictly alternating.",
    use: "two-person rule — no single keyholder can do it alone",
  },
];

const ACTION_HELP: Record<string, string> = {
  unlock: "drives the lock open",
  lock: "drives the lock closed",
  duress: "unlocks normally but mints a distinguishable receipt — a silent alarm",
};

function Num({
  label,
  value,
  onChange,
  min = 0,
  max = 65535,
  help,
  testid,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  help?: string;
  testid?: string;
}) {
  return (
    <label className="field">
      {label}
      <input
        data-testid={testid}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {help && <span className="fieldhelp">{help}</span>}
    </label>
  );
}

// ---------------------------------------------------------------- keys step

function KeyRow({
  k,
  idx,
  keyCount,
  onChange,
  onRemove,
}: {
  k: KeyDef;
  idx: number;
  keyCount: number;
  onChange: (k: KeyDef) => void;
  onRemove: () => void;
}) {
  const d = k.display;
  return (
    <fieldset className="editor-row" data-testid={`key-${idx}`}>
      <legend>key {idx}</legend>
      <label className="field">
        secret
        <input
          data-testid={`key-${idx}-secret`}
          value={k.secret}
          onChange={(e) => onChange({ ...k, secret: e.target.value })}
        />
        <span className="fieldhelp">the TOTP seed — exportable to authenticator apps</span>
      </label>
      <Num
        label="digits"
        value={k.digits}
        min={4}
        max={10}
        testid={`key-${idx}-digits`}
        help="code length (authenticator apps support 6–8)"
        onChange={(v) => onChange({ ...k, digits: v })}
      />
      <button data-testid={`key-${idx}-remove`} className="danger" onClick={onRemove}>
        remove key
      </button>
      <details className="advanced">
        <summary data-testid={`key-${idx}-adv`}>advanced: decoy twin &amp; display ritual</summary>
        <label className="field">
          decoy twin
          <select
            data-testid={`key-${idx}-decoy`}
            value={k.decoy ?? ""}
            onChange={(e) => onChange({ ...k, decoy: e.target.value === "" ? undefined : Number(e.target.value) })}
          >
            <option value="">none</option>
            {Array.from({ length: keyCount }, (_, i) => i)
              .filter((i) => i !== idx)
              .map((i) => (
                <option key={i} value={i}>
                  key {i}
                </option>
              ))}
          </select>
          <span className="fieldhelp">
            a sibling secret whose codes look identical but land in a different slot — e.g. a
            duress slot, or poison for a show-once display
          </span>
        </label>
        <label className="field">
          display
          <select
            data-testid={`key-${idx}-display`}
            value={d ? "custom" : "default"}
            onChange={(e) =>
              onChange({ ...k, display: e.target.value === "custom" ? { ...DEFAULT_DISPLAY } : undefined })
            }
          >
            <option value="default">plain (default)</option>
            <option value="custom">customized ritual…</option>
          </select>
          <span className="fieldhelp">how the generator reveals this key&apos;s codes on its display</span>
        </label>
        {d && (
          <>
            <label className="field">
              mode
              <select
                data-testid={`key-${idx}-mode`}
                value={d.mode}
                onChange={(e) => onChange({ ...k, display: { ...d, mode: e.target.value as any } })}
              >
                <option value="plain">plain — digits in order</option>
                <option value="scatter">scatter — digits out of order</option>
              </select>
              <span className="fieldhelp">scatter defeats shoulder-surfing and cameras</span>
            </label>
            <Num
              label="dwell_ms"
              value={d.dwell_ms}
              help="ms each scattered digit stays up"
              onChange={(v) => onChange({ ...k, display: { ...d, dwell_ms: v } })}
            />
            <Num
              label="reveal_s"
              value={d.reveal_s}
              help="seconds a reveal lasts"
              onChange={(v) => onChange({ ...k, display: { ...d, reveal_s: v } })}
            />
            <label className="field">
              re-reveal
              <select
                data-testid={`key-${idx}-once`}
                value={d.once}
                onChange={(e) => onChange({ ...k, display: { ...d, once: e.target.value as any } })}
              >
                <option value="unlimited">unlimited</option>
                <option value="refuse">refuse — one look per code</option>
                <option value="decoy">poison — decoys after the first look</option>
              </select>
              <span className="fieldhelp">
                what a second peek in the same period gets: refuse punishes writing codes down late;
                poison feeds an observer fakes
              </span>
            </label>
            <Num
              label="gap_min_s"
              value={d.gap_min_s}
              help="minimum seconds between reveals"
              onChange={(v) => onChange({ ...k, display: { ...d, gap_min_s: v } })}
            />
          </>
        )}
      </details>
    </fieldset>
  );
}

// -------------------------------------------------------------- slots step

function keyIndexList(value: number[], keyCount: number, onChange: (v: number[]) => void, testid: string, help: string) {
  return (
    <label className="field">
      keys (comma-sep indices)
      <input
        data-testid={testid}
        value={value.join(",")}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s !== "")
              .map(Number)
              .filter((n) => Number.isInteger(n) && n >= 0 && n < keyCount),
          )
        }
      />
      <span className="fieldhelp">{help}</span>
    </label>
  );
}

function PolicyParams({
  p,
  idx,
  keyCount,
  onChange,
}: {
  p: Policy;
  idx: number;
  keyCount: number;
  onChange: (p: Policy) => void;
}) {
  if (p.type === "always") return null;
  return (
    <div className="policy">
      {p.type === "sequence" && (
        <>
          <Num label="n codes" value={p.n} min={1} max={16} testid={`slot-${idx}-seq-n`} help="how many valid codes in a row" onChange={(v) => onChange({ ...p, n: v })} />
          <Num label="window_s" value={p.window_s} testid={`slot-${idx}-seq-window`} help="the whole sequence must fit in this window" onChange={(v) => onChange({ ...p, window_s: v })} />
          <Num label="gap_min_s" value={p.gap_min_s} help="entries closer than this are rejected — no rushing" onChange={(v) => onChange({ ...p, gap_min_s: v })} />
          <Num label="gap_max_s" value={p.gap_max_s} help="entries further apart than this reset — stay present" onChange={(v) => onChange({ ...p, gap_max_s: v })} />
          <Num label="delay_min_s" value={p.delay_min_s} help="after the last code: wait at least this long" onChange={(v) => onChange({ ...p, delay_min_s: v })} />
          <Num label="delay_max_s" value={p.delay_max_s} help="…and at most this long (randomized in between)" onChange={(v) => onChange({ ...p, delay_max_s: v })} />
        </>
      )}
      {p.type === "path" && (
        <>
          {keyIndexList(p.leg_keys, keyCount, (v) => onChange({ ...p, leg_keys: v }), `slot-${idx}-path-legs`, "the ordered legs — a code from each key, in this order")}
          <Num label="leg_deadline_s" value={p.leg_deadline_s} help="max seconds between consecutive legs" onChange={(v) => onChange({ ...p, leg_deadline_s: v })} />
          <Num label="delay_max_s" value={p.delay_max_s} help="randomized delay after the final leg" onChange={(v) => onChange({ ...p, delay_max_s: v })} />
        </>
      )}
      {p.type === "deadman" && (
        <Num label="beat_s" value={p.beat_s} min={1} testid={`slot-${idx}-deadman-beat`} help="a valid code must arrive at least this often" onChange={(v) => onChange({ ...p, beat_s: v })} />
      )}
      {p.type === "quorum" && (
        <>
          <Num label="m (required)" value={p.m} min={1} max={16} testid={`slot-${idx}-quorum-m`} help="how many distinct keys must participate" onChange={(v) => onChange({ ...p, m: v })} />
          {keyIndexList(p.keys, keyCount, (v) => onChange({ ...p, keys: v }), `slot-${idx}-quorum-keys`, "the group of eligible keys")}
          <Num label="window_s" value={p.window_s} help="all M codes must land inside this window" onChange={(v) => onChange({ ...p, window_s: v })} />
          <label className="field">
            alternating
            <input type="checkbox" checked={p.alternating} onChange={(e) => onChange({ ...p, alternating: e.target.checked })} />
            <span className="fieldhelp">no key may enter twice in a row</span>
          </label>
        </>
      )}
    </div>
  );
}

function SlotEditor({
  s,
  idx,
  keyCount,
  onChange,
}: {
  s: SlotDef;
  idx: number;
  keyCount: number;
  onChange: (s: SlotDef) => void;
}) {
  const negKind = s.negative.startsWith("lockout:") ? "lockout" : s.negative;
  const lockoutSecs = negKind === "lockout" ? Number(s.negative.split(":")[1] ?? 300) : 300;
  return (
    <div data-testid={`slot-${idx}`}>
      <div className="row">
        <label className="field">
          listens to
          <select data-testid={`slot-${idx}-key`} value={s.key} onChange={(e) => onChange({ ...s, key: Number(e.target.value) })}>
            {Array.from({ length: keyCount }, (_, i) => (
              <option key={i} value={i}>
                key {i}
              </option>
            ))}
          </select>
          <span className="fieldhelp">which key&apos;s codes this ritual accepts</span>
        </label>
        <label className="field">
          on success
          <select data-testid={`slot-${idx}-action`} value={s.action} onChange={(e) => onChange({ ...s, action: e.target.value as any })}>
            <option value="unlock">unlock</option>
            <option value="lock">lock</option>
            <option value="duress">duress unlock</option>
          </select>
          <span className="fieldhelp">{ACTION_HELP[s.action]}</span>
        </label>
      </div>

      <p className="stephint">How must the codes be entered?</p>
      <div className="cards">
        {POLICY_CARDS.map((c) => (
          <button
            key={c.type}
            data-testid={`slot-${idx}-policy-${c.type}`}
            className={`policy-card ${s.policy.type === c.type ? "selected" : ""}`}
            onClick={() => s.policy.type !== c.type && onChange({ ...s, policy: defaultPolicy(c.type) })}
          >
            <strong>{c.title}</strong>
            <span>{c.tagline}</span>
            <em>Use it for: {c.use}</em>
          </button>
        ))}
      </div>
      <PolicyParams p={s.policy} idx={idx} keyCount={keyCount} onChange={(policy) => onChange({ ...s, policy })} />

      <details className="advanced">
        <summary data-testid={`slot-${idx}-adv`}>advanced: wrong-code reaction, feedback, gates</summary>
        <label className="field">
          on wrong code
          <select
            data-testid={`slot-${idx}-negative`}
            value={negKind}
            onChange={(e) => {
              const v = e.target.value;
              onChange({ ...s, negative: v === "lockout" ? `lockout:${lockoutSecs}` : v });
            }}
          >
            <option value="reset">reset progress</option>
            <option value="lockout">lockout</option>
            <option value="silent">silent — no reaction</option>
          </select>
          <span className="fieldhelp">silent gives an observer nothing to learn from</span>
        </label>
        {negKind === "lockout" && (
          <Num label="lockout secs" value={lockoutSecs} testid={`slot-${idx}-lockout`} help="dead time after a wrong code" onChange={(v) => onChange({ ...s, negative: `lockout:${v}` })} />
        )}
        <label className="field">
          progress feedback
          <input type="checkbox" checked={s.progress} onChange={(e) => onChange({ ...s, progress: e.target.checked })} />
          <span className="fieldhelp">show ritual progress on the lock (off = fully blind entry)</span>
        </label>
        <label className="field">
          reset on invalid
          <input type="checkbox" checked={s.reset_on_invalid} onChange={(e) => onChange({ ...s, reset_on_invalid: e.target.checked })} />
          <span className="fieldhelp">any invalid code wipes partial sequence progress</span>
        </label>
        <label className="field">
          fence gate
          <input
            data-testid={`slot-${idx}-fence`}
            type="number"
            min={0}
            placeholder="none"
            value={s.gates.fence ?? ""}
            onChange={(e) => onChange({ ...s, gates: { ...s.gates, fence: e.target.value === "" ? undefined : Number(e.target.value) } })}
          />
          <span className="fieldhelp">the lock itself must sit inside this geofence (portable locks)</span>
        </label>
        <Num label="stillness_s" value={s.gates.stillness_s} help="the lock must have been motionless this long" onChange={(v) => onChange({ ...s, gates: { ...s.gates, stillness_s: v } })} />
        <label className="field">
          calendar gate
          <input
            type="number"
            min={0}
            placeholder="none"
            value={s.gates.calendar ?? ""}
            onChange={(e) => onChange({ ...s, gates: { ...s.gates, calendar: e.target.value === "" ? undefined : Number(e.target.value) } })}
          />
          <span className="fieldhelp">only during this configured time window</span>
        </label>
      </details>
    </div>
  );
}

// ------------------------------------------------------------- review step

function describePolicy(p: Policy): string {
  switch (p.type) {
    case "always":
      return "any single valid code";
    case "sequence":
      return `${p.n} valid codes within ${p.window_s}s, spaced ${p.gap_min_s}–${p.gap_max_s}s apart, then a randomized ${p.delay_min_s}–${p.delay_max_s}s delay`;
    case "path":
      return `codes from keys [${p.leg_keys.join(" → ")}] in order, each leg within ${p.leg_deadline_s}s, then up to ${p.delay_max_s}s delay`;
    case "deadman":
      return `a valid code every ${p.beat_s}s — missing a beat fires the action`;
    case "quorum":
      return `${p.m} distinct keys of [${p.keys.join(", ")}] within ${p.window_s}s${p.alternating ? ", strictly alternating" : ""}`;
  }
}

function describeSlot(s: SlotDef): string {
  const action = s.action === "duress" ? "DURESS-UNLOCK (silent alarm)" : s.action.toUpperCase();
  const parts = [`listening to key ${s.key}: ${describePolicy(s.policy)} → ${action}`];
  const neg =
    s.negative === "reset" ? "wrong code resets progress" : s.negative === "silent" ? "wrong codes are silently ignored" : `wrong code locks out for ${s.negative.split(":")[1]}s`;
  parts.push(neg);
  if (s.gates.fence !== undefined) parts.push(`only inside fence #${s.gates.fence}`);
  if (s.gates.stillness_s > 0) parts.push(`after ${s.gates.stillness_s}s of stillness`);
  if (s.gates.calendar !== undefined) parts.push(`only during calendar window #${s.gates.calendar}`);
  return parts.join("; ");
}

// ------------------------------------------------------------------ wizard

const STEPS = ["Device", "Keys", "Rituals", "Review"];

export default function ConfigEditor({
  cfg,
  onChange,
  onPush,
}: {
  cfg: DeviceConfig;
  onChange: (cfg: DeviceConfig) => void;
  onPush?: () => void;
}) {
  const [step, setStep] = useState(0);
  const [slotIdx, setSlotIdx] = useState(0);
  const setKey = (i: number, k: KeyDef) => onChange({ ...cfg, keys: cfg.keys.map((x, j) => (j === i ? k : x)) });
  const setSlot = (i: number, s: SlotDef) => onChange({ ...cfg, slots: cfg.slots.map((x, j) => (j === i ? s : x)) });
  const selSlot = cfg.slots[Math.min(slotIdx, cfg.slots.length - 1)];

  return (
    <div className="config-editor">
      <nav className="stepper">
        {STEPS.map((name, i) => (
          <button
            key={name}
            data-testid={`step-${name.toLowerCase()}`}
            className={i === step ? "current" : ""}
            onClick={() => setStep(i)}
          >
            {i + 1}. {name}
          </button>
        ))}
      </nav>

      {step === 0 && (
        <div className="step">
          <p className="stephint">
            What is this device? A <strong>generator</strong> mints geofenced codes on its display;
            a <strong>lock-controller</strong> receives codes and drives the physical lock. The
            rituals you define next run on the lock side.
          </p>
          <label className="field">
            role
            <select data-testid="cfg-role" value={cfg.role} onChange={(e) => onChange({ ...cfg, role: Number(e.target.value) as 1 | 2 })}>
              <option value={1}>generator</option>
              <option value={2}>lock-controller</option>
            </select>
          </label>
          <div className="row">
            <button className="primary" onClick={() => setStep(1)}>
              Next: keys →
            </button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="step">
          <p className="stephint">
            Keys are the TOTP secrets. Whoever holds a secret — a generator inside its geofence, or
            an authenticator app you export it to — can mint that key&apos;s codes. The rituals in
            the next step decide what each key&apos;s codes actually do.
          </p>
          {cfg.keys.map((k, i) => (
            <KeyRow key={i} k={k} idx={i} keyCount={cfg.keys.length} onChange={(nk) => setKey(i, nk)} onRemove={() => onChange({ ...cfg, keys: cfg.keys.filter((_, j) => j !== i) })} />
          ))}
          <div className="row">
            <button data-testid="cfg-add-key" onClick={() => onChange({ ...cfg, keys: [...cfg.keys, defaultKey()] })}>
              + add key
            </button>
            <button className="primary" onClick={() => setStep(2)}>
              Next: rituals →
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="step">
          <p className="stephint">
            Each <strong>ritual</strong> (slot) is an independent rule: which key it listens to, how
            its codes must be entered, and what happens on success. Every entered code is tried
            against every ritual — up to 8 run in parallel.
          </p>
          <div className="row slot-tabs">
            {cfg.slots.map((s, i) => (
              <button
                key={i}
                data-testid={`slot-tab-${i}`}
                className={i === slotIdx ? "current" : ""}
                onClick={() => setSlotIdx(i)}
              >
                {i}: {s.policy.type} → {s.action}
              </button>
            ))}
            <button
              data-testid="cfg-add-slot"
              onClick={() => {
                onChange({ ...cfg, slots: [...cfg.slots, defaultSlot()] });
                setSlotIdx(cfg.slots.length);
              }}
            >
              + add ritual
            </button>
            {cfg.slots.length > 1 && (
              <button
                className="danger"
                data-testid="cfg-remove-slot"
                onClick={() => {
                  onChange({ ...cfg, slots: cfg.slots.filter((_, j) => j !== slotIdx) });
                  setSlotIdx(0);
                }}
              >
                remove this ritual
              </button>
            )}
          </div>
          {selSlot && (
            <SlotEditor
              key={Math.min(slotIdx, cfg.slots.length - 1)} // fresh subtree per slot: advanced fold starts closed
              s={selSlot}
              idx={Math.min(slotIdx, cfg.slots.length - 1)}
              keyCount={cfg.keys.length}
              onChange={(ns) => setSlot(Math.min(slotIdx, cfg.slots.length - 1), ns)}
            />
          )}
          <div className="row">
            <button className="primary" onClick={() => setStep(3)}>
              Next: review →
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="step" data-testid="cfg-review">
          <p className="stephint">Read this back like a contract — it is exactly what the device will enforce.</p>
          <p>
            <strong>{cfg.role === 1 ? "Generator" : "Lock-controller"}</strong> with {cfg.keys.length}{" "}
            key(s){cfg.keys.some((k) => k.decoy !== undefined) ? " (incl. decoy twins)" : ""}:
          </p>
          <ol className="review-list">
            {cfg.slots.map((s, i) => (
              <li key={i}>{describeSlot(s)}</li>
            ))}
          </ol>
          {onPush ? (
            <button className="primary" data-testid="cfg-push" onClick={onPush}>
              Seal &amp; push to device
            </button>
          ) : (
            <p className="hint">
              This device isn&apos;t in the roster yet (or the roster isn&apos;t loaded) — enroll it
              and push from the roster row.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

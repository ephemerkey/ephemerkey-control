// Guided config workflow for one device. Four steps — Device, Keys,
// Rituals (slots, one at a time, policy picked from described cards),
// Review & push — writing emulator-exact JSON (lib/config.ts) into the
// source doc as you go. The raw JSON stays visible in the console's
// advanced fold; this is the human path.

import { useState } from "react";
import {
  CalendarWindow,
  defaultCalendar,
  defaultKey,
  defaultPolicy,
  defaultSlot,
  defaultZone,
  DeviceConfig,
  DEFAULT_DISPLAY,
  KeyDef,
  Policy,
  SlotDef,
  Zone,
} from "../lib/config";

const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

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
  const [reveal, setReveal] = useState(false);
  return (
    <fieldset className="editor-row" data-testid={`key-${idx}`}>
      <legend>key {idx}</legend>
      <label className="field">
        secret
        <span className="row">
          <input
            data-testid={`key-${idx}-secret`}
            type={reveal ? "text" : "password"}
            autoComplete="off"
            value={k.secret}
            onChange={(e) => onChange({ ...k, secret: e.target.value })}
          />
          <button
            type="button"
            data-testid={`key-${idx}-reveal`}
            title={reveal ? "hide secret" : "reveal secret"}
            onClick={() => setReveal(!reveal)}
          >
            {reveal ? "hide" : "show"}
          </button>
        </span>
        <span className="fieldhelp">the TOTP seed — masked by default; exportable to authenticator apps</span>
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
  zones,
  calendars,
  onChange,
}: {
  s: SlotDef;
  idx: number;
  keyCount: number;
  zones: Zone[];
  calendars: CalendarWindow[];
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
          zone gate
          <select
            data-testid={`slot-${idx}-fence`}
            value={s.gates.fence ?? ""}
            disabled={zones.length === 0}
            onChange={(e) => onChange({ ...s, gates: { ...s.gates, fence: e.target.value === "" ? undefined : Number(e.target.value) } })}
          >
            <option value="">none</option>
            {zones.map((z, i) => (
              <option key={i} value={i}>
                {z.name}
              </option>
            ))}
          </select>
          <span className="fieldhelp">
            {zones.length === 0
              ? "no zones defined — add one in the Zones & times step"
              : "the lock itself must sit inside this zone (portable locks carry their own GNSS)"}
          </span>
        </label>
        <Num label="stillness_s" value={s.gates.stillness_s} help="the lock must have been motionless this long" onChange={(v) => onChange({ ...s, gates: { ...s.gates, stillness_s: v } })} />
        <label className="field">
          time gate
          <select
            data-testid={`slot-${idx}-calendar`}
            value={s.gates.calendar ?? ""}
            disabled={calendars.length === 0}
            onChange={(e) => onChange({ ...s, gates: { ...s.gates, calendar: e.target.value === "" ? undefined : Number(e.target.value) } })}
          >
            <option value="">none</option>
            {calendars.map((c, i) => (
              <option key={i} value={i}>
                {c.name}
              </option>
            ))}
          </select>
          <span className="fieldhelp">
            {calendars.length === 0
              ? "no time windows defined — add one in the Zones & times step"
              : "this ritual only works during the selected window"}
          </span>
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

function describeSlot(s: SlotDef, zones: Zone[], calendars: CalendarWindow[]): string {
  const action = s.action === "duress" ? "DURESS-UNLOCK (silent alarm)" : s.action.toUpperCase();
  const parts = [`listening to key ${s.key}: ${describePolicy(s.policy)} → ${action}`];
  const neg =
    s.negative === "reset" ? "wrong code resets progress" : s.negative === "silent" ? "wrong codes are silently ignored" : `wrong code locks out for ${s.negative.split(":")[1]}s`;
  parts.push(neg);
  if (s.gates.fence !== undefined) {
    parts.push(`only inside zone '${zones[s.gates.fence]?.name ?? `#${s.gates.fence}`}'`);
  }
  if (s.gates.stillness_s > 0) parts.push(`after ${s.gates.stillness_s}s of stillness`);
  if (s.gates.calendar !== undefined) {
    const w = calendars[s.gates.calendar];
    parts.push(
      w
        ? `only during '${w.name}' (${w.days.map((d) => DAY_LABELS[d]).join("")} ${w.start}–${w.end})`
        : `only during window #${s.gates.calendar}`,
    );
  }
  return parts.join("; ");
}

// ------------------------------------------------------------------ wizard

const STEPS = ["Device", "Keys", "Zones", "Rituals", "Review"];

function ZonesStep({ cfg, onChange }: { cfg: DeviceConfig; onChange: (c: DeviceConfig) => void }) {
  const zones = cfg.zones ?? [];
  const calendars = cfg.calendars ?? [];
  const setZone = (i: number, z: Zone) => onChange({ ...cfg, zones: zones.map((x, j) => (j === i ? z : x)) });
  const setCal = (i: number, c: CalendarWindow) =>
    onChange({ ...cfg, calendars: calendars.map((x, j) => (j === i ? c : x)) });
  return (
    <div className="step">
      <p className="stephint">
        Optional context rituals can require. <strong>Zones</strong> are geofences — a ritual can
        demand the lock itself sits inside one (portable locks carry their own GNSS).{" "}
        <strong>Time windows</strong> restrict when a ritual works at all. Define them here, then
        attach them under a ritual&apos;s <em>advanced gates</em>. Skip this step if you don&apos;t
        need either.
      </p>

      <h4>Zones</h4>
      {zones.map((z, i) => (
        <fieldset className="editor-row" key={i} data-testid={`zone-${i}`}>
          <legend>zone {i}</legend>
          <label className="field">
            name
            <input data-testid={`zone-${i}-name`} value={z.name} onChange={(e) => setZone(i, { ...z, name: e.target.value })} />
          </label>
          <label className="field">
            latitude
            <input data-testid={`zone-${i}-lat`} type="number" step="any" value={z.lat} onChange={(e) => setZone(i, { ...z, lat: Number(e.target.value) })} />
          </label>
          <label className="field">
            longitude
            <input data-testid={`zone-${i}-lon`} type="number" step="any" value={z.lon} onChange={(e) => setZone(i, { ...z, lon: Number(e.target.value) })} />
          </label>
          <Num label="radius_m" value={z.radius_m} min={10} max={65535} testid={`zone-${i}-radius`} help="circle radius in meters" onChange={(v) => setZone(i, { ...z, radius_m: v })} />
          <button className="danger" data-testid={`zone-${i}-remove`} onClick={() => onChange({ ...cfg, zones: zones.filter((_, j) => j !== i) })}>
            remove zone
          </button>
        </fieldset>
      ))}
      <button data-testid="cfg-add-zone" onClick={() => onChange({ ...cfg, zones: [...zones, defaultZone(zones.length)] })}>
        + add zone
      </button>

      <h4>Time windows</h4>
      {calendars.map((c, i) => (
        <fieldset className="editor-row" key={i} data-testid={`cal-${i}`}>
          <legend>window {i}</legend>
          <label className="field">
            name
            <input data-testid={`cal-${i}-name`} value={c.name} onChange={(e) => setCal(i, { ...c, name: e.target.value })} />
          </label>
          <label className="field">
            days
            <span className="row daypick">
              {DAY_LABELS.map((d, di) => (
                <label key={d} className="day">
                  <input
                    type="checkbox"
                    checked={c.days.includes(di)}
                    onChange={(e) =>
                      setCal(i, {
                        ...c,
                        days: e.target.checked ? [...c.days, di].sort() : c.days.filter((x) => x !== di),
                      })
                    }
                  />
                  {d}
                </label>
              ))}
            </span>
          </label>
          <label className="field">
            from
            <input type="time" value={c.start} onChange={(e) => setCal(i, { ...c, start: e.target.value })} />
          </label>
          <label className="field">
            until
            <input type="time" value={c.end} onChange={(e) => setCal(i, { ...c, end: e.target.value })} />
          </label>
          <button className="danger" data-testid={`cal-${i}-remove`} onClick={() => onChange({ ...cfg, calendars: calendars.filter((_, j) => j !== i) })}>
            remove window
          </button>
        </fieldset>
      ))}
      <button data-testid="cfg-add-calendar" onClick={() => onChange({ ...cfg, calendars: [...calendars, defaultCalendar(calendars.length)] })}>
        + add time window
      </button>
    </div>
  );
}

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
              Next: zones &amp; times →
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <>
          <ZonesStep cfg={cfg} onChange={onChange} />
          <div className="row">
            <button className="primary" onClick={() => setStep(3)}>
              Next: rituals →
            </button>
          </div>
        </>
      )}

      {step === 3 && (
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
              zones={cfg.zones ?? []}
              calendars={cfg.calendars ?? []}
              onChange={(ns) => setSlot(Math.min(slotIdx, cfg.slots.length - 1), ns)}
            />
          )}
          <div className="row">
            <button className="primary" onClick={() => setStep(4)}>
              Next: review →
            </button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="step" data-testid="cfg-review">
          <p className="stephint">Read this back like a contract — it is exactly what the device will enforce.</p>
          <p>
            <strong>{cfg.role === 1 ? "Generator" : "Lock-controller"}</strong> with {cfg.keys.length}{" "}
            key(s){cfg.keys.some((k) => k.decoy !== undefined) ? " (incl. decoy twins)" : ""}:
          </p>
          <ol className="review-list">
            {cfg.slots.map((s, i) => (
              <li key={i}>{describeSlot(s, cfg.zones ?? [], cfg.calendars ?? [])}</li>
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

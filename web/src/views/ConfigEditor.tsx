// Structured editor for one device's config: keys (secrets, decoys, display
// ritual) and slots (action, policy state machine, gates, negative action).
// Field-for-field parity with the firmware/emulator schema in lib/config.ts.

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

const POLICY_HELP: Record<Policy["type"], string> = {
  always: "any valid code fires the action (master key)",
  sequence: "n valid codes in a window, with paced gaps and a randomized post-completion delay",
  path: "ordered zone-keyed legs — codes from specific keys in order, each leg within a deadline",
  deadman: "a valid code must arrive every beat_s or the action fires",
  quorum: "m distinct keys out of a named set within a window (two-person rule)",
};

function Num({
  label,
  value,
  onChange,
  min = 0,
  max = 65535,
  testid,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
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
    </label>
  );
}

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
      </label>
      <Num label="digits" value={k.digits} min={4} max={10} testid={`key-${idx}-digits`} onChange={(v) => onChange({ ...k, digits: v })} />
      <button data-testid={`key-${idx}-remove`} className="danger" onClick={onRemove}>
        remove key
      </button>
      <details className="advanced">
        <summary data-testid={`key-${idx}-adv`}>advanced (decoy, display ritual)</summary>
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
          <option value="custom">customized…</option>
        </select>
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
              <option value="plain">plain</option>
              <option value="scatter">scatter (digits out of order)</option>
            </select>
          </label>
          <Num label="dwell_ms" value={d.dwell_ms} onChange={(v) => onChange({ ...k, display: { ...d, dwell_ms: v } })} />
          <Num label="reveal_s" value={d.reveal_s} onChange={(v) => onChange({ ...k, display: { ...d, reveal_s: v } })} />
          <label className="field">
            re-reveal
            <select
              data-testid={`key-${idx}-once`}
              value={d.once}
              onChange={(e) => onChange({ ...k, display: { ...d, once: e.target.value as any } })}
            >
              <option value="unlimited">unlimited</option>
              <option value="refuse">refuse (show once)</option>
              <option value="decoy">poison (decoy after first)</option>
            </select>
          </label>
          <Num label="gap_min_s" value={d.gap_min_s} onChange={(v) => onChange({ ...k, display: { ...d, gap_min_s: v } })} />
        </>
      )}
      </details>
    </fieldset>
  );
}

function keyIndexList(value: number[], keyCount: number, onChange: (v: number[]) => void, testid: string) {
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
    </label>
  );
}

function PolicyEditor({
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
  return (
    <div className="policy" data-testid={`slot-${idx}-policy`}>
      <label className="field">
        policy
        <select
          data-testid={`slot-${idx}-policy-type`}
          value={p.type}
          onChange={(e) => onChange(defaultPolicy(e.target.value as Policy["type"]))}
        >
          {(Object.keys(POLICY_HELP) as Policy["type"][]).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <span className="hint">{POLICY_HELP[p.type]}</span>
      {p.type === "sequence" && (
        <>
          <Num label="n codes" value={p.n} min={1} max={16} testid={`slot-${idx}-seq-n`} onChange={(v) => onChange({ ...p, n: v })} />
          <Num label="window_s" value={p.window_s} testid={`slot-${idx}-seq-window`} onChange={(v) => onChange({ ...p, window_s: v })} />
          <Num label="gap_min_s" value={p.gap_min_s} onChange={(v) => onChange({ ...p, gap_min_s: v })} />
          <Num label="gap_max_s" value={p.gap_max_s} onChange={(v) => onChange({ ...p, gap_max_s: v })} />
          <Num label="delay_min_s" value={p.delay_min_s} onChange={(v) => onChange({ ...p, delay_min_s: v })} />
          <Num label="delay_max_s" value={p.delay_max_s} onChange={(v) => onChange({ ...p, delay_max_s: v })} />
        </>
      )}
      {p.type === "path" && (
        <>
          {keyIndexList(p.leg_keys, keyCount, (v) => onChange({ ...p, leg_keys: v }), `slot-${idx}-path-legs`)}
          <Num label="leg_deadline_s" value={p.leg_deadline_s} onChange={(v) => onChange({ ...p, leg_deadline_s: v })} />
          <Num label="delay_max_s" value={p.delay_max_s} onChange={(v) => onChange({ ...p, delay_max_s: v })} />
        </>
      )}
      {p.type === "deadman" && (
        <Num label="beat_s" value={p.beat_s} min={1} testid={`slot-${idx}-deadman-beat`} onChange={(v) => onChange({ ...p, beat_s: v })} />
      )}
      {p.type === "quorum" && (
        <>
          <Num label="m (required)" value={p.m} min={1} max={16} testid={`slot-${idx}-quorum-m`} onChange={(v) => onChange({ ...p, m: v })} />
          {keyIndexList(p.keys, keyCount, (v) => onChange({ ...p, keys: v }), `slot-${idx}-quorum-keys`)}
          <Num label="window_s" value={p.window_s} onChange={(v) => onChange({ ...p, window_s: v })} />
          <label className="field">
            alternating
            <input
              type="checkbox"
              checked={p.alternating}
              onChange={(e) => onChange({ ...p, alternating: e.target.checked })}
            />
          </label>
        </>
      )}
    </div>
  );
}

function SlotRow({
  s,
  idx,
  keyCount,
  onChange,
  onRemove,
}: {
  s: SlotDef;
  idx: number;
  keyCount: number;
  onChange: (s: SlotDef) => void;
  onRemove: () => void;
}) {
  const negKind = s.negative.startsWith("lockout:") ? "lockout" : s.negative;
  const lockoutSecs = negKind === "lockout" ? Number(s.negative.split(":")[1] ?? 300) : 300;
  return (
    <fieldset className="editor-row" data-testid={`slot-${idx}`}>
      <legend>slot {idx}</legend>
      <label className="field">
        key
        <select
          data-testid={`slot-${idx}-key`}
          value={s.key}
          onChange={(e) => onChange({ ...s, key: Number(e.target.value) })}
        >
          {Array.from({ length: keyCount }, (_, i) => (
            <option key={i} value={i}>
              key {i}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        action
        <select
          data-testid={`slot-${idx}-action`}
          value={s.action}
          onChange={(e) => onChange({ ...s, action: e.target.value as any })}
        >
          <option value="unlock">unlock</option>
          <option value="lock">lock</option>
          <option value="duress">duress-unlock (silent alarm)</option>
        </select>
      </label>
      <PolicyEditor p={s.policy} idx={idx} keyCount={keyCount} onChange={(policy) => onChange({ ...s, policy })} />
      <button data-testid={`slot-${idx}-remove`} className="danger" onClick={onRemove}>
        remove slot
      </button>
      <details className="advanced">
        <summary data-testid={`slot-${idx}-adv`}>advanced (feedback, wrong-code reaction, gates)</summary>
      <label className="field">
        progress feedback
        <input type="checkbox" checked={s.progress} onChange={(e) => onChange({ ...s, progress: e.target.checked })} />
      </label>
      <label className="field">
        reset on invalid
        <input
          type="checkbox"
          checked={s.reset_on_invalid}
          onChange={(e) => onChange({ ...s, reset_on_invalid: e.target.checked })}
        />
      </label>
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
          <option value="silent">silent (no reaction)</option>
        </select>
      </label>
      {negKind === "lockout" && (
        <Num
          label="lockout secs"
          value={lockoutSecs}
          testid={`slot-${idx}-lockout`}
          onChange={(v) => onChange({ ...s, negative: `lockout:${v}` })}
        />
      )}
      <label className="field">
        fence gate
        <input
          data-testid={`slot-${idx}-fence`}
          type="number"
          min={0}
          placeholder="none"
          value={s.gates.fence ?? ""}
          onChange={(e) =>
            onChange({
              ...s,
              gates: { ...s.gates, fence: e.target.value === "" ? undefined : Number(e.target.value) },
            })
          }
        />
      </label>
      <Num
        label="stillness_s"
        value={s.gates.stillness_s}
        onChange={(v) => onChange({ ...s, gates: { ...s.gates, stillness_s: v } })}
      />
      <label className="field">
        calendar gate
        <input
          type="number"
          min={0}
          placeholder="none"
          value={s.gates.calendar ?? ""}
          onChange={(e) =>
            onChange({
              ...s,
              gates: { ...s.gates, calendar: e.target.value === "" ? undefined : Number(e.target.value) },
            })
          }
        />
      </label>
      </details>
    </fieldset>
  );
}

export default function ConfigEditor({
  cfg,
  onChange,
}: {
  cfg: DeviceConfig;
  onChange: (cfg: DeviceConfig) => void;
}) {
  const setKey = (i: number, k: KeyDef) => onChange({ ...cfg, keys: cfg.keys.map((x, j) => (j === i ? k : x)) });
  const setSlot = (i: number, s: SlotDef) => onChange({ ...cfg, slots: cfg.slots.map((x, j) => (j === i ? s : x)) });
  return (
    <div className="config-editor">
      <label className="field">
        role
        <select
          data-testid="cfg-role"
          value={cfg.role}
          onChange={(e) => onChange({ ...cfg, role: Number(e.target.value) as 1 | 2 })}
        >
          <option value={1}>generator</option>
          <option value={2}>lock-controller</option>
        </select>
      </label>

      <h4>Keys</h4>
      {cfg.keys.map((k, i) => (
        <KeyRow
          key={i}
          k={k}
          idx={i}
          keyCount={cfg.keys.length}
          onChange={(nk) => setKey(i, nk)}
          onRemove={() => onChange({ ...cfg, keys: cfg.keys.filter((_, j) => j !== i) })}
        />
      ))}
      <button data-testid="cfg-add-key" onClick={() => onChange({ ...cfg, keys: [...cfg.keys, defaultKey()] })}>
        + add key
      </button>

      <h4>Slots</h4>
      {cfg.slots.map((s, i) => (
        <SlotRow
          key={i}
          s={s}
          idx={i}
          keyCount={cfg.keys.length}
          onChange={(ns) => setSlot(i, ns)}
          onRemove={() => onChange({ ...cfg, slots: cfg.slots.filter((_, j) => j !== i) })}
        />
      ))}
      <button data-testid="cfg-add-slot" onClick={() => onChange({ ...cfg, slots: [...cfg.slots, defaultSlot()] })}>
        + add slot
      </button>
    </div>
  );
}

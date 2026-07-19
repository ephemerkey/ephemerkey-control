// Pool context: the owner key, the roster, and the source doc, with the
// glue that removes button-order dependence — the set registers itself on
// first need, the roster loads itself, the source doc recovers from the
// server on key load and auto-saves (sealed) after edits.

import { createContext, ReactNode, useContext, useEffect, useRef, useState } from "react";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import {
  CTX_REGISTER,
  getSourceBlob,
  putKeywrapBlob,
  putSourceBlob,
  signedGet,
  signedPost,
} from "./lib/api";
import { deriveKx, sealToKx, unsealWithSeed, unwrapKeyfile, wrapKeyfile } from "./lib/backup";
import {
  activeSetId,
  addPoolEncrypted,
  addPoolPlain,
  exportKeyFile,
  generateOwnerKey,
  importKeyFile,
  isEncrypted,
  listPools,
  OwnerKey,
  poolState,
  PoolSummary,
  removePool,
  renamePool,
  setActive,
  setIdFromPub,
  wrappedFor,
} from "./lib/keys";
import { seal, sign1 } from "./lib/cose";
import { configFeatures } from "./lib/config";

const SOURCE_TEMPLATE = JSON.stringify(
  { format: "ekctl-source-v1", devices: {}, notes: "" },
  null,
  2,
);

export type SaveState = "idle" | "saving" | "saved" | "error";

interface Pool {
  key: OwnerKey | null;
  setId: string | null;
  /** True when the active pool is passphrase-wrapped and not yet unlocked. */
  locked: boolean;
  lockedSetId: string | null;
  unlock: (passphrase: string) => Promise<void>;
  pools: PoolSummary[];
  switchPool: (setId: string) => void;
  activeEncrypted: boolean;
  setBrowserPassphrase: (passphrase: string) => void;
  clearBrowserPassphrase: () => void;
  /** Drop the in-memory key now and require the passphrase again. */
  lockNow: () => void;
  renameActive: (name: string) => void;
  adopt: (k: OwnerKey, name?: string) => void;
  /** Remove a specific pool from this browser (server copy is kept). */
  forgetPool: (setId: string) => void;
  /** Adopt a pool from a passphrase-wrapped blob (key QR / server keywrap):
   *  unwrap with the passphrase and keep it encrypted at rest. */
  adoptWrapped: (wrapped: Uint8Array, passphrase: string) => void;
  /** Create a new pool: register it, back the key up to the server under a
   *  passphrase (default), and encrypt browser storage under the same one. */
  createPool: (passphrase: string, name?: string) => Promise<void>;
  /** set_id of a pool just created — triggers the "save your recovery id"
   *  screen until dismissed. */
  justCreated: string | null;
  dismissCreated: () => void;
  forget: () => void;
  roster: any;
  rosterError: string | null;
  refreshRoster: () => Promise<void>;
  source: string;
  setSource: (s: string) => void;
  saveState: SaveState;
  saveNow: () => Promise<void>;
  recoverSource: () => Promise<void>;
  pushDevice: (d: any) => Promise<string>;
  publishAll: () => Promise<{ published: number; skipped: number; errors: string[] }>;
}

const PoolCtx = createContext<Pool | null>(null);

export function usePool(): Pool {
  const p = useContext(PoolCtx);
  if (!p) throw new Error("usePool outside provider");
  return p;
}

export function PoolProvider({ children }: { children: ReactNode }) {
  const initial = poolState();
  const [key, setKey] = useState<OwnerKey | null>(initial.kind === "plain" ? initial.key : null);
  const [locked, setLocked] = useState(initial.kind === "locked");
  const [lockedSetId, setLockedSetId] = useState<string | null>(
    initial.kind === "locked" ? initial.setId : null,
  );
  const [pools, setPools] = useState<PoolSummary[]>(() => listPools());
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const [roster, setRoster] = useState<any>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [source, setSourceState] = useState(SOURCE_TEMPLATE);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const lastSaved = useRef<string | null>(null);
  const sourceRef = useRef(source);
  useEffect(() => {
    sourceRef.current = source;
  });

  const setId = key ? setIdFromPub(key.pub) : null;
  const refreshPools = () => setPools(listPools());

  function setSource(s: string) {
    setSourceState(s);
  }

  function switchPool(target: string) {
    setActive(target);
    const st = poolState(target);
    if (st.kind === "plain") {
      setLocked(false);
      setLockedSetId(null);
      setKey(st.key);
    } else if (st.kind === "locked") {
      setKey(null);
      setLocked(true);
      setLockedSetId(st.setId);
    }
    refreshPools();
  }

  async function unlock(passphrase: string) {
    const id = lockedSetId ?? activeSetId();
    if (!id) throw new Error("no locked pool");
    const wrapped = wrappedFor(id);
    if (!wrapped) throw new Error("pool is not passphrase-protected");
    const restored = importKeyFile(unwrapKeyfile(wrapped, passphrase));
    if (setIdFromPub(restored.pub) !== id) throw new Error("unlocked key does not match this pool");
    setLocked(false);
    setLockedSetId(null);
    setKey(restored);
  }

  function setBrowserPassphrase(passphrase: string) {
    if (!key) return;
    const wrapped = wrapKeyfile(exportKeyFile(key), passphrase);
    addPoolEncrypted(key, wrapped);
    refreshPools();
  }

  /** Immediately re-lock: drop the in-memory key so access needs the
   *  passphrase again, without waiting for a page reload. */
  function lockNow() {
    const id = setId ?? activeSetId();
    if (!id || !isEncrypted(id)) return; // nothing to unlock back with
    setKey(null);
    setLocked(true);
    setLockedSetId(id);
  }

  function clearBrowserPassphrase() {
    if (!key) return;
    addPoolPlain(key);
    refreshPools();
  }

  function renameActive(name: string) {
    if (setId) {
      renamePool(setId, name);
      refreshPools();
    }
  }

  async function ensureRegistered(k: OwnerKey) {
    try {
      await signedPost(k, CTX_REGISTER, "/api/sets", { owner_pub: bytesToHex(k.pub), name: null });
    } catch (e) {
      if (!String(e).includes("already registered")) throw e;
    }
  }

  async function refreshRoster() {
    if (!key || !setId) return;
    try {
      setRoster(await signedGet(key, `/api/sets/${setId}`));
      setRosterError(null);
    } catch (e) {
      if (String(e).includes("not registered")) {
        try {
          await ensureRegistered(key);
          setRoster(await signedGet(key, `/api/sets/${setId}`));
          setRosterError(null);
          return;
        } catch (e2) {
          setRosterError(String(e2));
          return;
        }
      }
      setRosterError(String(e));
    }
  }

  async function saveNow() {
    if (!key || !setId) return;
    const text = sourceRef.current;
    try {
      JSON.parse(text); // never persist broken JSON
    } catch {
      setSaveState("error");
      return;
    }
    setSaveState("saving");
    try {
      const sealed = sealToKx(deriveKx(key.priv).pub, utf8ToBytes(text));
      await putSourceBlob(key, setId, sealed);
      lastSaved.current = text;
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  async function recoverSource() {
    if (!key || !setId) return;
    const sealed = await getSourceBlob(key, setId);
    const text = new TextDecoder().decode(unsealWithSeed(key.priv, sealed));
    lastSaved.current = text;
    setSourceState(text);
    setSaveState("saved");
  }

  // On key load: register + roster + recover the source doc automatically.
  useEffect(() => {
    setRoster(null);
    setRosterError(null);
    setSourceState(SOURCE_TEMPLATE);
    lastSaved.current = null;
    setSaveState("idle");
    if (!key || !setId) return;
    void (async () => {
      await refreshRoster();
      try {
        const sealed = await getSourceBlob(key, setId);
        const text = new TextDecoder().decode(unsealWithSeed(key.priv, sealed));
        // Don't clobber edits the user made while this fetch was in flight:
        // only auto-apply the recovered doc if the local one is still pristine.
        if (sourceRef.current === SOURCE_TEMPLATE) {
          lastSaved.current = text;
          setSourceState(text);
          setSaveState("saved");
        }
      } catch {
        lastSaved.current = sourceRef.current; // nothing stored yet — that's fine
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setId]);

  // Debounced sealed auto-save whenever the source doc changes.
  useEffect(() => {
    if (!key || !setId) return;
    if (source === lastSaved.current || lastSaved.current === null) return;
    try {
      JSON.parse(source);
    } catch {
      return;
    }
    const t = setTimeout(() => void saveNow(), 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, setId]);

  function adopt(k: OwnerKey, name?: string) {
    addPoolPlain(k, name);
    setLocked(false);
    setLockedSetId(null);
    setKey(k);
    refreshPools();
  }

  function adoptWrapped(wrapped: Uint8Array, passphrase: string) {
    const k = importKeyFile(unwrapKeyfile(wrapped, passphrase));
    // Keep it encrypted at rest — we already hold the exact wrapped blob.
    addPoolEncrypted(k, wrapped);
    setActive(setIdFromPub(k.pub));
    setLocked(false);
    setLockedSetId(null);
    setKey(k);
    refreshPools();
  }

  async function createPool(passphrase: string, name?: string) {
    if (passphrase.length < 8) throw new Error("passphrase must be at least 8 characters");
    const k = generateOwnerKey();
    const id = setIdFromPub(k.pub);
    const wrapped = wrapKeyfile(exportKeyFile(k), passphrase);
    // Encrypt browser storage up front (synchronous) and adopt in memory —
    // the key is never at rest in the clear, even for the moment the
    // network backup is in flight.
    addPoolEncrypted(k, wrapped, name);
    setActive(id);
    setLocked(false);
    setLockedSetId(null);
    setKey(k);
    refreshPools();
    // Then register the set and default to a server keywrap backup so the
    // key is recoverable — a pool must not exist only as browser state.
    await ensureRegistered(k);
    await putKeywrapBlob(k, id, wrapped);
    setJustCreated(id); // prompt the manager to save the recovery id
  }

  /** Remove a specific pool from THIS BROWSER only. The server copy (set,
   *  roster, config/event history, sealed source + keywrap backups) is
   *  untouched — the pool is still recoverable with its set_id + passphrase,
   *  keyfile, or key QR. */
  function forgetPool(target: string) {
    const wasCurrent = target === setId || target === lockedSetId;
    const next = removePool(target);
    refreshPools();
    if (wasCurrent) {
      setKey(null);
      setLocked(false);
      setLockedSetId(null);
      if (next) switchPool(next);
    }
  }

  /** Forget the active (or locked) pool from this browser. */
  function forget() {
    const t = setId ?? lockedSetId;
    if (t) forgetPool(t);
  }

  /** Sign1(config, owner-kid) sealed to the device, uploaded at next seq. */
  async function pushDevice(d: any): Promise<string> {
    if (!key || !setId) throw new Error("no key");
    const doc = JSON.parse(sourceRef.current);
    const cfg = doc.devices?.[d.device_id];
    if (!cfg) throw new Error("no config for this device yet — open its policies first");
    const seq = Math.max(d.latest_seq ?? 0, d.acked_seq ?? 0) + 1;
    // Stamp the crit list: the device must understand every named feature
    // or refuse the config (no silent downgrade on old firmware).
    const crit = configFeatures(cfg);
    const payload = crit.length ? { ...cfg, crit } : cfg;
    const inner = sign1(utf8ToBytes(JSON.stringify(payload)), key.pub, key.priv);
    const sealed = seal(inner, hexToBytes(d.kx_pub), seq, hexToBytes(d.device_id));
    await signedPost(key, "ekctl-manager-v1", `/api/sets/${setId}/configs`, {
      device_id: d.device_id,
      seq,
      blob_b64: btoa(String.fromCharCode(...sealed)),
    });
    await saveNow(); // the pushed source is the one worth keeping
    await refreshRoster();
    return `config seq ${seq} sealed & pushed`;
  }

  /** Publish: seal every enrolled device that has a config in the source
   *  doc, upload the artifacts (bumping seq), and back the sealed source up.
   *  The deploy button — one action to get everything onto the server. */
  async function publishAll(): Promise<{ published: number; skipped: number; errors: string[] }> {
    if (!key || !setId) throw new Error("no key");
    await saveNow(); // sealed source backup first — always
    const doc = JSON.parse(sourceRef.current);
    const errors: string[] = [];
    let published = 0;
    let skipped = 0;
    for (const d of roster?.devices ?? []) {
      if (!doc.devices?.[d.device_id]) {
        skipped++;
        continue;
      }
      try {
        await pushDevice(d);
        published++;
      } catch (e) {
        errors.push(`${d.device_id.slice(0, 12)}: ${e}`);
      }
    }
    await refreshRoster();
    return { published, skipped, errors };
  }

  const pool: Pool = {
    key,
    setId,
    locked,
    lockedSetId,
    unlock,
    pools,
    switchPool,
    activeEncrypted: setId ? isEncrypted(setId) : false,
    setBrowserPassphrase,
    clearBrowserPassphrase,
    lockNow,
    renameActive,
    adopt,
    forgetPool,
    adoptWrapped,
    createPool,
    justCreated,
    dismissCreated: () => setJustCreated(null),
    forget,
    roster,
    rosterError,
    refreshRoster,
    source,
    setSource,
    saveState,
    saveNow,
    recoverSource,
    pushDevice,
    publishAll,
  };
  return <PoolCtx.Provider value={pool}>{children}</PoolCtx.Provider>;
}

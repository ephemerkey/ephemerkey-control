// Pool context: the owner key, the roster, and the source doc, with the
// glue that removes button-order dependence — the set registers itself on
// first need, the roster loads itself, the source doc recovers from the
// server on key load and auto-saves (sealed) after edits.

import { createContext, ReactNode, useContext, useEffect, useRef, useState } from "react";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { CTX_REGISTER, getSourceBlob, putSourceBlob, signedGet, signedPost } from "./lib/api";
import { deriveKx, sealToKx, unsealWithSeed } from "./lib/backup";
import { forgetOwnerKey, loadOwnerKey, OwnerKey, saveOwnerKey, setIdFromPub } from "./lib/keys";
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
  adopt: (k: OwnerKey) => void;
  forget: () => void;
  roster: any | null;
  rosterError: string | null;
  refreshRoster: () => Promise<void>;
  source: string;
  setSource: (s: string) => void;
  saveState: SaveState;
  saveNow: () => Promise<void>;
  recoverSource: () => Promise<void>;
  pushDevice: (d: any) => Promise<string>;
}

const PoolCtx = createContext<Pool | null>(null);

export function usePool(): Pool {
  const p = useContext(PoolCtx);
  if (!p) throw new Error("usePool outside provider");
  return p;
}

export function PoolProvider({ children }: { children: ReactNode }) {
  const [key, setKey] = useState<OwnerKey | null>(() => loadOwnerKey());
  const [roster, setRoster] = useState<any | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [source, setSourceState] = useState(SOURCE_TEMPLATE);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const lastSaved = useRef<string | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const setId = key ? setIdFromPub(key.pub) : null;

  function setSource(s: string) {
    setSourceState(s);
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
        await recoverSource();
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

  function adopt(k: OwnerKey) {
    saveOwnerKey(k);
    setKey(k);
  }

  function forget() {
    forgetOwnerKey();
    setKey(null);
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

  const pool: Pool = {
    key,
    setId,
    adopt,
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
  };
  return <PoolCtx.Provider value={pool}>{children}</PoolCtx.Provider>;
}

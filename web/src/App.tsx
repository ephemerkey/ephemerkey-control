import { Link, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { PoolProvider, usePool } from "./state";
import AddDevice from "./views/AddDevice";
import Backup from "./views/Backup";
import Authenticator from "./views/Authenticator";
import DeviceDetail from "./views/DeviceDetail";
import Devices from "./views/Devices";
import Landing from "./views/Landing";
import Push from "./views/Push";
import Unlock from "./views/Unlock";
import Welcome from "./views/Welcome";

const SAVE_LABEL: Record<string, string> = {
  idle: "",
  saving: "saving…",
  saved: "saved ✓",
  error: "save failed",
};

function PoolSwitcher() {
  const pool = usePool();
  if (pool.pools.length <= 1) return null;
  return (
    <select
      data-testid="pool-switcher"
      className="pool-switcher"
      value={pool.setId ?? pool.lockedSetId ?? ""}
      onChange={(e) => pool.switchPool(e.target.value)}
    >
      {pool.pools.map((p) => (
        <option key={p.setId} value={p.setId}>
          {p.encrypted ? "🔒 " : ""}
          {p.name || p.setId.slice(0, 10)}
        </option>
      ))}
    </select>
  );
}

function ManagerArea() {
  const pool = usePool();
  if (pool.locked) return <Unlock />;
  if (!pool.key) return <Welcome />;
  return (
    <div className="layout">
      <aside>
        <div className="poolinfo">
          <span className="hint">pool {pool.activeEncrypted ? "🔒" : ""}</span>
          <code data-testid="set-id">{pool.setId}</code>
          <PoolSwitcher />
          <NavLink to="/pools" data-testid="nav-pools" className="hint">
            + add / manage pools
          </NavLink>
          <span className={`savenote ${pool.saveState}`}>{SAVE_LABEL[pool.saveState]}</span>
        </div>
        <NavLink to="/devices" data-testid="nav-devices">
          Devices
        </NavLink>
        <NavLink to="/devices/add" data-testid="nav-add">
          Add device
        </NavLink>
        <NavLink to="/backup" data-testid="nav-backup">
          Backup &amp; keys
        </NavLink>
        <NavLink to="/push" data-testid="nav-push">
          Courier page
        </NavLink>
        <Link to="/" className="hint" data-testid="nav-home">
          ← landing
        </Link>
      </aside>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/devices" replace />} />
          <Route path="/devices" element={<Devices />} />
          <Route path="/devices/add" element={<AddDevice />} />
          <Route path="/device/:id" element={<DeviceDetail />} />
          <Route path="/authenticator/:id" element={<Authenticator />} />
          <Route path="/backup" element={<Backup />} />
          <Route path="/pools" element={<Welcome manage />} />
          <Route path="*" element={<Navigate to="/devices" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <PoolProvider>
      <div className="app">
        <header>
          <Link to="/" className="apptitle">
            <h1>ephemerkey control</h1>
          </Link>
        </header>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/push" element={<Push />} />
          <Route path="/*" element={<ManagerArea />} />
        </Routes>
      </div>
    </PoolProvider>
  );
}

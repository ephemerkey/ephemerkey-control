import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { PoolProvider, usePool } from "./state";
import AddDevice from "./views/AddDevice";
import Backup from "./views/Backup";
import Authenticator from "./views/Authenticator";
import DeviceDetail from "./views/DeviceDetail";
import Devices from "./views/Devices";
import Push from "./views/Push";
import Welcome from "./views/Welcome";

const SAVE_LABEL: Record<string, string> = {
  idle: "",
  saving: "saving…",
  saved: "saved ✓",
  error: "save failed",
};

function ManagerArea() {
  const pool = usePool();
  if (!pool.key) return <Welcome />;
  return (
    <div className="layout">
      <aside>
        <div className="poolinfo">
          <span className="hint">pool</span>
          <code data-testid="set-id">{pool.setId}</code>
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
      </aside>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/devices" replace />} />
          <Route path="/devices" element={<Devices />} />
          <Route path="/devices/add" element={<AddDevice />} />
          <Route path="/device/:id" element={<DeviceDetail />} />
          <Route path="/authenticator/:id" element={<Authenticator />} />
          <Route path="/backup" element={<Backup />} />
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
          <h1>ephemerkey control</h1>
        </header>
        <Routes>
          <Route path="/push" element={<Push />} />
          <Route path="/*" element={<ManagerArea />} />
        </Routes>
      </div>
    </PoolProvider>
  );
}

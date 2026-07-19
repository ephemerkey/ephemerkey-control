import { Link, Route, Routes } from "react-router-dom";
import Console from "./views/Console";
import Push from "./views/Push";

export default function App() {
  return (
    <div className="app">
      <header>
        <h1>ephemerkey control</h1>
        <nav>
          <Link to="/">Console</Link>
          <Link to="/push">Push update</Link>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Console />} />
          <Route path="/push" element={<Push />} />
        </Routes>
      </main>
    </div>
  );
}

// Top-level chooser. The app is modal between two unrelated jobs: managing
// pools (needs your owner key) and programming a device you're physically
// holding (needs nothing). Both launch from here.

import { Link } from "react-router-dom";
import { usePool } from "../state";

export default function Landing() {
  const pool = usePool();
  const poolCount = pool.pools.length;

  return (
    <section className="welcome landing">
      <h2>ephemerkey control</h2>
      <p className="stephint">What are you here to do?</p>

      <Link to="/devices" className="landing-card" data-testid="landing-manage">
        <h3>🔑 Manage pools</h3>
        <p>
          Configure and control your ephemerkey devices — enroll them, author unlock rituals, seal
          and publish configs. Needs your owner key (held in this browser).
        </p>
        <span className="hint">
          {poolCount === 0
            ? "no pool on this browser yet — you'll create or import one"
            : `${poolCount} pool${poolCount > 1 ? "s" : ""} on this browser`}
        </span>
      </Link>

      <Link to="/push" className="landing-card" data-testid="landing-program">
        <h3>📲 Program a device</h3>
        <p>
          Hold an ephemerkey in provisioning mode and deliver its pending update over WebSerial. No
          account, no key — you ferry a sealed blob you can&apos;t read; the device verifies it.
        </p>
        <span className="hint">for couriers and field techs</span>
      </Link>
    </section>
  );
}

// Map picker for a zone: click to place the center, see the geofence
// radius as a live circle, drag the slider (log scale, 10 m – 10 km) or
// type an exact radius. Leaflet + OSM tiles; vector-only overlays (no
// marker images to trip over bundling).

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Zone } from "../lib/config";

function fmtRadius(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km` : `${m} m`;
}

// slider 0..100 ↔ radius 10 m .. 10 km (log scale)
const sliderToRadius = (v: number) => Math.round(10 ** (1 + v * 0.03));
const radiusToSlider = (r: number) => Math.min(100, Math.max(0, Math.round((Math.log10(Math.max(10, r)) - 1) / 0.03)));

export default function ZoneMap({
  zone,
  idx,
  onChange,
}: {
  zone: Zone;
  idx: number;
  onChange: (z: Zone) => void;
}) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const circleRef = useRef<L.Circle | null>(null);
  const dotRef = useRef<L.CircleMarker | null>(null);
  const zoneRef = useRef(zone);
  zoneRef.current = zone;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!divRef.current || mapRef.current) return;
    const hasFix = zone.lat !== 0 || zone.lon !== 0;
    const map = L.map(divRef.current).setView(hasFix ? [zone.lat, zone.lon] : [30, 0], hasFix ? 15 : 2);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);
    map.on("click", (e: L.LeafletMouseEvent) => {
      onChangeRef.current({
        ...zoneRef.current,
        lat: +e.latlng.lat.toFixed(6),
        lon: +((((e.latlng.lng + 180) % 360) + 360) % 360 - 180).toFixed(6),
      });
    });
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 0);
    return () => {
      map.remove();
      mapRef.current = null;
      circleRef.current = null;
      dotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the center dot + radius circle in sync with the zone.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    circleRef.current?.remove();
    dotRef.current?.remove();
    circleRef.current = null;
    dotRef.current = null;
    if (zone.lat === 0 && zone.lon === 0) return; // not placed yet
    dotRef.current = L.circleMarker([zone.lat, zone.lon], {
      radius: 4,
      color: "#4f7cac",
      fillOpacity: 1,
    }).addTo(map);
    circleRef.current = L.circle([zone.lat, zone.lon], {
      radius: zone.radius_m,
      color: "#4f7cac",
      fillOpacity: 0.12,
    }).addTo(map);
  }, [zone.lat, zone.lon, zone.radius_m]);

  function locate() {
    navigator.geolocation?.getCurrentPosition((p) => {
      const lat = +p.coords.latitude.toFixed(6);
      const lon = +p.coords.longitude.toFixed(6);
      onChangeRef.current({ ...zoneRef.current, lat, lon });
      mapRef.current?.setView([lat, lon], 16);
    });
  }

  return (
    <div className="zonemap">
      <div ref={divRef} className="zonemap-canvas" data-testid={`zone-${idx}-map`} />
      <div className="row">
        <label className="field radius-slider">
          radius: {fmtRadius(zone.radius_m)}
          <input
            data-testid={`zone-${idx}-radius-slider`}
            type="range"
            min={0}
            max={100}
            value={radiusToSlider(zone.radius_m)}
            onChange={(e) => onChange({ ...zone, radius_m: sliderToRadius(Number(e.target.value)) })}
          />
        </label>
        <button type="button" data-testid={`zone-${idx}-locate`} onClick={locate}>
          use my location
        </button>
        {zone.lat === 0 && zone.lon === 0 && <span className="hint">click the map to place the zone</span>}
      </div>
    </div>
  );
}

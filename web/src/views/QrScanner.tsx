// QR capture in the browser: live camera (getUserMedia + jsQR per frame)
// with an image-upload fallback. Live scanning needs a secure context
// (localhost or https) and camera permission; the upload path works
// anywhere and also lets a phone photo of a printout be decoded.
//
// Lazy-loaded by callers (React.lazy) so jsQR stays out of the initial
// bundle — it only downloads when someone actually scans.

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { decodeQrImage } from "../lib/qr";

export default function QrScanner({
  onResult,
  label = "Scan QR",
}: {
  onResult: (text: string) => void;
  label?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef(0);
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState("");

  function stop() {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  }
  useEffect(() => () => stop(), []);

  async function start() {
    setErr("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      streamRef.current = stream;
      setScanning(true);
      const v = videoRef.current!;
      v.srcObject = stream;
      await v.play();
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;
      const tick = () => {
        if (!streamRef.current) return;
        if (v.readyState === v.HAVE_ENOUGH_DATA && v.videoWidth) {
          canvas.width = v.videoWidth;
          canvas.height = v.videoHeight;
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height);
          if (code) {
            stop();
            onResult(code.data);
            return;
          }
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      setScanning(false);
      setErr(`camera unavailable (${e}) — use the photo upload instead`);
    }
  }

  async function upload(file: File) {
    setErr("");
    try {
      onResult(await decodeQrImage(file));
    } catch (e) {
      setErr(String(e));
    }
  }

  return (
    <div className="qrscanner">
      <div className="row">
        {scanning ? (
          <button data-testid="scan-stop" onClick={stop}>
            Stop camera
          </button>
        ) : (
          <button data-testid="scan-start" onClick={() => void start()}>
            📷 {label} (camera)
          </button>
        )}
        <label className="filebtn">
          …or upload a photo
          <input
            data-testid="scan-upload"
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
          />
        </label>
      </div>
      <video ref={videoRef} className="qr-video" style={{ display: scanning ? "block" : "none" }} muted playsInline />
      {err && <p className="inline-status err">{err}</p>}
    </div>
  );
}

// Playwright fixture: impersonate navigator.serial with a SerialPort whose
// bytes flow over a node-side TCP socket to `ekemu serial`. The page code
// runs unmodified — it sees a serial port that happens to be an emulator.
// (Production needs none of this: WebSerial talks straight to USB-CDC.)

import type { Page } from "@playwright/test";
import net from "node:net";

export async function installMockSerial(
  page: Page,
  addr: { host: string; port: number },
): Promise<() => void> {
  const sock = net.connect(addr);
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });

  await page.exposeFunction("__ekTcpWrite", (b64: string) => {
    sock.write(Buffer.from(b64, "base64"));
  });
  sock.on("data", (chunk) => {
    page.evaluate((b64) => (window as any).__ekTcpRecv?.(b64), chunk.toString("base64")).catch(() => {});
  });

  await page.addInitScript(() => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    (window as any).__ekTcpRecv = (b64: string) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      controller.enqueue(arr);
    };
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        let s = "";
        for (const b of chunk) s += String.fromCharCode(b);
        return (window as any).__ekTcpWrite(btoa(s));
      },
    });
    const port = {
      open: async () => {},
      close: async () => {},
      readable,
      writable,
    };
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: {
        requestPort: async () => port,
        getPorts: async () => [port],
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
  });

  return () => sock.destroy();
}

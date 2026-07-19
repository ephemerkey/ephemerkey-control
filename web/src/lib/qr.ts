// Decode a QR from an uploaded image (a photo/scan of a printed recovery
// card). Encoding is done with the `qrcode` lib elsewhere; this is the
// reverse for the import path.

import jsQR from "jsqr";

export async function decodeQrImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("could not load image"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas context");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(data.data, data.width, data.height);
    if (!code) throw new Error("no QR code found in the image");
    return code.data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

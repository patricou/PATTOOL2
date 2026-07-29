/** Plain text only; falls back to execCommand when Clipboard API is missing or rejects. */
export function copyPlainTextToClipboard(text: string): void {
  const t = typeof text === 'string' ? text : '';
  if (!t) {
    return;
  }
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(t).catch(() => copyPlainTextFallback(t));
    return;
  }
  copyPlainTextFallback(t);
}

function copyPlainTextFallback(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(ta);
  }
}

/** Re-encode any image blob as PNG (ClipboardItem typically requires image/png). */
export function encodeBlobAsPng(blob: Blob): Promise<Blob | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const cleanup = (): void => URL.revokeObjectURL(url);
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width || 1;
        canvas.height = img.naturalHeight || img.height || 1;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          cleanup();
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((out) => {
          cleanup();
          resolve(out);
        }, 'image/png');
      } catch {
        cleanup();
        resolve(null);
      }
    };
    img.onerror = () => {
      cleanup();
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * Copy an image to the system clipboard (PNG). Used for desktop WhatsApp Web
 * where {@code wa.me} cannot attach files — user pastes with Ctrl+V.
 */
export async function copyImageBlobToClipboard(blob: Blob): Promise<boolean> {
  if (!blob || blob.size <= 0) {
    return false;
  }
  let pngBlob = blob.type === 'image/png' ? blob : await encodeBlobAsPng(blob);
  if (!pngBlob || pngBlob.size <= 0) {
    return false;
  }
  const win = window as Window & {
    ClipboardItem?: new (items: Record<string, Blob | Promise<Blob>>) => ClipboardItem;
  };
  if (!navigator.clipboard?.write || typeof win.ClipboardItem !== 'function') {
    return false;
  }
  try {
    await navigator.clipboard.write([new win.ClipboardItem!({ 'image/png': pngBlob })]);
    return true;
  } catch {
    return false;
  }
}

/** True on phones/tablets where Web Share with files is usually reliable. */
export function preferNativeFileShare(): boolean {
  const ua = navigator.userAgent;
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
    return true;
  }
  return navigator.maxTouchPoints > 1 && /Macintosh|MacIntel/i.test(ua);
}

import {
  copyImageBlobToClipboard,
  copyPlainTextToClipboard,
  preferNativeFileShare
} from './clipboard-copy';

export type WhatsAppImageShareOutcome =
  | 'shared'
  | 'cancel'
  | 'desktop-paste'
  | 'download-fallback'
  | 'text-only';

function openWhatsAppText(message: string): void {
  const text = (message || '').trim();
  // api.whatsapp.com is more reliable on smartphones; wa.me is fine for desktop Web.
  const url = preferNativeFileShare()
    ? `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`
    : `https://wa.me/?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function downloadBlob(blob: Blob, fileName: string): void {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch {
    // ignore
  }
}

async function invokeShare(
  data: ShareData & { files?: File[] }
): Promise<'ok' | 'cancel' | 'fail'> {
  const nav = navigator as Navigator & {
    share?: (d: ShareData & { files?: File[] }) => Promise<void>;
  };
  if (typeof nav.share !== 'function') {
    return 'fail';
  }
  try {
    await nav.share(data);
    return 'ok';
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') {
      return 'cancel';
    }
    return 'fail';
  }
}

/**
 * Share an activity photo + caption on WhatsApp.
 *
 * Smartphone: system share sheet (pick WhatsApp). Caption is also copied because
 * WhatsApp often drops ShareData.text when files are present.
 * Desktop: copy image to clipboard + open WhatsApp Web with text (Ctrl+V to paste photo).
 */
export async function shareActivityImageOnWhatsApp(opts: {
  imageBlob: Blob;
  title: string;
  message: string;
}): Promise<WhatsAppImageShareOutcome> {
  const { imageBlob, title, message } = opts;
  if (!imageBlob || imageBlob.size <= 0) {
    openWhatsAppText(message);
    return 'text-only';
  }

  let extension = 'jpg';
  const mime = imageBlob.type || 'image/jpeg';
  if (mime.includes('png')) extension = 'png';
  else if (mime.includes('gif')) extension = 'gif';
  else if (mime.includes('webp')) extension = 'webp';

  const file = new File([imageBlob], `event-image.${extension}`, {
    type: mime,
    lastModified: Date.now()
  });
  const isMobile = preferNativeFileShare();

  if (isMobile && typeof (navigator as Navigator & { share?: unknown }).share === 'function') {
    // WhatsApp frequently ignores text when files are attached — keep caption in clipboard.
    if (message.trim()) {
      copyPlainTextToClipboard(message);
    }

    // Order matters on Android/iOS: files-first is the most reliable for WhatsApp.
    const attempts: Array<ShareData & { files?: File[] }> = [
      { files: [file] },
      { title, files: [file] },
      { title, text: message, files: [file] }
    ];

    for (const data of attempts) {
      const out = await invokeShare(data);
      if (out === 'ok') {
        return 'shared';
      }
      if (out === 'cancel') {
        return 'cancel';
      }
    }

    // Share sheet unavailable / failed: open WhatsApp with text; photo already in clipboard when possible.
    const copied = await copyImageBlobToClipboard(imageBlob);
    openWhatsAppText(message);
    return copied ? 'desktop-paste' : 'text-only';
  }

  // Desktop / WhatsApp Web: wa.me cannot attach files.
  const copied = await copyImageBlobToClipboard(imageBlob);
  if (copied) {
    openWhatsAppText(message);
    return 'desktop-paste';
  }

  downloadBlob(imageBlob, `event-image.${extension}`);
  openWhatsAppText(message);
  return 'download-fallback';
}

export function whatsappShareInfoI18nKey(): string {
  return preferNativeFileShare()
    ? 'EVENTELEM.WHATSAPP_SHARE_INFO_MOBILE'
    : 'EVENTELEM.WHATSAPP_SHARE_INFO_DESKTOP';
}

export function whatsappShareOutcomeHintKey(
  outcome: WhatsAppImageShareOutcome
): string | null {
  switch (outcome) {
    case 'shared':
      return preferNativeFileShare()
        ? 'EVENTELEM.WHATSAPP_IMAGE_MOBILE_CAPTION_HINT'
        : null;
    case 'desktop-paste':
      return preferNativeFileShare()
        ? 'EVENTELEM.WHATSAPP_IMAGE_MOBILE_PASTE_HINT'
        : 'EVENTELEM.WHATSAPP_IMAGE_PASTE_HINT';
    case 'download-fallback':
      return 'EVENTELEM.WHATSAPP_IMAGE_DOWNLOAD_HINT';
    case 'text-only':
      return preferNativeFileShare()
        ? 'EVENTELEM.WHATSAPP_IMAGE_MOBILE_TEXT_ONLY_HINT'
        : 'EVENTELEM.WHATSAPP_IMAGE_DOWNLOAD_HINT';
    default:
      return null;
  }
}

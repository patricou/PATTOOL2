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

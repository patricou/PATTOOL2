from pathlib import Path

p = Path(r"c:\Dev\PATTOOL2\PatTool_Front-End\src\app\world-globe\world-globe.component.ts")
text = p.read_text(encoding="utf-8")


def cut_between(src: str, start: str, end: str) -> str:
    i = src.find(start)
    j = src.find(end)
    if i < 0 or j < 0 or j <= i:
        raise SystemExit(f"marker fail start={i} end={j} for {start[:50]!r} -> {end[:50]!r}")
    return src[:i] + src[j:]


text = cut_between(
    text,
    "  /** Capture d'écran du globe puis envoi manuel sur WhatsApp (téléchargement + WhatsApp Web).\n",
    "  private resolveIssPiPCapture(\n",
)
text = cut_between(
    text,
    "  private buildIssPiPWhatsAppMessage(variant: 'standard' | 'hd'): string {\n",
    "  private isIssPiPVisibleForCapture(panel: HTMLElement): boolean {\n",
)

flash = """  private flashIssPiPWhatsAppFeedback(variant: 'standard' | 'hd', ok: boolean): void {
    if (this.issPiPWhatsAppFlashTimer != null) {
      clearTimeout(this.issPiPWhatsAppFlashTimer);
    }
    this.issPiPWhatsAppFlash = { variant, ok };
    this.cdr.markForCheck();
    this.issPiPWhatsAppFlashTimer = setTimeout(() => {
      this.issPiPWhatsAppFlash = null;
      this.issPiPWhatsAppFlashTimer = null;
      this.cdr.markForCheck();
    }, 2200);
  }

"""
if flash not in text:
    raise SystemExit("flashIssPiPWhatsAppFeedback block not found")
text = text.replace(flash, "", 1)

old = """      if (WorldGlobeComponent.isGlobeShareUserCancel(err)) {
        throw err;
      }"""
new = """      const cancelName = err instanceof DOMException || err instanceof Error ? err.name : '';
      if (cancelName === 'AbortError' || cancelName === 'NotAllowedError') {
        throw err;
      }"""
if old not in text:
    raise SystemExit("isGlobeShareUserCancel usage not found")
text = text.replace(old, new, 1)

p.write_text(text, encoding="utf-8")
print("ok", len(text.splitlines()), "lines")

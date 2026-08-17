export const CAM_HEIGHT_MIN_PX = 160;

export function clampCamHeightPx(px: number): number {
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const max = Math.max(CAM_HEIGHT_MIN_PX, Math.min(760, Math.round(vh * 0.82)));
  return Math.round(Math.min(max, Math.max(CAM_HEIGHT_MIN_PX, px)));
}

export function loadCamHeightPx(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null || raw === '') {
      return null;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? clampCamHeightPx(n) : null;
  } catch {
    return null;
  }
}

export function saveCamHeightPx(key: string, px: number | null): void {
  try {
    if (px == null) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, String(clampCamHeightPx(px)));
  } catch {
    /* ignore */
  }
}

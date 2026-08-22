const ACTIVE_KEY = 'pat.direction.cible.active-id.v1';

/** Cap relatif à la cible : 0° = téléphone pointé comme au dernier calage. */
export function headingRelativeToCible(phoneHeadingDeg: number, lockedHeadingDeg: number): number {
  const d = ((phoneHeadingDeg - lockedHeadingDeg) % 360) + 360;
  return d % 360;
}

export function loadActiveCibleId(): string | null {
  try {
    const id = localStorage.getItem(ACTIVE_KEY);
    return id && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

export function saveActiveCibleId(id: string | null): void {
  try {
    if (!id) {
      localStorage.removeItem(ACTIVE_KEY);
      return;
    }
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* ignore */
  }
}

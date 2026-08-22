import { haversineM, initialBearingDeg, normalizeDeg } from './direction-attitude';

const ACTIVE_KEY = 'pat.direction.cible.active-id.v1';

/** En dessous, l’azimut GPS du repère est trop sensible à l’erreur de position. */
export const CIBLE_MARK_MIN_DIST_M = 80;

export function geocodeDisplayName(
  res: { display_name?: string; displayName?: string } | null | undefined
): string | null {
  const name = String(res?.display_name || res?.displayName || '').trim();
  return name || null;
}

export function hasCibleMark(
  markLat?: number | null,
  markLon?: number | null
): boolean {
  return markLat != null && markLon != null && Number.isFinite(markLat) && Number.isFinite(markLon);
}

export function cibleMarkDistanceM(
  userLat?: number | null,
  userLon?: number | null,
  markLat?: number | null,
  markLon?: number | null
): number | null {
  if (userLat == null || userLon == null || markLat == null || markLon == null) {
    return null;
  }
  if (![userLat, userLon, markLat, markLon].every(Number.isFinite)) {
    return null;
  }
  return haversineM(userLat, userLon, markLat, markLon);
}

/** Azimut géographique (toi → repère). */
export function cibleMarkBearingDeg(
  userLat?: number | null,
  userLon?: number | null,
  markLat?: number | null,
  markLon?: number | null
): number | null {
  if (userLat == null || userLon == null || markLat == null || markLon == null) {
    return null;
  }
  if (![userLat, userLon, markLat, markLon].every(Number.isFinite)) {
    return null;
  }
  return initialBearingDeg(userLat, userLon, markLat, markLon);
}

export function cibleImpliedGeoHeadingDeg(
  rawHeadingDeg: number,
  lockedHeadingDeg: number,
  refAzimuthDeg: number
): number {
  return normalizeDeg(rawHeadingDeg - lockedHeadingDeg + refAzimuthDeg);
}

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

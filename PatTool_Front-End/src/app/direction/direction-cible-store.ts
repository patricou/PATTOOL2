import { circularDiff, haversineM, initialBearingDeg, normalizeDeg } from './direction-attitude';

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

/**
 * Cap magnétomètre attendu quand on vise le repère.
 * Même référentiel que le disque de la rose (pas l’azimut GPS).
 * Si le GPS du repère a changé depuis le calage, on décale h0 d’autant.
 */
export function cibleSensorHeadingFacingMark(
  lockedMagHeadingDeg: number,
  lockedRefAzimuthDeg: number | null | undefined,
  liveMarkBearingDeg: number | null | undefined
): number {
  if (
    lockedRefAzimuthDeg == null ||
    liveMarkBearingDeg == null ||
    !Number.isFinite(lockedRefAzimuthDeg) ||
    !Number.isFinite(liveMarkBearingDeg)
  ) {
    return normalizeDeg(lockedMagHeadingDeg);
  }
  return normalizeDeg(lockedMagHeadingDeg + (liveMarkBearingDeg - lockedRefAzimuthDeg));
}

/** Écart live ↔ orientation attendue face au repère (gisement GPS à jour). */
export function cibleLockDeltaDeg(
  liveRawDeg?: number | null,
  lockedMagHeadingDeg?: number | null,
  lockedRefAzimuthDeg?: number | null,
  liveMarkBearingDeg?: number | null
): number | null {
  if (liveRawDeg == null || lockedMagHeadingDeg == null) {
    return null;
  }
  if (!Number.isFinite(liveRawDeg) || !Number.isFinite(lockedMagHeadingDeg)) {
    return null;
  }
  const facing = cibleSensorHeadingFacingMark(
    lockedMagHeadingDeg,
    lockedRefAzimuthDeg,
    liveMarkBearingDeg
  );
  return circularDiff(liveRawDeg, facing);
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

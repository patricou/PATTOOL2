export const GPS_HANDOFF_KEY = 'pattool.gps.handoff';

export interface GpsHandoffPoint {
  lat: number;
  lon: number;
  eleM?: number | null;
}

export interface GpsHandoffPayload {
  title?: string;
  fileName?: string;
  fileId?: string;
  points: GpsHandoffPoint[];
}

export function writeGpsHandoff(payload: GpsHandoffPayload): void {
  if (typeof sessionStorage === 'undefined') {
    return;
  }
  try {
    sessionStorage.setItem(GPS_HANDOFF_KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode */
  }
}

export function readGpsHandoff(): GpsHandoffPayload | null {
  if (typeof sessionStorage === 'undefined') {
    return null;
  }
  try {
    const raw = sessionStorage.getItem(GPS_HANDOFF_KEY);
    if (!raw) {
      return null;
    }
    sessionStorage.removeItem(GPS_HANDOFF_KEY);
    const parsed = JSON.parse(raw) as GpsHandoffPayload;
    if (!parsed || !Array.isArray(parsed.points) || parsed.points.length < 2) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

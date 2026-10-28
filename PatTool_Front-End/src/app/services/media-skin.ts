/** Cabinet style shared by the TV, radio and Deezer pages. */

export const MEDIA_SKIN_FEATURE = 'media.skin';

const LEGACY_MEDIA_SKIN_FEATURES = new Set(['tv.skin', 'radio.skin', 'deezer.skin']);

export interface MediaSkinParameterRow {
  paramKey: string;
  featureKey?: string;
  paramValue?: string;
  valueType?: string;
  description?: string;
  dateModification?: string;
  ownerKey?: string;
}

/** One account row for the shared skin. Older per-page rows are folded into it. */
export function collapseMediaSkinParameters<T extends MediaSkinParameterRow>(rows: T[]): T[] {
  const legacy: T[] = [];
  const rest: T[] = [];
  for (const row of rows || []) {
    const feature = (row.featureKey || '').trim().toLowerCase();
    if (LEGACY_MEDIA_SKIN_FEATURES.has(feature)) {
      legacy.push(row);
    } else {
      rest.push(row);
    }
  }
  if (!legacy.length) {
    return rest;
  }
  const newest = legacy.reduce((best, row) => {
    const bestTime = Date.parse(best.dateModification || '') || 0;
    const rowTime = Date.parse(row.dateModification || '') || 0;
    return rowTime >= bestTime ? row : best;
  });
  const mediaIndex = rest.findIndex((row) => (row.featureKey || '').trim().toLowerCase() === MEDIA_SKIN_FEATURE);
  const stored = mediaIndex >= 0 && !!(rest[mediaIndex].paramValue || '').trim();
  if (stored) {
    return rest;
  }
  const merged = {
    ...newest,
    featureKey: MEDIA_SKIN_FEATURE,
    paramKey: (newest.paramKey || MEDIA_SKIN_FEATURE).replace(/^(tv|radio|deezer)\.skin/, MEDIA_SKIN_FEATURE),
    description: 'Cabinet style (skin) shared by TV, radio and Deezer, per user.'
  } as T;
  if (mediaIndex >= 0) {
    rest[mediaIndex] = { ...rest[mediaIndex], ...merged, ownerKey: rest[mediaIndex].ownerKey || newest.ownerKey };
  } else {
    rest.push(merged);
  }
  return rest;
}

export const MEDIA_SKIN_IDS = [
  'classic',
  'artdeco',
  'synthwave',
  'spaceage',
  'military',
  'steampunk',
  'aurora',
  'noir',
  'bamboo',
  'porcelain',
  'carbon',
  'candy',
  'espace',
  'kanizsa',
  'cafewall',
  'penrose',
  'scintille',
  'barber'
] as const;

export type MediaSkinId = (typeof MEDIA_SKIN_IDS)[number];

export const MEDIA_SKIN_STORAGE_KEY = 'pattool.media.skin';

const PAGE_SKIN_KEYS = ['pattool.tv.skin', 'pattool.radio.skin', 'pattool.deezer.skin'] as const;

export function isMediaSkin(value: string | null | undefined): value is MediaSkinId {
  return !!value && (MEDIA_SKIN_IDS as readonly string[]).includes(value);
}

/**
 * Shared key first. When it is missing, {@code preferKey} wins over the other page keys
 * so an older per-page choice still shows until the account value arrives.
 */
export function readMediaSkin(preferKey?: string): MediaSkinId | null {
  try {
    const shared = localStorage.getItem(MEDIA_SKIN_STORAGE_KEY);
    if (isMediaSkin(shared)) {
      return shared;
    }
    const keys = preferKey
      ? [preferKey, ...PAGE_SKIN_KEYS.filter((key) => key !== preferKey)]
      : [...PAGE_SKIN_KEYS];
    for (const key of keys) {
      const raw = localStorage.getItem(key);
      if (isMediaSkin(raw)) {
        return raw;
      }
    }
  } catch {
    /* private mode */
  }
  return null;
}

/** Writes the same skin for every media page and refreshes the radio float. */
export function writeMediaSkin(skin: string): void {
  if (!isMediaSkin(skin)) {
    return;
  }
  try {
    localStorage.setItem(MEDIA_SKIN_STORAGE_KEY, skin);
    for (const key of PAGE_SKIN_KEYS) {
      localStorage.setItem(key, skin);
    }
  } catch {
    /* private mode / quota */
  }
  try {
    window.dispatchEvent(new CustomEvent('patradiolook'));
  } catch {
    /* ignore */
  }
}

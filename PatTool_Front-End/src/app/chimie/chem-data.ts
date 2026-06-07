/**
 * Shared chemistry constants for the Chimie feature: CPK atom colours and
 * approximate covalent radii, used by both the 3D viewer and the reaction
 * composition badges.
 */

/** Approximate CPK colours by element symbol (numeric, for Three.js). */
export const CPK_COLORS: Record<string, number> = {
  H: 0xffffff, He: 0xd9ffff, Li: 0xcc80ff, Be: 0xc2ff00, B: 0xffb5b5,
  C: 0x303030, N: 0x3050f8, O: 0xff0d0d, F: 0x90e050, Ne: 0xb3e3f5,
  Na: 0xab5cf2, Mg: 0x8aff00, Al: 0xbfa6a6, Si: 0xf0c8a0, P: 0xff8000,
  S: 0xffff30, Cl: 0x1ff01f, Ar: 0x80d1e3, K: 0x8f40d4, Ca: 0x3dff00,
  Fe: 0xe06633, Cu: 0xc88033, Zn: 0x7d80b0, Br: 0xa62929, I: 0x940094,
  Au: 0xffd123, Ag: 0xc0c0c0
};

/** Approximate covalent radii (Å) for ball-and-stick sizing. */
export const COVALENT_RADII: Record<string, number> = {
  H: 0.31, He: 0.28, Li: 1.28, Be: 0.96, B: 0.84, C: 0.76, N: 0.71,
  O: 0.66, F: 0.57, Ne: 0.58, Na: 1.66, Mg: 1.41, Al: 1.21, Si: 1.11,
  P: 1.07, S: 1.05, Cl: 1.02, Br: 1.20, I: 1.39, Fe: 1.32, Cu: 1.32, Zn: 1.22
};

export const DEFAULT_CPK = 0xff1493;
export const DEFAULT_COVALENT = 0.75;

/** CSS hex string (e.g. "#ff0d0d") for an element symbol. */
export function cpkHex(symbol: string): string {
  const value = CPK_COLORS[symbol] ?? DEFAULT_CPK;
  return '#' + value.toString(16).padStart(6, '0');
}

/** Readable text colour (black/white) for a given CPK background. */
export function cpkTextColor(symbol: string): string {
  const value = CPK_COLORS[symbol] ?? DEFAULT_CPK;
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1b1b1b' : '#ffffff';
}

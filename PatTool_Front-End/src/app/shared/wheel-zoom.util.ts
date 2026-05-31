/**
 * Molette : modèle multiplicatif (visionneuses photo, Figma) ou additif sur l’indice Leaflet (cartes).
 * Réf. Leaflet : wheelPxPerZoomLevel ≈ 60 px par cran de zoom.
 */

/** deltaY exprimé en pixels (deltaMode lignes / pages convertis). */
export function normalizeWheelDeltaPixels(event: WheelEvent, lineHeightPx = 16): number {
  let dy = event.deltaY;
  if (event.deltaMode === 1) {
    dy *= lineHeightPx;
  } else if (event.deltaMode === 2) {
    dy *= typeof window !== 'undefined' ? window.innerHeight : 800;
  }
  return dy;
}

/** Facteur d’échelle pour un déplacement de molette (1.12 ≈ +12 % par cran de ~60 px). */
export function wheelScaleFactor(
  deltaPx: number,
  wheelPxPerZoomLevel = 60,
  zoomRatio = 1.12
): number {
  return Math.pow(zoomRatio, -deltaPx / wheelPxPerZoomLevel);
}

/** Zoom sur un facteur d’échelle (slideshow, graphiques pan/zoom). */
export function applyMultiplicativeWheelScale(
  current: number,
  deltaPx: number,
  min: number,
  max: number,
  wheelPxPerZoomLevel = 60,
  zoomRatio = 1.12
): number {
  const next = current * wheelScaleFactor(deltaPx, wheelPxPerZoomLevel, zoomRatio);
  return parseFloat(Math.min(max, Math.max(min, next)).toFixed(4));
}

/** Zoom sur l’indice Leaflet (échelle tuiles ≈ 2^zoom). */
export function applyLeafletStyleWheelZoom(
  currentZoom: number,
  deltaPx: number,
  minZoom: number,
  maxZoom: number,
  wheelPxPerZoomLevel = 60,
  zoomDelta = 0.28
): number {
  const next = currentZoom + (-deltaPx / wheelPxPerZoomLevel) * zoomDelta;
  return parseFloat(Math.min(maxZoom, Math.max(minZoom, next)).toFixed(4));
}

/**
 * Même ressenti que le diaporama : zoom multiplicatif (~12 % / 60 px) converti en indice Leaflet (log2).
 */
export function applyLeafletMultiplicativeWheelZoom(
  currentZoom: number,
  deltaPx: number,
  minZoom: number,
  maxZoom: number,
  wheelPxPerZoomLevel = 60,
  zoomRatio = 1.12
): number {
  const factor = wheelScaleFactor(deltaPx, wheelPxPerZoomLevel, zoomRatio);
  const next = currentZoom + Math.log2(factor);
  return parseFloat(Math.min(maxZoom, Math.max(minZoom, next)).toFixed(4));
}

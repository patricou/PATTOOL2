import * as L from 'leaflet';
import { environment } from '../../environments/environment';
import { GpsOfflineTilesStore } from '../gps-track/gps-offline-tiles.store';
import { GPS_OFFLINE_STYLE, gpsTileId } from '../gps-track/gps-offline-tiles.util';

export function cachedOsmTileUrl(): string {
  const base = environment.API_URL.endsWith('/') ? environment.API_URL : `${environment.API_URL}/`;
  return `${base}external/map/tile/{z}/{x}/{y}?style=${GPS_OFFLINE_STYLE}`;
}

/**
 * OSM raster layer that reads IndexedDB first, then the PatTool tile proxy.
 * Cached blobs remain visible with no network.
 */
export class CachedOsmTileLayer extends L.TileLayer {
  constructor(private readonly cache: GpsOfflineTilesStore) {
    super(cachedOsmTileUrl(), {
      maxNativeZoom: 19,
      maxZoom: 20,
      errorTileUrl: L.Util.emptyImageUrl,
      keepBuffer: 4,
      attribution: '&copy; OpenStreetMap contributors'
    });
    this.on('tileunload', (e: L.TileEvent) => {
      const img = e.tile as HTMLImageElement & { _patBlob?: string };
      if (img._patBlob) {
        URL.revokeObjectURL(img._patBlob);
        img._patBlob = undefined;
      }
    });
  }

  override createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const tile = document.createElement('img') as HTMLImageElement & { _patBlob?: string };
    tile.alt = '';
    tile.setAttribute('role', 'presentation');
    const id = gpsTileId(coords.z, coords.x, coords.y);
    const url = this.getTileUrl(coords);

    const finish = (src: string): void => {
      const empty = L.Util.emptyImageUrl;
      tile.onload = () => done(undefined, tile);
      tile.onerror = () => {
        if (tile.getAttribute('src') !== empty) {
          tile.src = empty;
          return;
        }
        done(undefined, tile);
      };
      tile.src = src;
    };

    void (async () => {
      const cached = await this.cache.get(id);
      if (!this._map) {
        done(undefined, tile);
        return;
      }
      if (cached) {
        const blobUrl = URL.createObjectURL(cached);
        tile._patBlob = blobUrl;
        finish(blobUrl);
        return;
      }
      try {
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          finish(url);
          return;
        }
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`http_${res.status}`);
        }
        const blob = await res.blob();
        await this.cache.put(id, blob);
        if (!this._map) {
          done(undefined, tile);
          return;
        }
        const blobUrl = URL.createObjectURL(blob);
        tile._patBlob = blobUrl;
        finish(blobUrl);
      } catch {
        if (!this._map) {
          done(undefined, tile);
          return;
        }
        finish(url);
      }
    })();

    return tile;
  }
}

import { lonLatToTile, parseStoredTileId, summarizeOfflineTiles, tileLatLonBounds, tilesAroundPoints, tilesInView, viewWindowAround, GpsViewWindow } from './gps-offline-tiles.util';

describe('tilesInView', () => {
  const geneva: GpsViewWindow = {
    south: 46.18,
    west: 6.12,
    north: 46.22,
    east: 6.18,
    zoom: 16.4
  };

  it('covers the displayed window at the rounded zoom first', () => {
    const tiles = tilesInView(geneva, { zoomSpan: 0 });
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.every((t) => t.z === 16)).toBeTrue();
    const center = lonLatToTile(6.15, 46.2, 16);
    expect(tiles.some((t) => t.x === center.x && t.y === center.y)).toBeTrue();
  });

  it('covers the window at every higher zoom, plus one level wider', () => {
    const tiles = tilesInView(geneva, { maxZ: 19 });
    const levels = [...new Set(tiles.map((t) => t.z))].sort((a, b) => a - b);
    expect(levels).toEqual([15, 16, 17, 18, 19]);
    expect(tiles[0].z).toBe(16);
    expect(tiles.some((t) => t.z === 12)).toBeFalse();
    const at = (z: number) => tiles.filter((t) => t.z === z).length;
    expect(at(19)).toBeGreaterThan(at(18));
    expect(at(18)).toBeGreaterThan(at(16));
  });

  it('stops at the tile cap after the on-screen zoom is filled', () => {
    const tiles = tilesInView(geneva, { maxTiles: 3, zoomSpan: 1 });
    expect(tiles.length).toBe(3);
    expect(tiles.every((t) => t.z === 16)).toBeTrue();
  });

  it('recenters the same window on a point', () => {
    const around = viewWindowAround(geneva, 46.5, 6.5);
    expect(around).not.toBeNull();
    expect(around!.zoom).toBe(geneva.zoom);
    expect(around!.north - around!.south).toBeCloseTo(geneva.north - geneva.south, 6);
    expect(around!.east - around!.west).toBeCloseTo(geneva.east - geneva.west, 6);
    expect((around!.north + around!.south) / 2).toBeCloseTo(46.5, 6);
    expect((around!.east + around!.west) / 2).toBeCloseTo(6.5, 6);
  });
});

describe('tilesAroundPoints', () => {
  const track = [
    { lat: 46.20, lon: 6.15 },
    { lat: 46.22, lon: 6.18 }
  ];

  it('covers a corridor around the track, current zoom first', () => {
    const tiles = tilesAroundPoints(track, {
      bufferM: 400,
      minZ: 0,
      maxZ: 16,
      zoom: 15,
      maxTiles: 8000
    });
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles[0].z).toBe(15);
    const levels = [...new Set(tiles.map((t) => t.z))];
    expect(levels[0]).toBe(15);
    expect(levels).toContain(14);
    expect(levels).toContain(16);
    expect(levels).not.toContain(13);
    const center = lonLatToTile(6.15, 46.2, 15);
    expect(tiles.some((t) => t.z === 15 && t.x === center.x && t.y === center.y)).toBeTrue();
    expect(tiles.some((t) => t.z === 15 && Math.abs(t.x - center.x) + Math.abs(t.y - center.y) === 1)).toBeTrue();
  });
});

describe('offline tile inventory', () => {
  it('keeps a point inside the bounds of its slippy tile', () => {
    const tile = lonLatToTile(6.15, 46.2, 16);
    const bounds = tileLatLonBounds(16, tile.x, tile.y);
    expect(bounds.west).toBeLessThanOrEqual(6.15);
    expect(bounds.east).toBeGreaterThan(6.15);
    expect(bounds.south).toBeLessThanOrEqual(46.2);
    expect(bounds.north).toBeGreaterThan(46.2);
  });

  it('groups stored tiles by basemap, zoom and covered region', () => {
    const a = lonLatToTile(6.15, 46.2, 15);
    const b = lonLatToTile(6.16, 46.21, 16);
    const inventory = summarizeOfflineTiles([
      { id: `opentopomap#0|15|${a.x}|${a.y}`, bytes: 1000, savedAt: 10 },
      { id: `osm|16|${b.x}|${b.y}`, bytes: 2000, savedAt: 20 },
      { id: `opentopomap#0|15|${a.x}|${a.y}`, bytes: 500, savedAt: 30 }
    ]);
    expect(inventory.tileCount).toBe(3);
    expect(inventory.bytes).toBe(3500);
    expect(inventory.regions.map((region) => region.style)).toEqual(['opentopomap', 'osm-standard']);
    const topo = inventory.regions[0];
    expect(topo.tileCount).toBe(2);
    expect(topo.minZoom).toBe(15);
    expect(topo.maxZoom).toBe(15);
    expect(topo.zooms).toEqual([{ z: 15, count: 2 }]);
    expect(topo.north).toBeGreaterThan(topo.south);
    expect(topo.east).toBeGreaterThan(topo.west);
    expect(parseStoredTileId('osm-fr#1|14|1|2')?.style).toBe('osm-fr');
  });
});

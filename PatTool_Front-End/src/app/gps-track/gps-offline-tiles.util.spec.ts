import { lonLatToTile, tilesInView, viewWindowAround, GpsViewWindow } from './gps-offline-tiles.util';

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

  it('adds one zoom level each way around the window, not a fixed 12–16 corridor', () => {
    const tiles = tilesInView(geneva);
    const levels = [...new Set(tiles.map((t) => t.z))].sort((a, b) => a - b);
    expect(levels).toEqual([15, 16, 17]);
    expect(tiles[0].z).toBe(16);
    expect(tiles.some((t) => t.z === 12)).toBeFalse();
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

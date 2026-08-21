package com.pat.service;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ReliefFinderMathTest {

    @Test
    void terrariumSeaLevelIsZero() {
        assertEquals(0.0, ReliefFinderMath.terrariumHeight(128, 0, 0), 1e-6);
    }

    @Test
    void terrariumMontBlancRange() {
        // 4808 m ≈ R=146, G=200 (146*256 + 200 - 32768 = 4808)
        assertEquals(4808.0, ReliefFinderMath.terrariumHeight(146, 200, 0), 0.5);
    }

    @Test
    void equatorPrimeMeridianIsTileCenterAtZoom0() {
        double[] xy = new double[2];
        ReliefFinderMath.latLonToTile(0, 0, 0, xy);
        assertEquals(0.5, xy[0], 1e-6);
        assertEquals(0.5, xy[1], 1e-6);
    }

    @Test
    void destinationNorthIsHigherLatitude() {
        double[] dest = ReliefFinderMath.destination(46.0, 6.0, 0, 1000);
        assertTrue(dest[0] > 46.0);
        assertEquals(6.0, dest[1], 0.002);
    }

    @Test
    void bearingRoundTrip() {
        double[] dest = ReliefFinderMath.destination(46.2, 6.15, 120, 12_000);
        double az = ReliefFinderMath.initialBearingDeg(46.2, 6.15, dest[0], dest[1]);
        assertEquals(120.0, az, 0.8);
        assertEquals(12_000, ReliefFinderMath.haversineM(46.2, 6.15, dest[0], dest[1]), 15);
    }

    @Test
    void nearbyHigherTerrainHasPositiveElevation() {
        double el = ReliefFinderMath.elevationDeg(400, 2000, 20_000);
        assertTrue(el > 3);
        assertTrue(el < 6);
    }

    @Test
    void curvatureHidesDistantSameHeight() {
        double el = ReliefFinderMath.elevationDeg(400, 400, 80_000);
        assertTrue(el < 0);
    }

    @Test
    void sampleElevationBilinearOnFlatTile() {
        short[] flat = new short[256 * 256];
        java.util.Arrays.fill(flat, (short) 1234);
        ReliefFinderMath.TileAtlas atlas = (z, x, y) -> flat;
        assertEquals(1234, ReliefFinderMath.sampleElevation(46.2, 6.15, 9, atlas), 0.01);
    }

    @Test
    void horizonIndexWraps() {
        assertEquals(0, ReliefFinderService.horizonIndex(0, 0.5, 720));
        assertEquals(0, ReliefFinderService.horizonIndex(360, 0.5, 720));
        assertEquals(180, ReliefFinderService.horizonIndex(90, 0.5, 720));
    }
}

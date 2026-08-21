package com.pat.service;

/**
 * Geodesy + Terrarium DEM helpers for Relief Finder (no I/O).
 * Horizon rays use a spherical Earth with standard atmospheric refraction (k ≈ 0.13).
 */
public final class ReliefFinderMath {

    public static final double EARTH_RADIUS_M = 6_371_000.0;
    /** Effective radius for refraction: R / (1 − k), k = 0.13. */
    public static final double EFFECTIVE_EARTH_RADIUS_M = EARTH_RADIUS_M / 0.87;
    public static final int TILE_SIZE = 256;
    static final short NODATA = Short.MIN_VALUE;

    private ReliefFinderMath() {}

    public static double normalizeDeg(double deg) {
        double d = deg % 360.0;
        if (d < 0) {
            d += 360.0;
        }
        return d;
    }

    public static double haversineM(double lat1, double lon1, double lat2, double lon2) {
        double r = Math.PI / 180.0;
        double dLat = (lat2 - lat1) * r;
        double dLon = (lon2 - lon1) * r;
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    public static double initialBearingDeg(double lat1, double lon1, double lat2, double lon2) {
        double r = Math.PI / 180.0;
        double φ1 = lat1 * r;
        double φ2 = lat2 * r;
        double Δλ = (lon2 - lon1) * r;
        double y = Math.sin(Δλ) * Math.cos(φ2);
        double x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
        return normalizeDeg(Math.toDegrees(Math.atan2(y, x)));
    }

    /** Destination along a true-north bearing (degrees) at distance metres. */
    public static double[] destination(double latDeg, double lonDeg, double bearingDeg, double distM) {
        double δ = distM / EARTH_RADIUS_M;
        double θ = Math.toRadians(bearingDeg);
        double φ1 = Math.toRadians(latDeg);
        double λ1 = Math.toRadians(lonDeg);
        double sinφ1 = Math.sin(φ1);
        double cosφ1 = Math.cos(φ1);
        double sinδ = Math.sin(δ);
        double cosδ = Math.cos(δ);
        double φ2 = Math.asin(sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ));
        double λ2 = λ1 + Math.atan2(Math.sin(θ) * sinδ * cosφ1, cosδ - sinφ1 * Math.sin(φ2));
        return new double[] { Math.toDegrees(φ2), normalizeLon(Math.toDegrees(λ2)) };
    }

    public static double normalizeLon(double lon) {
        double l = ((lon + 180.0) % 360.0 + 360.0) % 360.0 - 180.0;
        if (l == -180.0) {
            return 180.0;
        }
        return l;
    }

    /**
     * Apparent elevation of a terrain point: atan2(Δh − curvature drop, distance).
     * 0° = geometric horizon, positive = above.
     */
    public static double elevationDeg(double observerH, double terrainH, double distM) {
        if (!(distM > 1.0) || !Double.isFinite(observerH) || !Double.isFinite(terrainH)) {
            return Double.NaN;
        }
        double drop = (distM * distM) / (2.0 * EFFECTIVE_EARTH_RADIUS_M);
        return Math.toDegrees(Math.atan2(terrainH - observerH - drop, distM));
    }

    /** Terrarium RGB → metres. */
    public static double terrariumHeight(int r, int g, int b) {
        return (r * 256.0 + g + b / 256.0) - 32768.0;
    }

    public static short terrariumHeightShort(int rgb) {
        int r = (rgb >> 16) & 0xff;
        int g = (rgb >> 8) & 0xff;
        int b = rgb & 0xff;
        double h = terrariumHeight(r, g, b);
        if (!Double.isFinite(h) || h < -1000 || h > 9000) {
            return NODATA;
        }
        return (short) Math.round(h);
    }

    /**
     * Web Mercator fractional tile coordinates (z / x / y), pixel origin top-left.
     * {@code out} = { tileX, tileY, pixelX, pixelY } with pixel in [0, 256).
     */
    public static void latLonToTile(double latDeg, double lonDeg, int zoom, double[] outFracXy) {
        double lat = Math.max(-85.05112878, Math.min(85.05112878, latDeg));
        double n = 1 << zoom;
        double x = (normalizeLon(lonDeg) + 180.0) / 360.0 * n;
        double latRad = Math.toRadians(lat);
        double y = (1.0 - Math.log(Math.tan(latRad) + 1.0 / Math.cos(latRad)) / Math.PI) / 2.0 * n;
        x = ((x % n) + n) % n;
        y = Math.max(0, Math.min(n - 1e-9, y));
        outFracXy[0] = x;
        outFracXy[1] = y;
    }

    public static String tileKey(int zoom, int tileX, int tileY) {
        return zoom + "/" + tileX + "/" + tileY;
    }

    public static int zoomForRadiusKm(double radiusKm) {
        if (radiusKm <= 35) {
            return 10;
        }
        if (radiusKm <= 90) {
            return 9;
        }
        return 8;
    }

    public static int tileCount(int zoom) {
        return 1 << zoom;
    }

    /**
     * Sample bilinear elevation from a tile atlas. Missing tiles / NODATA → NaN.
     */
    public static double sampleElevation(
            double latDeg,
            double lonDeg,
            int zoom,
            TileAtlas atlas) {
        double[] xy = new double[2];
        latLonToTile(latDeg, lonDeg, zoom, xy);
        int n = tileCount(zoom);
        int tx = (int) Math.floor(xy[0]);
        int ty = (int) Math.floor(xy[1]);
        double px = (xy[0] - tx) * TILE_SIZE;
        double py = (xy[1] - ty) * TILE_SIZE;
        int ix = (int) Math.floor(px);
        int iy = (int) Math.floor(py);
        double fx = px - ix;
        double fy = py - iy;
        double h00 = elevAt(atlas, zoom, tx, ty, ix, iy, n);
        double h10 = elevAt(atlas, zoom, tx, ty, ix + 1, iy, n);
        double h01 = elevAt(atlas, zoom, tx, ty, ix, iy + 1, n);
        double h11 = elevAt(atlas, zoom, tx, ty, ix + 1, iy + 1, n);
        if (Double.isNaN(h00) || Double.isNaN(h10) || Double.isNaN(h01) || Double.isNaN(h11)) {
            if (!Double.isNaN(h00)) {
                return h00;
            }
            if (!Double.isNaN(h10)) {
                return h10;
            }
            if (!Double.isNaN(h01)) {
                return h01;
            }
            return h11;
        }
        return h00 * (1 - fx) * (1 - fy)
                + h10 * fx * (1 - fy)
                + h01 * (1 - fx) * fy
                + h11 * fx * fy;
    }

    private static double elevAt(
            TileAtlas atlas,
            int zoom,
            int tileX,
            int tileY,
            int px,
            int py,
            int n) {
        int tx = tileX;
        int ty = tileY;
        int x = px;
        int y = py;
        if (x >= TILE_SIZE) {
            x -= TILE_SIZE;
            tx++;
        } else if (x < 0) {
            x += TILE_SIZE;
            tx--;
        }
        if (y >= TILE_SIZE) {
            y -= TILE_SIZE;
            ty++;
        } else if (y < 0) {
            y += TILE_SIZE;
            ty--;
        }
        tx = ((tx % n) + n) % n;
        if (ty < 0 || ty >= n) {
            return Double.NaN;
        }
        short[] data = atlas.get(zoom, tx, ty);
        if (data == null) {
            return Double.NaN;
        }
        short h = data[y * TILE_SIZE + x];
        if (h == NODATA) {
            return Double.NaN;
        }
        return h;
    }

    public interface TileAtlas {
        short[] get(int zoom, int tileX, int tileY);
    }
}

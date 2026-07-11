package com.pat.service;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/**
 * Interpolates MeteoSwiss local point precipitation (mm/h) onto a raster PNG for map overlay.
 */
final class MeteoSwissPrecipRasterizer {

    private static final int GRID_W = 140;
    private static final int GRID_H = 88;
    private static final int BUCKET_COLS = 35;
    private static final int BUCKET_ROWS = 22;
    private static final int IDW_NEIGHBORS = 4;
    private static final double IDW_POWER = 2.0;
    private static final double MIN_MM = 0.001;

    private MeteoSwissPrecipRasterizer() {
    }

    static byte[] renderFrame(
            double south,
            double north,
            double west,
            double east,
            List<MeteoSwissForecastService.PointRecord> points,
            Map<Integer, Double> precipByPointId) throws IOException {
        if (points.isEmpty() || precipByPointId == null || precipByPointId.isEmpty()) {
            return transparentPng();
        }

        @SuppressWarnings("unchecked")
        List<MeteoSwissForecastService.PointRecord>[][] buckets =
                (List<MeteoSwissForecastService.PointRecord>[][]) new List[BUCKET_ROWS][BUCKET_COLS];
        for (MeteoSwissForecastService.PointRecord point : points) {
            Double mm = precipByPointId.get(point.id());
            if (mm == null) {
                continue;
            }
            int bx = bucketCol(point.lon(), west, east);
            int by = bucketRow(point.lat(), south, north);
            if (buckets[by][bx] == null) {
                buckets[by][bx] = new ArrayList<>(16);
            }
            buckets[by][bx].add(point);
        }

        BufferedImage image = new BufferedImage(GRID_W, GRID_H, BufferedImage.TYPE_INT_ARGB);
        double latStep = GRID_H > 1 ? (north - south) / (GRID_H - 1) : 0;
        double lonStep = GRID_W > 1 ? (east - west) / (GRID_W - 1) : 0;

        for (int row = 0; row < GRID_H; row++) {
            double lat = GRID_H > 1 ? north - row * latStep : (north + south) / 2;
            for (int col = 0; col < GRID_W; col++) {
                double lon = GRID_W > 1 ? west + col * lonStep : (west + east) / 2;
                double mm = interpolateMm(lat, lon, south, north, west, east, buckets, precipByPointId);
                image.setRGB(col, row, colorForMm(mm));
            }
        }

        ByteArrayOutputStream out = new ByteArrayOutputStream(GRID_W * GRID_H);
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    private static double interpolateMm(
            double lat,
            double lon,
            double south,
            double north,
            double west,
            double east,
            List<MeteoSwissForecastService.PointRecord>[][] buckets,
            Map<Integer, Double> precipByPointId) {
        int bx = bucketCol(lon, west, east);
        int by = bucketRow(lat, south, north);
        List<Neighbor> neighbors = new ArrayList<>(12);
        for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
                int cx = bx + dx;
                int cy = by + dy;
                if (cx < 0 || cy < 0 || cx >= BUCKET_COLS || cy >= BUCKET_ROWS) {
                    continue;
                }
                List<MeteoSwissForecastService.PointRecord> bucket = buckets[cy][cx];
                if (bucket == null) {
                    continue;
                }
                for (MeteoSwissForecastService.PointRecord point : bucket) {
                    Double mm = precipByPointId.get(point.id());
                    if (mm == null) {
                        continue;
                    }
                    double dist = Math.max(0.05, haversineKm(lat, lon, point.lat(), point.lon()));
                    neighbors.add(new Neighbor(dist, mm));
                }
            }
        }
        if (neighbors.isEmpty()) {
            return 0;
        }
        neighbors.sort(Comparator.comparingDouble(Neighbor::dist));
        int count = Math.min(IDW_NEIGHBORS, neighbors.size());
        double weightSum = 0;
        double valueSum = 0;
        for (int i = 0; i < count; i++) {
            Neighbor n = neighbors.get(i);
            double w = 1.0 / Math.pow(n.dist(), IDW_POWER);
            weightSum += w;
            valueSum += w * n.mm();
        }
        return weightSum > 0 ? valueSum / weightSum : 0;
    }

    private static int bucketCol(double lon, double west, double east) {
        double t = (lon - west) / (east - west);
        return Math.max(0, Math.min(BUCKET_COLS - 1, (int) (t * BUCKET_COLS)));
    }

    private static int bucketRow(double lat, double south, double north) {
        double t = (lat - south) / (north - south);
        return Math.max(0, Math.min(BUCKET_ROWS - 1, (int) (t * BUCKET_ROWS)));
    }

    private static int colorForMm(double mm) {
        if (mm < MIN_MM) {
            return 0x00000000;
        }
        int alpha = 230;
        if (mm < 0.5) {
            return rgba(166, 216, 255, (int) (160 + mm * 140));
        }
        if (mm < 2) {
            return rgba(77, 166, 255, alpha);
        }
        if (mm < 5) {
            return rgba(0, 204, 102, alpha);
        }
        if (mm < 10) {
            return rgba(255, 204, 0, alpha);
        }
        if (mm < 20) {
            return rgba(255, 153, 0, alpha);
        }
        return rgba(204, 0, 0, alpha);
    }

    private static int rgba(int r, int g, int b, int a) {
        return ((a & 0xFF) << 24) | ((r & 0xFF) << 16) | ((g & 0xFF) << 8) | (b & 0xFF);
    }

    private static byte[] transparentPng() throws IOException {
        BufferedImage image = new BufferedImage(GRID_W, GRID_H, BufferedImage.TYPE_INT_ARGB);
        ByteArrayOutputStream out = new ByteArrayOutputStream(GRID_W * GRID_H);
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    private static double haversineKm(double lat1, double lon1, double lat2, double lon2) {
        double r = 6371.0;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    private record Neighbor(double dist, double mm) {}
}

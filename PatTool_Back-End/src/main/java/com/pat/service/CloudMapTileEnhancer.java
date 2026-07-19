package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;

/**
 * Remaps weather-map cloud tiles for map overlays.
 * OpenWeatherMap: soft white clouds on transparency.
 * Satellite IR: darker high-contrast overlay.
 */
public final class CloudMapTileEnhancer {

    private static final Logger log = LoggerFactory.getLogger(CloudMapTileEnhancer.class);

    private CloudMapTileEnhancer() {
    }

    public static byte[] enhanceOpenWeatherMap(byte[] pngBytes, float intensity) {
        float gain = clampGain(intensity);
        if (gain <= 1.02f) {
            return pngBytes;
        }
        try {
            BufferedImage src = ImageIO.read(new ByteArrayInputStream(pngBytes));
            if (src == null) {
                return pngBytes;
            }
            int w = src.getWidth();
            int h = src.getHeight();
            BufferedImage out = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    int px = src.getRGB(x, y);
                    int a = (px >>> 24) & 0xFF;
                    int r = (px >>> 16) & 0xFF;
                    int g = (px >>> 8) & 0xFF;
                    int b = px & 0xFF;
                    if (a < 8) {
                        out.setRGB(x, y, 0x00000000);
                        continue;
                    }
                    float lum = (0.299f * r + 0.587f * g + 0.114f * b) / 255f;
                    float cloud = Math.max(0f, lum - 0.04f);
                    float cover = (float) Math.min(1.0, Math.pow(cloud * gain * 1.45, 0.72));
                    if (cover < 0.02f) {
                        out.setRGB(x, y, 0x00000000);
                        continue;
                    }
                    int newA = (int) Math.min(240, 40 + cover * 200);
                    out.setRGB(x, y, (newA << 24) | 0x00FFFFFF);
                }
            }
            return writePng(out, pngBytes.length);
        } catch (Exception e) {
            log.debug("OWM cloud tile enhance failed: {}", e.getMessage());
            return pngBytes;
        }
    }

    public static byte[] enhanceSatelliteIr(byte[] pngBytes, float intensity) {
        float gain = clampGain(intensity);
        if (gain <= 1.02f) {
            return pngBytes;
        }
        try {
            BufferedImage src = ImageIO.read(new ByteArrayInputStream(pngBytes));
            if (src == null) {
                return pngBytes;
            }
            int w = src.getWidth();
            int h = src.getHeight();
            BufferedImage out = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    int px = src.getRGB(x, y);
                    int a = (px >>> 24) & 0xFF;
                    int r = (px >>> 16) & 0xFF;
                    int g = (px >>> 8) & 0xFF;
                    int b = px & 0xFF;
                    float lum = (0.299f * r + 0.587f * g + 0.114f * b) / 255f;
                    float alphaSignal = a / 255f;
                    float colorSignal = Math.max(0f, 1f - Math.abs(lum - 0.9f) * 3.5f);
                    float signal = Math.max(alphaSignal, colorSignal * Math.max(0.15f, alphaSignal));
                    if (signal < 0.025f && a < 10) {
                        out.setRGB(x, y, 0x00000000);
                        continue;
                    }
                    float cover = (float) Math.min(1.0, Math.pow(signal * gain * 2.8, 0.38));
                    int newA = (int) Math.min(245, 90 + cover * 155);
                    int shade = (int) Math.max(35, Math.min(200, 220 - cover * 150));
                    int blue = Math.min(255, shade + 48);
                    out.setRGB(x, y, (newA << 24) | (shade << 16) | ((shade + 6) << 8) | blue);
                }
            }
            return writePng(out, pngBytes.length);
        } catch (Exception e) {
            log.debug("Satellite IR cloud tile enhance failed: {}", e.getMessage());
            return pngBytes;
        }
    }

    /** @deprecated use {@link #enhanceOpenWeatherMap} or {@link #enhanceSatelliteIr} */
    @Deprecated
    public static byte[] enhance(byte[] pngBytes, float intensity) {
        return enhanceOpenWeatherMap(pngBytes, intensity);
    }

    private static float clampGain(float intensity) {
        return Math.max(0.5f, Math.min(8f, intensity));
    }

    private static byte[] writePng(BufferedImage out, int minBuffer) throws java.io.IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream(Math.max(minBuffer, 4096));
        ImageIO.write(out, "png", baos);
        return baos.toByteArray();
    }
}

package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;

/**
 * Remaps pale weather-map cloud tiles (OpenWeatherMap, RainViewer IR) to darker, high-contrast overlays.
 */
public final class CloudMapTileEnhancer {

    private static final Logger log = LoggerFactory.getLogger(CloudMapTileEnhancer.class);

    private CloudMapTileEnhancer() {
    }

    public static byte[] enhance(byte[] pngBytes, float intensity) {
        float gain = Math.max(0.5f, Math.min(8f, intensity));
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
                    float cover = (float) Math.min(1.0, Math.pow(signal * gain * 3.2, 0.38));
                    int newA = (int) Math.min(255, 110 + cover * 145);
                    int shade = (int) Math.max(18, Math.min(175, 205 - cover * 175));
                    int blue = Math.min(255, shade + 48);
                    out.setRGB(x, y, (newA << 24) | (shade << 16) | ((shade + 4) << 8) | blue);
                }
            }
            ByteArrayOutputStream baos = new ByteArrayOutputStream(Math.max(pngBytes.length, 4096));
            ImageIO.write(out, "png", baos);
            return baos.toByteArray();
        } catch (Exception e) {
            log.debug("Cloud tile enhance failed: {}", e.getMessage());
            return pngBytes;
        }
    }
}

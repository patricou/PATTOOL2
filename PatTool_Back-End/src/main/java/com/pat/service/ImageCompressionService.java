package com.pat.service;

import com.drew.imaging.ImageMetadataReader;
import com.drew.imaging.ImageProcessingException;
import com.drew.metadata.Metadata;
import com.drew.metadata.MetadataException;
import com.drew.metadata.exif.ExifIFD0Directory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Iterator;
import java.util.function.Consumer;
import java.util.concurrent.Semaphore;

@Service
public class ImageCompressionService {

    private static final Logger log = LoggerFactory.getLogger(ImageCompressionService.class);
    private final Semaphore compressionSemaphore;

    public ImageCompressionService(@Value("${app.image.compression.max-concurrency:6}") int maxConcurrentCompressions) {
        int permits = Math.max(1, maxConcurrentCompressions);
        this.compressionSemaphore = new Semaphore(permits, true);
        log.debug("ImageCompressionService initialized with {} concurrent compression permits", permits);
    }

    public boolean isImageType(String contentType) {
        if (contentType == null) {
            return false;
        }
        return contentType.startsWith("image/");
    }

    public byte[] resizeImageIfNeeded(
        String filename,
        BufferedImage originalImage,
        String contentType,
        long originalSize,
        long maxSize,
        byte[] originalFileBytes,
        Consumer<String> logConsumer
    ) throws IOException {

        boolean permitAcquired = false;
        try {
            log.info("Image compression requested for '{}'. Available permits before acquire: {}", filename, compressionSemaphore.availablePermits());
            compressionSemaphore.acquire();
            permitAcquired = true;
            log.info("Compression permit granted for '{}'. Remaining permits: {}", filename, compressionSemaphore.availablePermits());
            return performResize(filename, originalImage, contentType, originalSize, maxSize, originalFileBytes, logConsumer);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Image compression interrupted", e);
        } finally {
            if (permitAcquired) {
                compressionSemaphore.release();
                log.info("Compression permit released for '{}'. Available permits after release: {}", filename, compressionSemaphore.availablePermits());
            }
        }
    }

    private byte[] performResize(
        String filename,
        BufferedImage originalImage,
        String contentType,
        long originalSize,
        long maxSize,
        byte[] originalFileBytes,
        Consumer<String> logConsumer
    ) throws IOException {
        int originalWidth = originalImage.getWidth();
        int originalHeight = originalImage.getHeight();
        emitLog(logConsumer, String.format("📏 Original image: %dx%d, %d KB", originalWidth, originalHeight, originalSize / 1024));

        BufferedImage imageWithOrientation = applyOrientation(originalImage, originalFileBytes);

        BufferedImage imageToCompress;
        if (imageWithOrientation.getType() == BufferedImage.TYPE_INT_RGB ||
            imageWithOrientation.getType() == BufferedImage.TYPE_INT_ARGB) {
            imageToCompress = imageWithOrientation;
        } else {
            int width = imageWithOrientation.getWidth();
            int height = imageWithOrientation.getHeight();
            imageToCompress = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
            Graphics2D g = imageToCompress.createGraphics();
            g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            g.drawImage(imageWithOrientation, 0, 0, null);
            g.dispose();
        }

        String format = (contentType != null && contentType.contains("png")) ? "png" : "jpeg";

        byte[] result = compressWithQuality(imageToCompress, format, 0.5f);

        emitLog(logConsumer, String.format("📊 Size after compression: %d KB", result.length / 1024));

        if (result.length <= maxSize) {
            emitLog(logConsumer, String.format("✅ Final size: %d KB (no resize needed)", result.length / 1024));
            return result;
        }

        int imageToCompressWidth = imageToCompress.getWidth();
        int imageToCompressHeight = imageToCompress.getHeight();

        emitLog(logConsumer, String.format("📐 Starting resize: %dx%d, current size: %d KB",
            imageToCompressWidth, imageToCompressHeight, result.length / 1024));

        double aspectRatio = (double) imageToCompressWidth / imageToCompressHeight;

        int currentWidth = imageToCompressWidth;
        int currentHeight = imageToCompressHeight;
        int attempt = 0;

        while (result.length > maxSize && attempt < 10) {
            attempt++;

            double sizeRatio = (double) maxSize / result.length;
            double scaleFactor = Math.sqrt(sizeRatio) * 0.8;

            currentWidth = (int) (currentWidth * scaleFactor);
            currentHeight = (int) (currentHeight * scaleFactor);

            double currentAspectRatio = (double) currentWidth / currentHeight;
            if (Math.abs(currentAspectRatio - aspectRatio) > 0.01) {
                if (currentAspectRatio > aspectRatio) {
                    currentWidth = (int) (currentHeight * aspectRatio);
                } else {
                    currentHeight = (int) (currentWidth / aspectRatio);
                }
            }

            if (currentWidth < 150 || currentHeight < 150) {
                if (aspectRatio >= 1.0) {
                    currentWidth = Math.max(150, currentWidth);
                    currentHeight = (int) (currentWidth / aspectRatio);
                } else {
                    currentHeight = Math.max(150, currentHeight);
                    currentWidth = (int) (currentHeight * aspectRatio);
                }
            }

            if (attempt == 1) {
                emitLog(logConsumer, String.format("🔄 Resizing to %dx%d", currentWidth, currentHeight));
            }

            BufferedImage resizedImage = new BufferedImage(currentWidth, currentHeight, BufferedImage.TYPE_INT_RGB);
            Graphics2D g = resizedImage.createGraphics();
            g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g.drawImage(imageToCompress, 0, 0, currentWidth, currentHeight, null);
            g.dispose();

            float[] qualities = {0.4f, 0.3f, 0.2f};

            for (float quality : qualities) {
                result = compressWithQuality(resizedImage, format, quality);

                if (result.length <= maxSize) {
                    emitLog(logConsumer, String.format("✅ Final size: %d KB (%dx%d)", result.length / 1024, currentWidth, currentHeight));
                    return result;
                }
            }

            imageToCompress = resizedImage;
        }

        if (result.length > maxSize) {
            float quality = 0.15f;
            result = compressWithQuality(imageToCompress, format, quality);

            while (result.length > maxSize && currentWidth > 100 && currentHeight > 100) {
                double reductionFactor = 0.9;
                currentWidth = (int) (currentWidth * reductionFactor);
                currentHeight = (int) (currentHeight * reductionFactor);

                double currentAspectRatio = (double) currentWidth / currentHeight;
                if (Math.abs(currentAspectRatio - aspectRatio) > 0.01) {
                    if (currentAspectRatio > aspectRatio) {
                        currentWidth = (int) (currentHeight * aspectRatio);
                    } else {
                        currentHeight = (int) (currentWidth / aspectRatio);
                    }
                }

                BufferedImage finalResize = new BufferedImage(currentWidth, currentHeight, BufferedImage.TYPE_INT_RGB);
                Graphics2D g = finalResize.createGraphics();
                g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
                g.drawImage(imageToCompress, 0, 0, currentWidth, currentHeight, null);
                g.dispose();

                result = compressWithQuality(finalResize, format, quality);
            }
        }

        emitLog(logConsumer, String.format("✅ Final size: %d KB (%dx%d)", result.length / 1024, currentWidth, currentHeight));
        return result;
    }

    private void emitLog(Consumer<String> logConsumer, String message) {
        if (logConsumer != null) {
            try {
                logConsumer.accept(message);
            } catch (Exception e) {
                log.debug("Could not emit compression log message: {}", e.getMessage());
            }
        }
    }

    private BufferedImage applyOrientation(BufferedImage image, byte[] fileBytes) {
        try {
            Metadata metadata = ImageMetadataReader.readMetadata(new ByteArrayInputStream(fileBytes));
            ExifIFD0Directory exifIFD0Directory = metadata.getFirstDirectoryOfType(ExifIFD0Directory.class);

            if (exifIFD0Directory != null && exifIFD0Directory.containsTag(ExifIFD0Directory.TAG_ORIENTATION)) {
                int orientation = exifIFD0Directory.getInt(ExifIFD0Directory.TAG_ORIENTATION);
                log.debug("Image EXIF orientation: {}", orientation);

                switch (orientation) {
                    case 3:
                        return rotateImage(image, 180);
                    case 6:
                        return rotateImage(image, 90);
                    case 8:
                        return rotateImage(image, -90);
                    case 2:
                    case 4:
                    case 5:
                    case 7:
                        log.debug("Flip operations not fully supported, returning as-is");
                        break;
                    default:
                        log.debug("No rotation needed (orientation: {})", orientation);
                        break;
                }
            }
        } catch (ImageProcessingException | MetadataException | IOException e) {
            log.debug("Could not read EXIF metadata: {}", e.getMessage());
        }

        return image;
    }

    private BufferedImage rotateImage(BufferedImage image, double angle) {
        int width = image.getWidth();
        int height = image.getHeight();
        int type = image.getType();

        double radians = Math.toRadians(angle);
        double cos = Math.abs(Math.cos(radians));
        double sin = Math.abs(Math.sin(radians));
        int newWidth = (int) Math.round(width * cos + height * sin);
        int newHeight = (int) Math.round(height * cos + width * sin);

        BufferedImage rotated = new BufferedImage(newWidth, newHeight, type);
        Graphics2D g = rotated.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);

        int offsetX = (newWidth - width) / 2;
        int offsetY = (newHeight - height) / 2;
        g.translate(offsetX, offsetY);
        g.rotate(radians, width / 2.0, height / 2.0);
        g.drawImage(image, 0, 0, null);
        g.dispose();

        log.debug("Rotated image by {} degrees", angle);
        return rotated;
    }

    private byte[] compressWithQuality(BufferedImage image, String format, float quality) throws IOException {
        ByteArrayOutputStream outputStream = new ByteArrayOutputStream();

        if ("jpeg".equalsIgnoreCase(format) || "jpg".equalsIgnoreCase(format)) {
            Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName("jpeg");
            if (!writers.hasNext()) {
                throw new IOException("No JPEG writers available");
            }
            ImageWriter writer = writers.next();
            ImageWriteParam params = writer.getDefaultWriteParam();
            if (params.canWriteCompressed()) {
                params.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
                params.setCompressionQuality(quality);
            }

            try (ImageOutputStream imageOutputStream = ImageIO.createImageOutputStream(outputStream)) {
                writer.setOutput(imageOutputStream);
                writer.write(null, new javax.imageio.IIOImage(image, null, null), params);
            } finally {
                writer.dispose();
            }
        } else {
            ImageIO.write(image, format, outputStream);
        }

        return outputStream.toByteArray();
    }
}


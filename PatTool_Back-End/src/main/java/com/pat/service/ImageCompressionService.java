package com.pat.service;

import com.drew.imaging.ImageMetadataReader;
import com.drew.imaging.ImageProcessingException;
import com.drew.metadata.Directory;
import com.drew.metadata.Metadata;
import com.drew.metadata.MetadataException;
import com.drew.metadata.exif.ExifIFD0Directory;
import com.drew.metadata.exif.ExifSubIFDDirectory;
import com.drew.metadata.exif.GpsDirectory;
import com.drew.lang.GeoLocation;
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
import java.io.DataOutputStream;
import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.function.Consumer;
import java.nio.charset.StandardCharsets;

@Service
public class ImageCompressionService {

    private static final Logger log = LoggerFactory.getLogger(ImageCompressionService.class);
    private final Semaphore compressionSemaphore;
    private final Map<String, CacheEntry> compressionCache;
    private final long cacheTtlMillis;
    private final int cacheMaxEntries;

    public static final class CompressionResult {
        private final byte[] data;
        private final long originalSize;
        private final long compressedSize;
        private final Map<String, String> exifMetadata;

        private CompressionResult(byte[] data, long originalSize, Map<String, String> exifMetadata) {
            this.data = data;
            this.originalSize = originalSize;
            this.compressedSize = data != null ? data.length : 0;
            if (exifMetadata == null || exifMetadata.isEmpty()) {
                this.exifMetadata = Collections.emptyMap();
            } else {
                this.exifMetadata = Collections.unmodifiableMap(new LinkedHashMap<>(exifMetadata));
            }
        }

        public byte[] getData() {
            return data;
        }

        public long getOriginalSize() {
            return originalSize;
        }

        public long getCompressedSize() {
            return compressedSize;
        }

        public Map<String, String> getExifMetadata() {
            return exifMetadata;
        }
    }

    private static final class CacheEntry {
        private final CompressionResult result;
        private final long createdAt;

        private CacheEntry(CompressionResult result, long createdAt) {
            this.result = result;
            this.createdAt = createdAt;
        }
    }

    public ImageCompressionService(
        @Value("${app.image.compression.max-concurrency:10}") int maxConcurrentCompressions,
        @Value("${app.image.compression.cache.max-entries:3000}") int cacheMaxEntries,
        @Value("${app.image.compression.cache.ttl:PT2H}") Duration cacheTtl
    ) {
        int permits = Math.max(1, maxConcurrentCompressions);
        this.compressionSemaphore = new Semaphore(permits, true);
        this.compressionCache = new ConcurrentHashMap<>();
        this.cacheMaxEntries = Math.max(1, cacheMaxEntries);
        Duration effectiveTtl = cacheTtl != null ? cacheTtl : Duration.ofHours(1);
        this.cacheTtlMillis = Math.max(0L, effectiveTtl.toMillis());
        log.debug(
            "ImageCompressionService initialized with {} concurrent compression permits, cache enabled (maxEntries={}, ttl={} ms)",
            permits,
            this.cacheMaxEntries,
            this.cacheTtlMillis
        );
    }

    public boolean isImageType(String contentType) {
        if (contentType == null) {
            return false;
        }
        return contentType.startsWith("image/");
    }

    public CompressionResult resizeImageIfNeeded(
        String filename,
        BufferedImage originalImage,
        String contentType,
        long originalSize,
        long maxSize,
        byte[] originalFileBytes,
        Consumer<String> logConsumer
    ) throws IOException {
        return resizeImageIfNeeded(null, filename, originalImage, contentType, originalSize, maxSize, originalFileBytes, logConsumer);
    }

    public CompressionResult resizeImageIfNeeded(
        String cacheKey,
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
            log.debug("Image compression requested for '{}'. Available permits before acquire: {}", filename, compressionSemaphore.availablePermits());
            compressionSemaphore.acquire();
            permitAcquired = true;
            log.debug("Compression permit granted for '{}'. Remaining permits: {}", filename, compressionSemaphore.availablePermits());

            CompressionResult cached = getFromCache(cacheKey, logConsumer);
            if (cached != null) {
                return cached;
            }

            CompressionResult result = performResize(filename, originalImage, contentType, originalSize, maxSize, originalFileBytes, logConsumer);
            storeInCache(cacheKey, result);
            return result;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Image compression interrupted", e);
        } finally {
            if (permitAcquired) {
                compressionSemaphore.release();
                log.debug("Compression permit released for '{}'. Available permits after release: {}", filename, compressionSemaphore.availablePermits());
            }
        }
    }

    private CompressionResult performResize(
        String filename,
        BufferedImage originalImage,
        String contentType,
        long originalSize,
        long maxSize,
        byte[] originalFileBytes,
        Consumer<String> logConsumer
    ) throws IOException {
        Map<String, String> exifMetadata = collectExifMetadata(originalFileBytes);
        Map<String, String> enrichedExifMetadata = new LinkedHashMap<>(exifMetadata);
        enrichedExifMetadata.put("PatOriginalFileSizeBytes", Long.toString(originalSize));
        long roundedKb = Math.max(1L, (originalSize + 1023) / 1024);
        enrichedExifMetadata.put("PatOriginalFileSizeKB", Long.toString(roundedKb));

        String format = (contentType != null && contentType.contains("png")) ? "png" : "jpeg";
        boolean canPreserveExif = "jpeg".equalsIgnoreCase(format) || "jpg".equalsIgnoreCase(format);
        boolean hasOrientationTag = exifMetadata.containsKey("Orientation");

        BufferedImage imageWithOrientation;
        if (canPreserveExif && hasOrientationTag) {
            imageWithOrientation = originalImage;
        } else {
            imageWithOrientation = applyOrientation(originalImage, originalFileBytes);
        }

        int originalWidth = imageWithOrientation.getWidth();
        int originalHeight = imageWithOrientation.getHeight();
        emitLog(logConsumer, String.format("📏 Original image: %dx%d, %d KB", originalWidth, originalHeight, originalSize / 1024));

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

        byte[] result = compressWithQuality(imageToCompress, format, 0.5f);
        result = preserveExifMetadata(originalFileBytes, result, format, originalSize);

        emitLog(logConsumer, String.format("📊 Size after compression: %d KB", result.length / 1024));

        if (result.length <= maxSize) {
            emitLog(logConsumer, String.format("✅ Final size: %d KB (no resize needed)", result.length / 1024));
            return new CompressionResult(result, originalSize, enrichedExifMetadata);
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
                result = preserveExifMetadata(originalFileBytes, result, format, originalSize);

                if (result.length <= maxSize) {
                    emitLog(logConsumer, String.format("✅ Final size: %d KB (%dx%d)", result.length / 1024, currentWidth, currentHeight));
                    return new CompressionResult(result, originalSize, enrichedExifMetadata);
                }
            }

            imageToCompress = resizedImage;
        }

        if (result.length > maxSize) {
            float quality = 0.15f;
            result = compressWithQuality(imageToCompress, format, quality);
            result = preserveExifMetadata(originalFileBytes, result, format, originalSize);

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
                result = preserveExifMetadata(originalFileBytes, result, format, originalSize);
            }
        }

        emitLog(logConsumer, String.format("✅ Final size: %d KB (%dx%d)", result.length / 1024, currentWidth, currentHeight));
        return new CompressionResult(result, originalSize, enrichedExifMetadata);
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

    private CompressionResult getFromCache(String cacheKey, Consumer<String> logConsumer) {
        if (!isCacheEnabled() || cacheKey == null) {
            return null;
        }

        CacheEntry entry = compressionCache.get(cacheKey);
        if (entry == null) {
            return null;
        }

        long now = System.currentTimeMillis();
        if (isExpired(entry, now)) {
            compressionCache.remove(cacheKey, entry);
            emitLog(logConsumer, "🗑️ Cached compression expired, regenerating");
            return null;
        }

        emitLog(logConsumer, "⚡ Serving compressed image from cache");
        return entry.result;
    }

    private void storeInCache(String cacheKey, CompressionResult result) {
        if (!isCacheEnabled() || cacheKey == null || result == null) {
            return;
        }

        long now = System.currentTimeMillis();
        compressionCache.put(cacheKey, new CacheEntry(result, now));
        cleanupExpiredEntries(now);
        enforceCacheLimit();
    }

    private boolean isCacheEnabled() {
        return cacheTtlMillis > 0 && cacheMaxEntries > 0;
    }

    private boolean isExpired(CacheEntry entry, long now) {
        return cacheTtlMillis > 0 && (now - entry.createdAt) >= cacheTtlMillis;
    }

    private void cleanupExpiredEntries(long now) {
        if (!isCacheEnabled()) {
            return;
        }
        compressionCache.forEach((key, entry) -> {
            if (isExpired(entry, now)) {
                compressionCache.remove(key, entry);
            }
        });
    }

    private void enforceCacheLimit() {
        if (!isCacheEnabled()) {
            return;
        }

        int overshoot = compressionCache.size() - cacheMaxEntries;
        if (overshoot <= 0) {
            return;
        }

        List<Map.Entry<String, CacheEntry>> entries = new ArrayList<>(compressionCache.entrySet());
        entries.sort((a, b) -> Long.compare(a.getValue().createdAt, b.getValue().createdAt));

        for (int i = 0; i < overshoot && i < entries.size(); i++) {
            Map.Entry<String, CacheEntry> entry = entries.get(i);
            compressionCache.remove(entry.getKey(), entry.getValue());
        }
    }

    private Map<String, String> collectExifMetadata(byte[] originalFileBytes) {
        if (originalFileBytes == null || originalFileBytes.length == 0) {
            return Collections.emptyMap();
        }

        Map<String, String> metadataMap = new LinkedHashMap<>();
        try {
            Metadata metadata = ImageMetadataReader.readMetadata(new ByteArrayInputStream(originalFileBytes));
            ExifIFD0Directory ifd0 = metadata.getFirstDirectoryOfType(ExifIFD0Directory.class);
            ExifSubIFDDirectory subIfd = metadata.getFirstDirectoryOfType(ExifSubIFDDirectory.class);
            GpsDirectory gpsDirectory = metadata.getFirstDirectoryOfType(GpsDirectory.class);

            putIfPresent(metadataMap, "Orientation", ifd0, ExifIFD0Directory.TAG_ORIENTATION);
            putIfPresent(metadataMap, "CameraMake", ifd0, ExifIFD0Directory.TAG_MAKE);
            putIfPresent(metadataMap, "CameraModel", ifd0, ExifIFD0Directory.TAG_MODEL);
            putIfPresent(metadataMap, "DateTimeOriginal", subIfd, ExifSubIFDDirectory.TAG_DATETIME_ORIGINAL);
            putIfPresent(metadataMap, "ExposureTime", subIfd, ExifSubIFDDirectory.TAG_EXPOSURE_TIME);
            putIfPresent(metadataMap, "FNumber", subIfd, ExifSubIFDDirectory.TAG_FNUMBER);
            putIfPresent(metadataMap, "ISO", subIfd, ExifSubIFDDirectory.TAG_ISO_EQUIVALENT);
            putIfPresent(metadataMap, "FocalLength", subIfd, ExifSubIFDDirectory.TAG_FOCAL_LENGTH);
            putIfPresent(metadataMap, "LensModel", subIfd, ExifSubIFDDirectory.TAG_LENS_MODEL);
            putIfPresent(metadataMap, "Flash", subIfd, ExifSubIFDDirectory.TAG_FLASH);

            if (gpsDirectory != null) {
                GeoLocation geoLocation = gpsDirectory.getGeoLocation();
                if (geoLocation != null && !geoLocation.isZero()) {
                    metadataMap.put("GPSLatitude", Double.toString(geoLocation.getLatitude()));
                    metadataMap.put("GPSLongitude", Double.toString(geoLocation.getLongitude()));
                }
            }
        } catch (ImageProcessingException | IOException e) {
            log.debug("Could not extract EXIF metadata: {}", e.getMessage());
        }
        return metadataMap;
    }

    private void putIfPresent(Map<String, String> metadataMap, String key, Directory directory, int tagType) {
        if (directory != null && directory.containsTag(tagType)) {
            metadataMap.put(key, directory.getString(tagType));
        }
    }

    private byte[] preserveExifMetadata(byte[] originalFileBytes, byte[] compressedBytes, String format, long originalSize) {
        if (compressedBytes == null) {
            return null;
        }
        if (originalFileBytes == null || !"jpeg".equalsIgnoreCase(format) && !"jpg".equalsIgnoreCase(format)) {
            return compressedBytes;
        }
        if (!isJpeg(originalFileBytes) || !isJpeg(compressedBytes)) {
            return compressedBytes;
        }

        try {
            byte[] result = compressedBytes;
            byte[] exifSegment = extractExifSegment(originalFileBytes);
            if (exifSegment != null) {
                result = injectExifSegment(result, exifSegment);
            }

            if (!containsPatMetadata(result)) {
                result = injectPatExifSegment(result, originalSize);
            }
            return result;
        } catch (Exception e) {
            log.debug("Could not preserve EXIF metadata: {}", e.getMessage());
            return compressedBytes;
        }
    }

    private boolean isJpeg(byte[] data) {
        return data.length > 3 && (data[0] & 0xFF) == 0xFF && (data[1] & 0xFF) == 0xD8;
    }

    private byte[] extractExifSegment(byte[] jpegBytes) {
        int index = 2;
        while (index + 3 < jpegBytes.length) {
            if ((jpegBytes[index] & 0xFF) != 0xFF) {
                break;
            }
            int marker = jpegBytes[index + 1] & 0xFF;
            if (marker == 0xD9 || marker == 0xDA) {
                break;
            }
            int segmentLength = ((jpegBytes[index + 2] & 0xFF) << 8) | (jpegBytes[index + 3] & 0xFF);
            if (segmentLength < 2 || index + 2 + segmentLength > jpegBytes.length) {
                break;
            }
            if (marker == 0xE1) {
                int dataStart = index + 4;
                int dataLength = segmentLength - 2;
                if (dataLength >= 6 && isExifLabel(jpegBytes, dataStart)) {
                    byte[] segment = new byte[2 + segmentLength];
                    System.arraycopy(jpegBytes, index, segment, 0, segment.length);
                    return segment;
                }
            }
            index += 2 + segmentLength;
        }
        return null;
    }

    private byte[] injectExifSegment(byte[] jpegBytes, byte[] exifSegment) throws IOException {
        ByteArrayOutputStream outputStream = new ByteArrayOutputStream(jpegBytes.length + exifSegment.length + 16);
        outputStream.write(jpegBytes, 0, 2);

        int offset = 2;
        while (offset + 3 < jpegBytes.length) {
            if ((jpegBytes[offset] & 0xFF) != 0xFF) {
                break;
            }
            int marker = jpegBytes[offset + 1] & 0xFF;
            if (marker != 0xE0) {
                break;
            }
            int segmentLength = ((jpegBytes[offset + 2] & 0xFF) << 8) | (jpegBytes[offset + 3] & 0xFF);
            int totalLength = 2 + segmentLength;
            if (segmentLength < 2 || offset + totalLength > jpegBytes.length) {
                break;
            }
            outputStream.write(jpegBytes, offset, totalLength);
            offset += totalLength;
        }

        outputStream.write(exifSegment);

        while (offset + 3 < jpegBytes.length) {
            if ((jpegBytes[offset] & 0xFF) != 0xFF) {
                outputStream.write(jpegBytes, offset, jpegBytes.length - offset);
                return outputStream.toByteArray();
            }
            int marker = jpegBytes[offset + 1] & 0xFF;
            if (marker == 0xDA) {
                outputStream.write(jpegBytes, offset, jpegBytes.length - offset);
                return outputStream.toByteArray();
            }
            if (marker == 0xD9) {
                outputStream.write(jpegBytes, offset, jpegBytes.length - offset);
                return outputStream.toByteArray();
            }

            int segmentLength = ((jpegBytes[offset + 2] & 0xFF) << 8) | (jpegBytes[offset + 3] & 0xFF);
            int totalLength = 2 + segmentLength;
            if (segmentLength < 2 || offset + totalLength > jpegBytes.length) {
                outputStream.write(jpegBytes, offset, jpegBytes.length - offset);
                return outputStream.toByteArray();
            }

            if (marker == 0xE1 && isExifSegment(jpegBytes, offset + 4, segmentLength - 2)) {
                offset += totalLength;
                continue;
            }

            outputStream.write(jpegBytes, offset, totalLength);
            offset += totalLength;
        }

        if (offset < jpegBytes.length) {
            outputStream.write(jpegBytes, offset, jpegBytes.length - offset);
        }

        return outputStream.toByteArray();
    }

    private boolean isExifSegment(byte[] jpegBytes, int dataStart, int dataLength) {
        return dataLength >= 6 && isExifLabel(jpegBytes, dataStart);
    }

    private boolean isExifLabel(byte[] bytes, int offset) {
        return bytes.length >= offset + 6 &&
            bytes[offset] == 0x45 && bytes[offset + 1] == 0x78 &&
            bytes[offset + 2] == 0x69 && bytes[offset + 3] == 0x66 &&
            bytes[offset + 4] == 0x00 && bytes[offset + 5] == 0x00;
    }

    private boolean containsPatMetadata(byte[] jpegBytes) {
        if (jpegBytes == null || jpegBytes.length == 0) {
            return false;
        }
        String haystack = new String(jpegBytes, StandardCharsets.ISO_8859_1);
        return haystack.contains("PatOriginalFileSizeBytes=");
    }

    private byte[] injectPatExifSegment(byte[] jpegBytes, long originalSize) throws IOException {
        long roundedKb = Math.max(1L, (originalSize + 1023) / 1024);
        String payload = "PatOriginalFileSizeBytes=" + originalSize + ";PatOriginalFileSizeKB=" + roundedKb + ";";
        byte[] payloadBytes = payload.getBytes(StandardCharsets.US_ASCII);

        byte[] asciiPrefix = new byte[]{0x41, 0x53, 0x43, 0x49, 0x49, 0x00, 0x00, 0x00};
        ByteArrayOutputStream valueStream = new ByteArrayOutputStream();
        valueStream.write(asciiPrefix);
        valueStream.write(payloadBytes);
        valueStream.write(0);
        byte[] userCommentBytes = valueStream.toByteArray();

        ByteArrayOutputStream exifBodyStream = new ByteArrayOutputStream();
        exifBodyStream.write(new byte[]{0x45, 0x78, 0x69, 0x66, 0x00, 0x00});

        ByteArrayOutputStream tiffStream = new ByteArrayOutputStream();
        DataOutputStream dos = new DataOutputStream(tiffStream);
        dos.writeShort(0x4949);
        dos.writeShort(0x2A);
        dos.writeInt(8);
        dos.writeShort(1);
        dos.writeShort(0x9286);
        dos.writeShort(2);
        dos.writeInt(userCommentBytes.length);
        int dataOffset = 8 + 2 + 12 + 4;
        dos.writeInt(dataOffset);
        dos.writeInt(0);
        dos.write(userCommentBytes);
        dos.flush();

        exifBodyStream.write(tiffStream.toByteArray());
        byte[] exifBody = exifBodyStream.toByteArray();

        int segmentLength = exifBody.length + 2;
        ByteArrayOutputStream segmentStream = new ByteArrayOutputStream();
        segmentStream.write(0xFF);
        segmentStream.write(0xE1);
        segmentStream.write((segmentLength >> 8) & 0xFF);
        segmentStream.write(segmentLength & 0xFF);
        segmentStream.write(exifBody);
        byte[] patSegment = segmentStream.toByteArray();

        ByteArrayOutputStream outputStream = new ByteArrayOutputStream(jpegBytes.length + patSegment.length + 16);
        outputStream.write(jpegBytes, 0, 2);

        int offset = 2;
        while (offset + 3 < jpegBytes.length) {
            if ((jpegBytes[offset] & 0xFF) != 0xFF) {
                break;
            }
            int marker = jpegBytes[offset + 1] & 0xFF;
            if (marker == 0xDA || marker == 0xD9) {
                break;
            }
            int segmentLen = ((jpegBytes[offset + 2] & 0xFF) << 8) | (jpegBytes[offset + 3] & 0xFF);
            int totalSegmentLength = 2 + segmentLen;
            if (segmentLen < 2 || offset + totalSegmentLength > jpegBytes.length) {
                break;
            }
            if (marker >= 0xE0 && marker <= 0xEF) {
                outputStream.write(jpegBytes, offset, totalSegmentLength);
                offset += totalSegmentLength;
                continue;
            }
            break;
        }

        outputStream.write(patSegment);
        outputStream.write(jpegBytes, offset, jpegBytes.length - offset);

        return outputStream.toByteArray();
    }
}


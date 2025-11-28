package com.pat.controller;

import com.pat.service.ImageCompressionService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.InputStreamResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestParam;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;
import java.util.stream.Stream;

@RestController
@RequestMapping("/api/fsphotos")
public class DiskImageController {

    @Value("${file.storage.base-path}")
    private String basePath;

    @Value("${app.imagemaxsizekb:500}")
    private int imageMaxSizeKb;

    @Autowired
    private ImageCompressionService imageCompressionService;
    
    @Autowired(required = false)
    private com.pat.service.MemoryMonitoringService memoryMonitoringService;

    private static final Logger log = LoggerFactory.getLogger(DiskImageController.class);

    private static final Set<String> IMAGE_EXTENSIONS = Set.of(
            ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg", ".tif", ".tiff"
    );

    // Use query parameter to carry sub-paths safely with modern PathPatternParser
    @GetMapping("/list")
    public List<String> listImages(@RequestParam("relativePath") String relativePath,
                                   @RequestParam(value = "limit", required = false) Optional<Integer> limit,
                                   @RequestParam(value = "sort", required = false) Optional<String> sort) throws IOException {
        log.debug("[FSPhotos][LIST] basePath='{}', relativePath='{}'", basePath, relativePath);
        String sanitized = sanitizeRelativePath(relativePath);
        Path dir = Paths.get(basePath, sanitized).normalize();
        log.debug("[FSPhotos][LIST] sanitized='{}', resolvedDir='{}'", sanitized, dir);

        if (!Files.exists(dir)) {
            log.warn("[FSPhotos][LIST] Directory does not exist: {}", dir);
            return List.of();
        }
        if (!Files.isDirectory(dir)) {
            log.warn("[FSPhotos][LIST] Path is not a directory: {}", dir);
            return List.of();
        }

        List<Path> paths = new ArrayList<>();
        try (Stream<Path> stream = Files.list(dir)) {
            stream.filter(Files::isRegularFile)
                  .filter(p -> isImageFile(p.getFileName().toString()))
                  .forEach(paths::add);
        }
        // Sorting by modification time (oldest first)
        paths.sort((a, b) -> {
            try {
                return Long.compare(Files.getLastModifiedTime(a).toMillis(), Files.getLastModifiedTime(b).toMillis());
            } catch (IOException e) {
                return 0;
            }
        });

        // Apply limit (for faster first paint)
        int lim = limit.orElse(0);
        List<String> files = new ArrayList<>();
        paths.stream().limit(lim > 0 ? lim : paths.size())
             .map(Path::getFileName)
             .map(Path::toString)
             .forEach(files::add);

        log.debug("[FSPhotos][LIST] imagesFoundTotal={}, returned={}, dir={}", paths.size(), files.size(), dir);
        return files;
    }

    // Use query parameters to avoid invalid pattern with ** in the middle
    @GetMapping("/image")
    public ResponseEntity<Resource> getImage(@RequestParam("relativePath") String relativePath,
                                             @RequestParam("fileName") String fileName,
                                             @RequestParam(value = "compress", defaultValue = "false") boolean compress) throws IOException {
        log.debug("[FSPhotos][IMAGE] basePath='{}', relativePath='{}', fileName='{}', compress={}", basePath, relativePath, fileName, compress);
        String sanitizedRel = sanitizeRelativePath(relativePath);
        String sanitizedName = sanitizeFileName(fileName);

        Path file = Paths.get(basePath, sanitizedRel, sanitizedName).normalize();
        log.debug("[FSPhotos][IMAGE] sanitizedRel='{}', sanitizedName='{}', resolvedFile='{}'", sanitizedRel, sanitizedName, file);

        if (!Files.exists(file) || !Files.isRegularFile(file)) {
            log.warn("[FSPhotos][IMAGE] File not found or not regular: {}", file);
            return ResponseEntity.notFound().build();
        }

        String contentType = Files.probeContentType(file);
        if (contentType == null) {
            contentType = "application/octet-stream";
        }
        log.debug("[FSPhotos][IMAGE] contentType='{}'", contentType);

        long lastModified = Files.getLastModifiedTime(file).toMillis();

        // Strategy:
        // - If compress=false (original image button): Serve directly via streaming, NO compression, NO cache
        // - If compress=true (normal slideshow): Always compress and cache, regardless of size
        if (compress && imageCompressionService.isImageType(contentType)) {
            long maxSizeInBytes = imageMaxSizeKb * 1024L;
            long originalSize = Files.size(file);
            String cacheKey = String.format("%s|%s|%d|%d", sanitizedRel, sanitizedName, lastModified, maxSizeInBytes);

            // CRITICAL: Check cache FIRST before loading image into memory
            // This ensures we only load image if compressed version doesn't exist
            ImageCompressionService.CompressionResult cachedResult = imageCompressionService.getFromCache(cacheKey);
            if (cachedResult != null) {
                // Compressed version exists in cache - use it without loading original image
                log.debug("[FSPhotos][IMAGE] Using cached compressed version (no memory load for original)");
                byte[] compressedBytes = cachedResult.getData();
                // Use InputStreamResource instead of ByteArrayResource to allow GC to free memory faster
                // Create InputStream from bytes - this allows Spring to stream the response and free memory after sending
                // Note: The bytes reference the cache, but InputStreamResource allows streaming which helps GC
                InputStreamResource resource = new InputStreamResource(new ByteArrayInputStream(compressedBytes));
                ResponseEntity.BodyBuilder builder = ResponseEntity.ok()
                        .lastModified(lastModified)
                        .cacheControl(CacheControl.maxAge(3600, TimeUnit.SECONDS).cachePublic())
                        .contentType(MediaType.parseMediaType(contentType))
                        .contentLength(cachedResult.getCompressedSize())
                        .header("X-Pat-Compression", "applied-cached")
                        .header("X-Pat-Image-Size-Before", Long.toString(cachedResult.getOriginalSize()))
                        .header("X-Pat-Image-Size-After", Long.toString(cachedResult.getCompressedSize()))
                        .header("Access-Control-Expose-Headers", "X-Pat-Compression, X-Pat-Image-Size-Before, X-Pat-Image-Size-After, X-Pat-Exif");

                if (!cachedResult.getExifMetadata().isEmpty()) {
                    String exifSummary = cachedResult.getExifMetadata()
                        .entrySet()
                        .stream()
                        .map(entry -> entry.getKey() + "=" + entry.getValue())
                        .collect(Collectors.joining("; "));
                    builder = builder.header("X-Pat-Exif", exifSummary);
                }

                // Suggest GC after serving cached image to free memory faster
                // This helps when slideshow loads multiple images in parallel
                if (compressedBytes.length > 500 * 1024) { // Only for images > 500KB
                    System.gc(); // Suggest GC for large images
                }
                
                return builder.body(resource);
            }
            
            // Cache miss - must load image into memory to compress
            // Check memory before loading (but compress regardless of size if memory is OK)
            if (memoryMonitoringService != null && !memoryMonitoringService.checkMemoryUsage()) {
                double usagePercent = memoryMonitoringService.getMemoryUsagePercent();
                log.warn("[FSPhotos][IMAGE] Skipping compression due to critical memory usage: {:.1f}%. Serving original image via streaming.", 
                        String.format("%.1f", usagePercent));
                // Fall through to serve original image without compression (streaming)
            } else {
                // CRITICAL: Check image dimensions BEFORE loading into memory
                // This prevents OutOfMemoryError for very large images
                log.debug("[FSPhotos][IMAGE] Cache miss - checking image dimensions before loading (size: {} MB)", 
                        originalSize / (1024.0 * 1024.0));
                byte[] fileBytes = null;
                BufferedImage originalImage = null;
                try {
                    fileBytes = Files.readAllBytes(file);
                    
                    // Check dimensions without loading full image
                    int[] dimensions = ImageCompressionService.getImageDimensions(fileBytes);
                    if (dimensions != null) {
                        int width = dimensions[0];
                        int height = dimensions[1];
                        log.debug("[FSPhotos][IMAGE] Image dimensions: {}x{}", width, height);
                        
                        // Check if dimensions are too large (prevent OutOfMemoryError)
                        if (width > 8000 || height > 8000) {
                            log.warn("[FSPhotos][IMAGE] Image dimensions too large ({}x{}), skipping compression to prevent OutOfMemoryError. Serving original via streaming.", 
                                    width, height);
                            fileBytes = null; // Free memory
                            // Fall through to serve original image without compression (streaming)
                        } else {
                            // Dimensions OK, proceed with loading
                            originalImage = ImageIO.read(new ByteArrayInputStream(fileBytes));
                        }
                    } else {
                        // Cannot read dimensions, try loading anyway (may fail for very large images)
                        log.debug("[FSPhotos][IMAGE] Cannot read dimensions, attempting to load image");
                        originalImage = ImageIO.read(new ByteArrayInputStream(fileBytes));
                    }

                    if (originalImage != null) {
                        try {
                            ImageCompressionService.CompressionResult compressionResult = imageCompressionService.resizeImageIfNeeded(
                                cacheKey,
                                sanitizedName,
                                originalImage,
                                contentType,
                                originalSize,
                                maxSizeInBytes,
                                fileBytes,
                                message -> log.debug("[FSPhotos][IMAGE][compress] {}", message)
                            );

                            // CRITICAL: Free original image and file bytes from memory immediately after compression
                            // The compressed version is now in cache, we don't need the original anymore
                            originalImage.flush();
                            originalImage = null;
                            fileBytes = null; // Allow GC to reclaim memory
                            
                            // Only compressed bytes are kept in memory (much smaller than original)
                            // Result is automatically stored in cache by the service
                            byte[] compressedBytes = compressionResult.getData();
                            // Use InputStreamResource instead of ByteArrayResource to allow GC to free memory faster
                            // Create InputStream from bytes - this allows Spring to stream the response and free memory after sending
                            // Note: The bytes reference the cache, but InputStreamResource allows streaming which helps GC
                            InputStreamResource resource = new InputStreamResource(new ByteArrayInputStream(compressedBytes));
                            ResponseEntity.BodyBuilder builder = ResponseEntity.ok()
                                    .lastModified(lastModified)
                                    .cacheControl(CacheControl.maxAge(3600, TimeUnit.SECONDS).cachePublic())
                                    .contentType(MediaType.parseMediaType(contentType))
                                    .contentLength(compressionResult.getCompressedSize())
                                    .header("X-Pat-Compression", "applied")
                                    .header("X-Pat-Image-Size-Before", Long.toString(compressionResult.getOriginalSize()))
                                    .header("X-Pat-Image-Size-After", Long.toString(compressionResult.getCompressedSize()))
                                    // Ensure the browser can read our custom headers
                                    .header("Access-Control-Expose-Headers", "X-Pat-Compression, X-Pat-Image-Size-Before, X-Pat-Image-Size-After, X-Pat-Exif");

                            if (!compressionResult.getExifMetadata().isEmpty()) {
                                String exifSummary = compressionResult.getExifMetadata()
                                    .entrySet()
                                    .stream()
                                    .map(entry -> entry.getKey() + "=" + entry.getValue())
                                    .collect(Collectors.joining("; "));
                                builder = builder.header("X-Pat-Exif", exifSummary);
                            }

                            // Suggest GC after serving compressed image to free memory faster
                            // This helps when slideshow loads multiple images in parallel
                            if (compressedBytes.length > 500 * 1024) { // Only for images > 500KB
                                System.gc(); // Suggest GC for large images
                            }
                            
                            return builder.body(resource);
                        } catch (OutOfMemoryError e) {
                            log.error("[FSPhotos][IMAGE] OutOfMemoryError during compression. Serving original via streaming.", e);
                            // Free memory immediately
                            if (originalImage != null) {
                                originalImage.flush();
                                originalImage = null;
                            }
                            fileBytes = null;
                            // Fall through to serve original image without compression (streaming)
                        } catch (Exception e) {
                            log.debug("[FSPhotos][IMAGE] Compression failed, falling back to original. Reason: {}", e.getMessage());
                            // Free memory even if compression failed
                            if (originalImage != null) {
                                originalImage.flush();
                                originalImage = null;
                            }
                            fileBytes = null;
                            // Check if it's a dimension/memory related error - if so, serve original
                            if (e.getMessage() != null && 
                                (e.getMessage().contains("dimensions too large") || 
                                 e.getMessage().contains("Insufficient memory") ||
                                 e.getMessage().contains("OutOfMemoryError"))) {
                                // Fall through to serve original image without compression (streaming)
                            }
                        }
                    } else {
                        log.debug("[FSPhotos][IMAGE] Could not decode image for compression, serving original");
                        fileBytes = null; // Free memory
                    }
                } catch (OutOfMemoryError e) {
                    log.error("[FSPhotos][IMAGE] OutOfMemoryError while loading image. Serving original via streaming.", e);
                    // Free memory immediately
                    if (fileBytes != null) {
                        fileBytes = null;
                    }
                    // Fall through to serve original image without compression (streaming)
                } catch (IOException e) {
                    // If IOException contains memory-related message, serve original
                    if (e.getMessage() != null && e.getMessage().contains("OutOfMemoryError")) {
                        log.error("[FSPhotos][IMAGE] Memory error while processing image. Serving original via streaming.", e);
                        fileBytes = null;
                        // Fall through to serve original image without compression (streaming)
                    } else {
                        throw e; // Re-throw other IOExceptions
                    }
                }
            }
        }
        
        // If compress=false OR compression skipped: Serve original image directly via streaming
        // NO compression, NO cache - this is for the "original image" button in slideshow

        InputStream is = Files.newInputStream(file);
        long originalSize = Files.size(file);
        String exifHeader = "PatOriginalFileSizeBytes=" + originalSize + "; PatOriginalFileSizeKB=" + Math.max(1, originalSize / 1024) + "";
        return ResponseEntity.ok()
                .lastModified(lastModified)
                .cacheControl(CacheControl.maxAge(3600, TimeUnit.SECONDS).cachePublic())
                .contentType(MediaType.parseMediaType(contentType))
                // Provide size metadata even when no compression is applied
                .header("X-Pat-Compression", "none")
                .header("X-Pat-Image-Size-Before", Long.toString(originalSize))
                .header("X-Pat-Exif", exifHeader)
                // Ensure the browser can read our custom headers
                .header("Access-Control-Expose-Headers", "X-Pat-Compression, X-Pat-Image-Size-Before, X-Pat-Image-Size-After, X-Pat-Exif")
                .body(new InputStreamResource(is));
    }

    private boolean isImageFile(String fileName) {
        String lower = fileName.toLowerCase(Locale.ROOT);
        return IMAGE_EXTENSIONS.stream().anyMatch(lower::endsWith);
    }

    private String sanitizeRelativePath(String input) {
        if (input == null) return "";
        String cleaned = input.replace("..", "");
        cleaned = cleaned.replace("\\", "/");
        cleaned = cleaned.replaceAll("^/+", "");
        return cleaned;
    }

    private String sanitizeFileName(String input) {
        if (!StringUtils.hasText(input)) return input;
        String name = input;
        name = name.replace("..", "");
        name = name.replace("/", "");
        name = name.replace("\\", "");
        return name;
    }
}
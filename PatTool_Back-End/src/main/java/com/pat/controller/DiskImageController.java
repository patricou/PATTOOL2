package com.pat.controller;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.InputStreamResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestParam;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import javax.imageio.ImageIO;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import com.drew.imaging.ImageMetadataReader;
import com.drew.imaging.ImageProcessingException;
import com.drew.metadata.Metadata;
import com.drew.metadata.MetadataException;
import com.drew.metadata.exif.ExifIFD0Directory;

@RestController
@RequestMapping("/api/fsphotos")
public class DiskImageController {

    @Value("${file.storage.base-path}")
    private String basePath;

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
        // Sorting
        if (sort.isPresent() && sort.get().equalsIgnoreCase("mtime")) {
            paths.sort((a, b) -> {
                try {
                    return Long.compare(Files.getLastModifiedTime(b).toMillis(), Files.getLastModifiedTime(a).toMillis());
                } catch (IOException e) {
                    return 0;
                }
            });
        } else {
            paths.sort(Comparator.comparing(p -> p.getFileName().toString().toLowerCase(Locale.ROOT)));
        }

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
                                             @RequestParam("fileName") String fileName) throws IOException {
        log.debug("[FSPhotos][IMAGE] basePath='{}', relativePath='{}', fileName='{}'", basePath, relativePath, fileName);
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
        InputStream is = Files.newInputStream(file);
        return ResponseEntity.ok()
                .lastModified(lastModified)
                .cacheControl(CacheControl.maxAge(3600, TimeUnit.SECONDS).cachePublic())
                .contentType(MediaType.parseMediaType(contentType))
                .body(new InputStreamResource(is));
    }

    /**
     * Get thumbnail for an image file from filesystem
     * Returns a resized version (max 200x200) of the image while maintaining aspect ratio
     */
    @GetMapping("/thumbnail")
    public ResponseEntity<InputStreamResource> getThumbnail(@RequestParam("relativePath") String relativePath,
                                                            @RequestParam("fileName") String fileName) throws IOException {
        log.debug("[FSPhotos][THUMBNAIL] basePath='{}', relativePath='{}', fileName='{}'", basePath, relativePath, fileName);
        
        String sanitizedRel = sanitizeRelativePath(relativePath);
        String sanitizedName = sanitizeFileName(fileName);

        Path file = Paths.get(basePath, sanitizedRel, sanitizedName).normalize();
        log.debug("[FSPhotos][THUMBNAIL] sanitizedRel='{}', sanitizedName='{}', resolvedFile='{}'", sanitizedRel, sanitizedName, file);

        if (!Files.exists(file) || !Files.isRegularFile(file)) {
            log.warn("[FSPhotos][THUMBNAIL] File not found or not regular: {}", file);
            return ResponseEntity.notFound().build();
        }

        // Check if it's an image file
        if (!isImageFile(fileName)) {
            log.warn("[FSPhotos][THUMBNAIL] File is not an image: {}", fileName);
            return ResponseEntity.badRequest()
                    .body(new InputStreamResource(new ByteArrayInputStream("File is not an image".getBytes())));
        }

        // Determine content type
        String contentType = Files.probeContentType(file);
        if (contentType == null || !contentType.startsWith("image/")) {
            // Try to determine from extension
            String lowerName = fileName.toLowerCase(Locale.ROOT);
            if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) {
                contentType = "image/jpeg";
            } else if (lowerName.endsWith(".png")) {
                contentType = "image/png";
            } else if (lowerName.endsWith(".gif")) {
                contentType = "image/gif";
            } else if (lowerName.endsWith(".bmp")) {
                contentType = "image/bmp";
            } else if (lowerName.endsWith(".webp")) {
                contentType = "image/webp";
            } else {
                contentType = "image/jpeg"; // Default
            }
        }
        log.debug("[FSPhotos][THUMBNAIL] contentType='{}'", contentType);

        // Read the image
        BufferedImage originalImage;
        byte[] originalFileBytes;
        try {
            originalFileBytes = Files.readAllBytes(file);
            originalImage = ImageIO.read(new ByteArrayInputStream(originalFileBytes));
            
            if (originalImage == null) {
                log.warn("[FSPhotos][THUMBNAIL] Could not read image from file: {}", file);
                return ResponseEntity.status(org.springframework.http.HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(new InputStreamResource(new ByteArrayInputStream("Could not read image".getBytes())));
            }
        } catch (IOException e) {
            log.error("[FSPhotos][THUMBNAIL] Error reading image file: {}", file, e);
            return ResponseEntity.status(org.springframework.http.HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new InputStreamResource(new ByteArrayInputStream("Error reading image".getBytes())));
        }
        
        // Apply EXIF orientation
        BufferedImage imageWithOrientation = applyOrientation(originalImage, originalFileBytes);
        
        // Create thumbnail (max 200x200, maintaining aspect ratio)
        BufferedImage thumbnail = createThumbnail(imageWithOrientation, 200, 200);
        
        // Convert thumbnail to byte array
        byte[] thumbnailBytes;
        try {
            thumbnailBytes = imageToByteArray(thumbnail, contentType);
        } catch (IOException e) {
            log.error("[FSPhotos][THUMBNAIL] Error converting thumbnail to bytes: {}", file, e);
            return ResponseEntity.status(org.springframework.http.HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new InputStreamResource(new ByteArrayInputStream("Error creating thumbnail".getBytes())));
        }
        
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.parseMediaType(contentType));
        headers.set("Content-Length", Long.toString(thumbnailBytes.length));
        headers.setCacheControl(CacheControl.maxAge(3600, TimeUnit.SECONDS).cachePublic().getHeaderValue());
        
        return ResponseEntity.ok()
                .headers(headers)
                .body(new InputStreamResource(new ByteArrayInputStream(thumbnailBytes)));
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

    /**
     * Apply EXIF orientation to image if needed
     */
    private BufferedImage applyOrientation(BufferedImage image, byte[] fileBytes) {
        try {
            Metadata metadata = ImageMetadataReader.readMetadata(new ByteArrayInputStream(fileBytes));
            ExifIFD0Directory exifIFD0Directory = metadata.getFirstDirectoryOfType(ExifIFD0Directory.class);
            
            if (exifIFD0Directory != null && exifIFD0Directory.containsTag(ExifIFD0Directory.TAG_ORIENTATION)) {
                int orientation = exifIFD0Directory.getInt(ExifIFD0Directory.TAG_ORIENTATION);
                log.debug("[FSPhotos] Image EXIF orientation: {}", orientation);
                
                // Apply rotation based on EXIF orientation
                switch (orientation) {
                    case 3: // 180 degrees
                        return rotateImage(image, 180);
                    case 6: // 90 degrees CW
                        return rotateImage(image, 90);
                    case 8: // 90 degrees CCW
                        return rotateImage(image, -90);
                    case 2: // Flip horizontal
                    case 4: // Flip vertical
                    case 5: // Flip horizontal + 90 CW
                    case 7: // Flip horizontal + 90 CCW
                        log.debug("[FSPhotos] Flip operations not fully supported, returning as-is");
                        break;
                    default:
                        log.debug("[FSPhotos] No rotation needed (orientation: {})", orientation);
                        break;
                }
            }
        } catch (ImageProcessingException | MetadataException | IOException e) {
            log.debug("[FSPhotos] Could not read EXIF metadata: {}", e.getMessage());
        }
        
        return image;
    }
    
    /**
     * Rotate image by specified angle
     */
    private BufferedImage rotateImage(BufferedImage image, double angle) {
        int width = image.getWidth();
        int height = image.getHeight();
        int type = image.getType();
        
        // Calculate new dimensions for rotation
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
        
        // Translate and rotate
        int offsetX = (newWidth - width) / 2;
        int offsetY = (newHeight - height) / 2;
        g.translate(offsetX, offsetY);
        g.rotate(radians, width / 2.0, height / 2.0);
        g.drawImage(image, 0, 0, null);
        g.dispose();
        
        log.debug("[FSPhotos] Rotated image by {} degrees", angle);
        return rotated;
    }

    /**
     * Create a thumbnail from an image while maintaining aspect ratio
     * @param originalImage The original image
     * @param maxWidth Maximum width for the thumbnail
     * @param maxHeight Maximum height for the thumbnail
     * @return The thumbnail image
     */
    private BufferedImage createThumbnail(BufferedImage originalImage, int maxWidth, int maxHeight) {
        int originalWidth = originalImage.getWidth();
        int originalHeight = originalImage.getHeight();
        
        // Calculate new dimensions maintaining aspect ratio
        double aspectRatio = (double) originalWidth / originalHeight;
        int newWidth, newHeight;
        
        if (originalWidth > originalHeight) {
            // Landscape or square
            newWidth = Math.min(originalWidth, maxWidth);
            newHeight = (int) (newWidth / aspectRatio);
            if (newHeight > maxHeight) {
                newHeight = maxHeight;
                newWidth = (int) (newHeight * aspectRatio);
            }
        } else {
            // Portrait
            newHeight = Math.min(originalHeight, maxHeight);
            newWidth = (int) (newHeight * aspectRatio);
            if (newWidth > maxWidth) {
                newWidth = maxWidth;
                newHeight = (int) (newWidth / aspectRatio);
            }
        }
        
        // If image is already smaller than thumbnail size, return original
        if (originalWidth <= maxWidth && originalHeight <= maxHeight) {
            return originalImage;
        }
        
        // Create resized image
        BufferedImage thumbnail = new BufferedImage(newWidth, newHeight, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = thumbnail.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.drawImage(originalImage, 0, 0, newWidth, newHeight, null);
        g.dispose();
        
        return thumbnail;
    }

    /**
     * Convert BufferedImage to byte array
     * @param image The image to convert
     * @param contentType The content type (determines format)
     * @return The image as byte array
     * @throws IOException If conversion fails
     */
    private byte[] imageToByteArray(BufferedImage image, String contentType) throws IOException {
        ByteArrayOutputStream outputStream = new ByteArrayOutputStream();
        
        String format = "jpeg"; // Default format
        if (contentType != null) {
            if (contentType.contains("png")) {
                format = "png";
            } else if (contentType.contains("gif")) {
                format = "gif";
            } else if (contentType.contains("bmp")) {
                format = "bmp";
            } else if (contentType.contains("webp")) {
                format = "webp";
            }
        }
        
        if (format.equals("jpeg")) {
            // Convert to RGB if needed for JPEG
            BufferedImage rgbImage;
            if (image.getType() == BufferedImage.TYPE_INT_RGB || image.getType() == BufferedImage.TYPE_INT_ARGB) {
                rgbImage = image;
            } else {
                rgbImage = new BufferedImage(image.getWidth(), image.getHeight(), BufferedImage.TYPE_INT_RGB);
                Graphics2D g = rgbImage.createGraphics();
                g.drawImage(image, 0, 0, null);
                g.dispose();
            }
            
            javax.imageio.ImageWriter writer = ImageIO.getImageWritersByFormatName("jpeg").next();
            javax.imageio.plugins.jpeg.JPEGImageWriteParam params = new javax.imageio.plugins.jpeg.JPEGImageWriteParam(null);
            params.setCompressionMode(javax.imageio.ImageWriteParam.MODE_EXPLICIT);
            params.setCompressionQuality(0.7f); // Optimized quality for thumbnails (smaller file size, faster loading)
            params.setOptimizeHuffmanTables(true); // Enable Huffman optimization for better compression
            javax.imageio.stream.ImageOutputStream imageOutputStream = ImageIO.createImageOutputStream(outputStream);
            writer.setOutput(imageOutputStream);
            writer.write(null, new javax.imageio.IIOImage(rgbImage, null, null), params);
            writer.dispose();
        } else {
            ImageIO.write(image, format, outputStream);
        }
        
        return outputStream.toByteArray();
    }
}



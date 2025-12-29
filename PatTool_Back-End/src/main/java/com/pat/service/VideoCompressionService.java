package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/**
 * Service for compressing videos using FFmpeg
 * Note: FFmpeg must be installed on the system for this to work
 */
@Service
public class VideoCompressionService {

    private static final Logger log = LoggerFactory.getLogger(VideoCompressionService.class);

    @Value("${app.video.ffmpeg.path:ffmpeg}")
    private String ffmpegPath;

    @Value("${app.video.compression.enabled:false}")
    private boolean compressionEnabled;

    @Value("${app.video.compression.tempdir:${java.io.tmpdir}}")
    private String tempDir;
    
    // Semaphore to limit concurrent video compressions and prevent resource exhaustion
    private final Semaphore compressionSemaphore;
    
    public VideoCompressionService(
        @Value("${app.video.compression.max-concurrency:2}") int maxConcurrentCompressions
    ) {
        int permits = Math.max(1, maxConcurrentCompressions);
        this.compressionSemaphore = new Semaphore(permits, true); // Fair semaphore
        log.info("VideoCompressionService initialized with {} concurrent compression permits", permits);
    }

    /**
     * Compression result
     */
    public static class CompressionResult {
        private final byte[] data;
        private final long originalSize;
        private final long compressedSize;
        private final boolean success;

        public CompressionResult(byte[] data, long originalSize, long compressedSize, boolean success) {
            this.data = data;
            this.originalSize = originalSize;
            this.compressedSize = compressedSize;
            this.success = success;
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

        public boolean isSuccess() {
            return success;
        }
    }

    /**
     * Check if FFmpeg is available
     */
    public boolean isFFmpegAvailable() {
        if (!compressionEnabled) {
            return false;
        }

        try {
            Process process = new ProcessBuilder(ffmpegPath, "-version")
                    .redirectErrorStream(true)
                    .start();
            
            boolean finished = process.waitFor(5, TimeUnit.SECONDS);
            if (finished && process.exitValue() == 0) {
                log.debug("FFmpeg is available at: " + ffmpegPath);
                return true;
            }
        } catch (Exception e) {
            log.debug("FFmpeg not available: " + e.getMessage());
        }
        return false;
    }

    /**
     * Compress video to specified quality
     * @param videoData Original video data
     * @param quality Quality level (high, medium, low)
     * @param originalFilename Original filename (for format detection)
     * @return Compressed video data
     */
    public CompressionResult compressVideo(byte[] videoData, String quality, String originalFilename) {
        if (!compressionEnabled || !isFFmpegAvailable()) {
            log.debug("Video compression disabled or FFmpeg not available");
            return new CompressionResult(videoData, videoData.length, videoData.length, false);
        }

        boolean permitAcquired = false;
        Path tempInputFile = null;
        Path tempOutputFile = null;
        Process process = null;

        try {
            log.debug("Video compression requested for '{}'. Available permits before acquire: {}", 
                originalFilename, compressionSemaphore.availablePermits());
            compressionSemaphore.acquire();
            permitAcquired = true;
            log.debug("Compression permit granted for '{}'. Remaining permits: {}", 
                originalFilename, compressionSemaphore.availablePermits());
            // Create temporary files
            tempInputFile = Files.createTempFile(Paths.get(tempDir), "video_input_", getExtension(originalFilename));
            tempOutputFile = Files.createTempFile(Paths.get(tempDir), "video_output_", ".mp4");

            // Write input video to temp file
            Files.write(tempInputFile, videoData);

            // Build FFmpeg command based on quality
            List<String> command = buildFFmpegCommand(tempInputFile.toString(), tempOutputFile.toString(), quality);

            log.debug("Executing FFmpeg command: " + String.join(" ", command));

            // Execute FFmpeg
            ProcessBuilder processBuilder = new ProcessBuilder(command);
            processBuilder.redirectErrorStream(true);
            process = processBuilder.start();

            // Read output for debugging
            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");
                }
            }

            // Wait for process to complete (max 5 minutes for video compression)
            boolean finished = process.waitFor(5, TimeUnit.MINUTES);
            
            if (!finished) {
                log.error("FFmpeg compression timeout for '{}'", originalFilename);
                // Process will be cleaned up in finally block
                return new CompressionResult(videoData, videoData.length, videoData.length, false);
            }

            if (process.exitValue() != 0) {
                log.error("FFmpeg compression failed for '{}'. Exit code: {}", originalFilename, process.exitValue());
                log.error("FFmpeg output: {}", output.toString());
                return new CompressionResult(videoData, videoData.length, videoData.length, false);
            }

            // Read compressed video
            byte[] compressedData = Files.readAllBytes(tempOutputFile);
            long originalSize = videoData.length;
            long compressedSize = compressedData.length;

            log.info("Video compressed: {} KB → {} KB (quality: {})", 
                    originalSize / 1024, compressedSize / 1024, quality);

            return new CompressionResult(compressedData, originalSize, compressedSize, true);

        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            log.error("Video compression interrupted for '{}'", originalFilename, e);
            return new CompressionResult(videoData, videoData.length, videoData.length, false);
        } catch (Exception e) {
            log.error("Error compressing video '{}': {}", originalFilename, e.getMessage(), e);
            return new CompressionResult(videoData, videoData.length, videoData.length, false);
        } finally {
            // Always clean up process to prevent resource leaks
            if (process != null) {
                try {
                    if (process.isAlive()) {
                        log.debug("Process still alive, destroying forcibly for '{}'", originalFilename);
                        process.destroyForcibly();
                        // Wait up to 5 seconds for process to terminate
                        boolean terminated = process.waitFor(5, TimeUnit.SECONDS);
                        if (!terminated) {
                            log.warn("FFmpeg process did not terminate within 5 seconds for '{}'", originalFilename);
                        }
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    log.warn("Interrupted while waiting for FFmpeg process to terminate", e);
                } catch (Exception e) {
                    log.warn("Error cleaning up FFmpeg process for '{}': {}", originalFilename, e.getMessage());
                }
            }
            
            // Clean up temp files
            try {
                if (tempInputFile != null) {
                    Files.deleteIfExists(tempInputFile);
                }
                if (tempOutputFile != null) {
                    Files.deleteIfExists(tempOutputFile);
                }
            } catch (IOException e) {
                log.warn("Error cleaning up temp files for '{}': {}", originalFilename, e.getMessage());
            }
            
            // Always release semaphore permit
            if (permitAcquired) {
                compressionSemaphore.release();
                log.debug("Compression permit released for '{}'. Available permits after release: {}", 
                    originalFilename, compressionSemaphore.availablePermits());
            }
        }
    }

    /**
     * Build FFmpeg command for compression
     */
    private List<String> buildFFmpegCommand(String inputFile, String outputFile, String quality) {
        List<String> command = new ArrayList<>();
        command.add(ffmpegPath);
        command.add("-i");
        command.add(inputFile);
        command.add("-y"); // Overwrite output file
        command.add("-c:v");
        command.add("libx264"); // Video codec
        command.add("-c:a");
        command.add("aac"); // Audio codec
        command.add("-movflags");
        command.add("+faststart"); // Optimize for web streaming

        // Quality settings based on quality level
        switch (quality.toLowerCase()) {
            case "low":
                command.add("-preset");
                command.add("ultrafast"); // Fast encoding
                command.add("-crf");
                command.add("32"); // Lower quality, smaller file
                command.add("-vf");
                command.add("scale=640:-2"); // Scale to 640px width
                command.add("-b:v");
                command.add("500k"); // Video bitrate
                command.add("-b:a");
                command.add("64k"); // Audio bitrate
                break;
            case "medium":
                command.add("-preset");
                command.add("medium");
                command.add("-crf");
                command.add("28");
                command.add("-vf");
                command.add("scale=1280:-2"); // Scale to 1280px width
                command.add("-b:v");
                command.add("1500k");
                command.add("-b:a");
                command.add("128k");
                break;
            case "high":
            default:
                command.add("-preset");
                command.add("slow"); // Better quality
                command.add("-crf");
                command.add("23"); // High quality
                command.add("-b:v");
                command.add("3000k");
                command.add("-b:a");
                command.add("192k");
                break;
        }

        command.add(outputFile);
        return command;
    }

    /**
     * Get file extension from filename
     */
    private String getExtension(String filename) {
        if (filename == null || filename.isEmpty()) {
            return ".mp4";
        }
        int lastDot = filename.lastIndexOf('.');
        if (lastDot > 0 && lastDot < filename.length() - 1) {
            return filename.substring(lastDot);
        }
        return ".mp4";
    }
}


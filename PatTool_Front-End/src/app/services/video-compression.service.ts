import { Injectable } from '@angular/core';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

export interface CompressionProgress {
    stage: 'analyzing' | 'compressing' | 'finalizing' | 'complete' | 'error' | 'loading-ffmpeg' | 'converting';
    progress: number; // 0-100
    message: string;
    originalSize: number;
    compressedSize?: number;
}

@Injectable({
    providedIn: 'root'
})
export class VideoCompressionService {
    
    private ffmpegInstance: FFmpeg | null = null;
    private ffmpegLoaded: boolean = false;
    private ffmpegLoading: boolean = false;

    /**
     * Compress video file using browser's MediaRecorder API
     * @param file Original video file
     * @param quality Quality level: 'low', 'medium', 'high'
     * @param onProgress Callback for progress updates
     * @returns Compressed video file as Blob (or original if compression fails)
     */
    async compressVideo(
        file: File,
        quality: 'low' | 'medium' | 'high' = 'low',
        onProgress?: (progress: CompressionProgress) => void
    ): Promise<Blob> {
        return new Promise(async (resolve, reject) => {
            try {
                // Report initial progress
                if (onProgress) {
                const formatInfo = this.getOutputFormatInfo(file.name);
                const canRead = this.canReadVideoFormat(file.name);
                const isAvi = file.name.toLowerCase().endsWith('.avi');
                const isMov = file.name.toLowerCase().endsWith('.mov');
                
                // For AVI files, always indicate conversion to MP4
                if (isAvi) {
                    if (onProgress) {
                        onProgress({
                            stage: 'analyzing',
                            progress: 2,
                            message: `AVI format detected. File will be converted to MP4 after compression.`,
                            originalSize: file.size
                        });
                    }
                }
                
                if (!canRead) {
                    if (onProgress) {
                        onProgress({
                            stage: 'error',
                            progress: 0,
                            message: `Unsupported format: ${file.name}. Using original file.`,
                            originalSize: file.size
                        });
                    }
                    // Return original file
                    const buffer = await file.arrayBuffer();
                    resolve(new Blob([buffer], { type: file.type }));
                    return;
                }
                
                // Special handling for AVI and MOV files
                if ((isAvi || isMov) && onProgress) {
                    const targetMimeType = this.getMimeType(file.name);
                    const targetFormat = targetMimeType.includes('mp4') ? 'MP4' : 'WebM';
                    onProgress({
                        stage: 'analyzing',
                        progress: 2,
                        message: `${isAvi ? 'AVI' : 'MOV'} format detected. File will be converted to ${targetFormat} after compression.`,
                        originalSize: file.size
                    });
                }
                    
                    onProgress({
                        stage: 'analyzing',
                        progress: 0,
                        message: `Analyzing video: ${file.name} (${this.formatFileSize(file.size)})${formatInfo}`,
                        originalSize: file.size
                    });
                }

                // Check if compression is supported
                if (!this.isSupported()) {
                    if (onProgress) {
                        onProgress({
                            stage: 'error',
                            progress: 0,
                            message: 'Video compression not supported in this browser',
                            originalSize: file.size
                        });
                    }
                    // Return original file
                    const buffer = await file.arrayBuffer();
                    resolve(new Blob([buffer], { type: file.type }));
                    return;
                }

                // Create video element
                const video = document.createElement('video');
                video.preload = 'metadata';
                video.muted = true;
                video.playsInline = true;
                // Remove crossOrigin for local files - it can cause CORS issues
                // video.crossOrigin = 'anonymous';

                const objectUrl = URL.createObjectURL(file);
                video.src = objectUrl;

                // Track if we've already handled the error
                let errorHandled = false;
                let metadataLoaded = false;

                video.onerror = async (e) => {
                    if (!errorHandled) {
                        errorHandled = true;
                        URL.revokeObjectURL(objectUrl);
                        const errorMsg = video.error?.message || 'Unknown error';
                        const errorCode = video.error?.code;
                        console.warn('Video error:', errorMsg, 'Code:', errorCode, video.error);
                        
                        // Check if it's a codec/format issue
                        const isCodecError = errorMsg.includes('DEMUXER_ERROR') || 
                                          errorMsg.includes('DECODE_ERROR') ||
                                          errorMsg.includes('FORMAT_ERROR') ||
                                          errorCode === 4; // MEDIA_ERR_SRC_NOT_SUPPORTED
                        
                        const isAvi = file.name.toLowerCase().endsWith('.avi');
                        const isMov = file.name.toLowerCase().endsWith('.mov');
                        
                        // If it's a codec error and it's an AVI/MOV file, inform user that conversion is not available
                        if (isCodecError && (isAvi || isMov)) {
                            if (onProgress) {
                                onProgress({
                                    stage: 'error',
                                    progress: 0,
                                    message: `Browser cannot read this ${isAvi ? 'AVI' : 'MOV'} file (unsupported codec). Original file will be uploaded as-is. To convert to MP4, use an external tool (e.g., VLC, HandBrake) before upload.`,
                                    originalSize: file.size
                                });
                            }
                            
                            // Return original file - conversion not available for unsupported codecs
                            const buffer = await file.arrayBuffer();
                            resolve(new Blob([buffer], { type: file.type }));
                            return;
                        }
                        
                        let userMessage = `Error loading video: ${errorMsg}`;
                        if (isCodecError) {
                            userMessage = `Codec not supported by browser. Original file will be used without compression.`;
                        }
                        
                        if (onProgress) {
                            onProgress({
                                stage: 'error',
                                progress: 0,
                                message: userMessage,
                                originalSize: file.size
                            });
                        }
                        
                        // Return original file instead of rejecting
                        file.arrayBuffer().then(buffer => {
                            resolve(new Blob([buffer], { type: file.type }));
                        }).catch(() => {
                            // If even that fails, reject
                            reject(new Error('Error loading video: ' + errorMsg));
                        });
                    }
                };

                video.onloadedmetadata = async () => {
                    if (errorHandled) return; // Don't proceed if error already handled
                    
                    metadataLoaded = true;
                    
                    // Check if video has valid dimensions (indicates it loaded successfully)
                    if (video.videoWidth === 0 && video.videoHeight === 0) {
                        console.warn('Video loaded but has zero dimensions, may not be playable');
                        if (onProgress) {
                            onProgress({
                                stage: 'error',
                                progress: 0,
                                message: 'Video cannot be read (invalid dimensions). Using original file.',
                                originalSize: file.size
                            });
                        }
                        URL.revokeObjectURL(objectUrl);
                        const buffer = await file.arrayBuffer();
                        resolve(new Blob([buffer], { type: file.type }));
                        return;
                    }
                    
                    try {
                        // Don't revoke URL yet - we need it for playback
                        // URL.revokeObjectURL(objectUrl);

                        const originalWidth = video.videoWidth;
                        const originalHeight = video.videoHeight;
                        const duration = video.duration;

                        if (onProgress) {
                            onProgress({
                                stage: 'analyzing',
                                progress: 5,
                                message: `Video info: ${originalWidth}x${originalHeight}, ${duration.toFixed(1)}s`,
                                originalSize: file.size
                            });
                        }

                        // Calculate compression settings (pass file size for optimization)
                        const settings = this.getCompressionSettings(quality, originalWidth, originalHeight, file.size);
                        
                        // For very large videos, show a warning
                        if (file.size > 200 * 1024 * 1024) {
                            if (onProgress) {
                                onProgress({
                                    stage: 'compressing',
                                    progress: 8,
                                    message: `Large video detected (${this.formatFileSize(file.size)}) - Using optimized compression settings...`,
                                    originalSize: file.size
                                });
                            }
                        }

                        if (onProgress) {
                            onProgress({
                                stage: 'compressing',
                                progress: 10,
                                message: `Compressing to ${quality} quality (${settings.width}x${settings.height}, ${settings.frameRate}fps)...`,
                                originalSize: file.size
                            });
                        }

                        // Create canvas
                        const canvas = document.createElement('canvas');
                        canvas.width = settings.width;
                        canvas.height = settings.height;
                        const ctx = canvas.getContext('2d', { 
                            willReadFrequently: false,
                            alpha: false 
                        });

                        if (!ctx) {
                            throw new Error('Could not get canvas context');
                        }

                        // Create MediaRecorder with both video and audio
                        const canvasStream = canvas.captureStream(settings.frameRate);
                        // Pass filename to prefer MP4 for AVI/MOV files
                        let mimeType = this.getMimeType(file.name);
                        
                        if (!MediaRecorder.isTypeSupported(mimeType)) {
                            // Try fallback types
                            const fallbackTypes = ['video/mp4', 'video/webm'];
                            const supportedType = fallbackTypes.find(type => MediaRecorder.isTypeSupported(type));
                            if (!supportedType) {
                                throw new Error(`No supported video MIME type found`);
                            }
                            console.warn(`Requested MIME type ${mimeType} not supported, using ${supportedType}`);
                            mimeType = supportedType; // Use supported type
                        }

                        // Create a combined stream with video from canvas and audio from video element
                        const combinedStream = new MediaStream();
                        
                        // Add video track from canvas
                        canvasStream.getVideoTracks().forEach(track => {
                            combinedStream.addTrack(track);
                        });
                        
                        // Try to get audio from the video element
                        // Note: We need to create an audio context to capture audio
                        let audioContext: AudioContext | null = null;
                        let audioSource: MediaElementAudioSourceNode | null = null;
                        let audioDestination: MediaStreamAudioDestinationNode | null = null;
                        
                        try {
                            audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
                            audioSource = audioContext.createMediaElementSource(video);
                            audioDestination = audioContext.createMediaStreamDestination();
                            
                            // Connect video audio to destination
                            audioSource.connect(audioDestination);
                            audioSource.connect(audioContext.destination); // Also play audio
                            
                            // Add audio track to combined stream
                            audioDestination.stream.getAudioTracks().forEach(track => {
                                combinedStream.addTrack(track);
                            });
                        } catch (audioError: any) {
                            console.warn('Could not capture audio, video will be muted:', audioError);
                            // Continue without audio - video will be muted
                        }

                        const mediaRecorder = new MediaRecorder(combinedStream, {
                            mimeType: mimeType,
                            videoBitsPerSecond: settings.bitrate,
                            audioBitsPerSecond: 128000 // 128 kbps for audio
                        });

                        const chunks: Blob[] = [];
                        let lastProgressUpdate = Date.now();
                        let compressedSize = 0;

                        mediaRecorder.ondataavailable = (event) => {
                            if (event.data && event.data.size > 0) {
                                chunks.push(event.data);
                                compressedSize += event.data.size;
                                
                                // Update progress every 500ms
                                const now = Date.now();
                                if (onProgress && now - lastProgressUpdate > 500) {
                                    const estimatedProgress = Math.min(90, 10 + (video.currentTime / duration) * 80);
                                    
                                    onProgress({
                                        stage: 'compressing',
                                        progress: estimatedProgress,
                                        message: `Compressing... ${Math.round(estimatedProgress)}% (${this.formatFileSize(compressedSize)})`,
                                        originalSize: file.size,
                                        compressedSize: compressedSize
                                    });
                                    lastProgressUpdate = now;
                                }
                            }
                        };

                        mediaRecorder.onstop = () => {
                            URL.revokeObjectURL(objectUrl); // Clean up URL
                            
                            // Clean up audio resources
                            if (audioSource) {
                                try {
                                    audioSource.disconnect();
                                } catch (e) {
                                    // Ignore disconnect errors
                                }
                            }
                            if (audioDestination) {
                                try {
                                    audioDestination.disconnect();
                                } catch (e) {
                                    // Ignore disconnect errors
                                }
                            }
                            if (audioContext && audioContext.state !== 'closed') {
                                audioContext.close().catch(() => {
                                    // Ignore close errors
                                });
                            }
                            
                            if (onProgress) {
                                onProgress({
                                    stage: 'finalizing',
                                    progress: 95,
                                    message: 'Finalizing compressed video...',
                                    originalSize: file.size
                                });
                            }

                            const blob = new Blob(chunks, { type: mimeType });
                            
                            // Store output filename in blob for reference
                            const outputFilename = this.getOutputFilename(file.name, mimeType);
                            (blob as any).name = outputFilename; // Store filename in blob for later use
                            
                            if (onProgress) {
                                const reduction = ((1 - blob.size / file.size) * 100);
                                const isAvi = file.name.toLowerCase().endsWith('.avi');
                                const isMov = file.name.toLowerCase().endsWith('.mov');
                                const formatChange = (isAvi || isMov) ? 
                                                   ' (converted to ' + (mimeType.includes('mp4') ? 'MP4' : 'WebM') + ')' : '';
                                
                                onProgress({
                                    stage: 'complete',
                                    progress: 100,
                                    message: `Compression complete: ${this.formatFileSize(file.size)} → ${this.formatFileSize(blob.size)} (${reduction > 0 ? reduction.toFixed(1) : '0.0'}% reduction)${formatChange}`,
                                    originalSize: file.size,
                                    compressedSize: blob.size
                                });
                            }

                            resolve(blob);
                        };

                        mediaRecorder.onerror = (event: any) => {
                            const errorMsg = event.error?.message || 'Unknown error';
                            console.error('MediaRecorder error:', errorMsg);
                            
                            // Stop drawing if still active
                            if (animationFrameId !== null) {
                                cancelAnimationFrame(animationFrameId);
                            }
                            
                            // Instead of rejecting, return original file
                            if (onProgress) {
                                onProgress({
                                    stage: 'error',
                                    progress: 0,
                                    message: `Compression error: ${errorMsg}. Using original file.`,
                                    originalSize: file.size
                                });
                            }
                            
                            // Return original file instead of rejecting
                            file.arrayBuffer().then(buffer => {
                                resolve(new Blob([buffer], { type: file.type }));
                            }).catch(() => {
                                // If even that fails, reject
                                reject(new Error('MediaRecorder error: ' + errorMsg));
                            });
                        };

                        // Start recording
                        mediaRecorder.start(1000); // Collect data every second

                        // Draw video frames to canvas
                        video.currentTime = 0;
                        
                        // For large videos, preload more data
                        if (file.size > 200 * 1024 * 1024) {
                            video.preload = 'auto';
                        }
                        
                        // Don't mute the video - we need the audio!
                        video.muted = false;
                        
                        // Play video with error handling
                        try {
                            await video.play();
                        } catch (err: any) {
                            console.warn('Video play error:', err);
                            // Try with muted first to see if it's a play policy issue
                            video.muted = true;
                            try {
                                await video.play();
                                // If muted play works, try unmuting after a short delay
                                setTimeout(() => {
                                    video.muted = false;
                                }, 100);
                            } catch (err2: any) {
                                console.warn('Video play failed:', err2);
                                // Continue anyway - the drawFrame will handle it
                            }
                        }

                        // Wait for video to be ready with longer timeout for large videos
                        const loadTimeout = file.size > 200 * 1024 * 1024 ? 15000 : 10000; // 15s for large, 10s for normal
                        
                        await new Promise(resolve => {
                            let resolved = false;
                            
                            const resolveOnce = () => {
                                if (!resolved) {
                                    resolved = true;
                                    resolve(null);
                                }
                            };
                            
                            video.oncanplay = () => {
                                video.oncanplay = null;
                                resolveOnce();
                            };
                            
                            video.oncanplaythrough = () => {
                                resolveOnce();
                            };
                            
                            // Timeout with longer delay for large videos
                            setTimeout(() => {
                                if (!resolved) {
                                    console.warn('Video load timeout, proceeding anyway');
                                    resolveOnce();
                                }
                            }, loadTimeout);
                        });

                        let lastFrameTime = 0;
                        const frameInterval = 1000 / settings.frameRate;

                        let isDrawing = false;
                        let animationFrameId: number | null = null;
                        let lastDrawnTime = 0;
                        let consecutiveErrors = 0;
                        const maxConsecutiveErrors = 10;

                        const drawFrame = (currentTime: number) => {
                            // Check for errors
                            if (video.error) {
                                consecutiveErrors++;
                                if (consecutiveErrors > maxConsecutiveErrors) {
                                    console.error('Too many consecutive errors, stopping compression');
                                    const state = mediaRecorder.state;
                                    if (state === 'recording' || state === 'paused') {
                                        mediaRecorder.stop();
                                    }
                                    if (animationFrameId !== null) {
                                        cancelAnimationFrame(animationFrameId);
                                    }
                                    return;
                                }
                            } else {
                                consecutiveErrors = 0; // Reset on success
                            }

                            // Check if video is finished or paused
                            const isFinished = video.ended || 
                                             (video.paused && Math.abs(video.currentTime - duration) < 0.5) ||
                                             video.currentTime >= duration - 0.1;
                             
                            const state = mediaRecorder.state;
                            if (isFinished || state === 'inactive') {
                                if (state === 'recording' || state === 'paused') {
                                    mediaRecorder.stop();
                                }
                                if (animationFrameId !== null) {
                                    cancelAnimationFrame(animationFrameId);
                                }
                                isDrawing = false;
                                return;
                            }

                            // Throttle frame drawing to match frame rate
                            // Use a more lenient check for large videos
                            const timeSinceLastFrame = currentTime - lastFrameTime;
                            const shouldDraw = timeSinceLastFrame >= frameInterval * 0.9; // 90% of interval for smoother playback
                            
                            if (shouldDraw) {
                                try {
                                    // Check if video is ready to be drawn
                                    if (video.readyState >= 2) { // HAVE_CURRENT_DATA or higher
                                        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                                        lastFrameTime = currentTime;
                                        lastDrawnTime = video.currentTime;
                                    } else {
                                        // Video not ready yet, wait a bit
                                        // Don't update lastFrameTime so we'll try again soon
                                    }
                                } catch (err: any) {
                                    console.warn('Error drawing frame:', err);
                                    consecutiveErrors++;
                                    if (consecutiveErrors > maxConsecutiveErrors) {
                                        console.error('Too many draw errors, stopping');
                                        const state = mediaRecorder.state;
                                        if (state === 'recording' || state === 'paused') {
                                            mediaRecorder.stop();
                                        }
                                        if (animationFrameId !== null) {
                                            cancelAnimationFrame(animationFrameId);
                                        }
                                        return;
                                    }
                                }
                            }

                            // Continue drawing
                            animationFrameId = requestAnimationFrame(drawFrame);
                        };

                        // Start drawing frames
                        isDrawing = true;
                        
                        // For large videos, add a small delay to ensure everything is ready
                        if (file.size > 200 * 1024 * 1024) {
                            await new Promise(resolve => setTimeout(resolve, 200));
                        }
                        
                        animationFrameId = requestAnimationFrame(drawFrame);
                        
                        // Add a safety timeout for very long videos
                        if (duration > 300) { // Videos longer than 5 minutes
                            const maxCompressionTime = duration * 2 * 1000; // 2x video duration in ms
                            setTimeout(() => {
                                const state = mediaRecorder.state;
                                if ((state === 'recording' || state === 'paused') && isDrawing) {
                                    console.warn('Compression timeout reached, stopping');
                                    if (onProgress) {
                                        onProgress({
                                            stage: 'error',
                                            progress: 0,
                                            message: 'Compression timeout. Using original file.',
                                            originalSize: file.size
                                        });
                                    }
                                    mediaRecorder.stop();
                                    if (animationFrameId !== null) {
                                        cancelAnimationFrame(animationFrameId);
                                    }
                                }
                            }, maxCompressionTime);
                        }

                        // Stop recording when video ends
                        video.onended = () => {
                            URL.revokeObjectURL(objectUrl); // Clean up URL when done
                            const state = mediaRecorder.state;
                            if (state === 'recording' || state === 'paused') {
                                mediaRecorder.stop();
                            }
                            if (animationFrameId !== null) {
                                cancelAnimationFrame(animationFrameId);
                            }
                            isDrawing = false;
                        };

                        // Handle video errors during playback - but don't override the main error handler
                            const playbackErrorHandler = () => {
                                if (!errorHandled && metadataLoaded) {
                                    // Only handle playback errors, not initial load errors
                                    URL.revokeObjectURL(objectUrl);
                                    const state = mediaRecorder.state;
                                    if (state === 'recording' || state === 'paused') {
                                        mediaRecorder.stop();
                                    }
                                    if (animationFrameId !== null) {
                                        cancelAnimationFrame(animationFrameId);
                                    }
                                    isDrawing = false;
                                
                                if (onProgress) {
                                    onProgress({
                                        stage: 'error',
                                        progress: 0,
                                        message: `Error during playback. Using original file.`,
                                        originalSize: file.size
                                    });
                                }
                                
                                // Return what we have so far, or original
                                if (chunks.length > 0) {
                                    const blob = new Blob(chunks, { type: mimeType });
                                    resolve(blob);
                                } else {
                                    file.arrayBuffer().then(buffer => {
                                        resolve(new Blob([buffer], { type: file.type }));
                                    });
                                }
                            }
                        };
                        
                        // Add additional error listener for playback errors
                        video.addEventListener('error', playbackErrorHandler);

                    } catch (error: any) {
                        // Fallback: return original file
                        console.warn('Video compression failed, using original:', error);
                        if (onProgress) {
                            onProgress({
                                stage: 'error',
                                progress: 0,
                                message: `Compression failed: ${error.message}. Using original file.`,
                                originalSize: file.size
                            });
                        }
                        const buffer = await file.arrayBuffer();
                        resolve(new Blob([buffer], { type: file.type }));
                    }
                };

                // Error handling is done above in onerror handler
                // Load video
                video.load();

            } catch (error: any) {
                // Fallback: return original file
                console.warn('Video compression error, using original:', error);
                if (onProgress) {
                    onProgress({
                        stage: 'error',
                        progress: 0,
                        message: `Error: ${error.message}. Using original file.`,
                        originalSize: file.size
                    });
                }
                try {
                    const buffer = await file.arrayBuffer();
                    resolve(new Blob([buffer], { type: file.type }));
                } catch (e) {
                    reject(error);
                }
            }
        });
    }

    /**
     * Get compression settings based on quality and original dimensions
     * Automatically adjusts for very large videos
     */
    private getCompressionSettings(quality: string, originalWidth: number, originalHeight: number, fileSize?: number) {
        const aspectRatio = originalWidth / originalHeight;
        let width: number;
        let height: number;
        let bitrate: number;
        let frameRate: number;

        // For very large files (>200MB), use more aggressive compression
        const isVeryLarge = fileSize && fileSize > 200 * 1024 * 1024;
        
        switch (quality) {
            case 'low':
                // For very large videos, use even lower settings
                if (isVeryLarge) {
                    width = Math.min(480, originalWidth);
                    height = Math.round(width / aspectRatio);
                    bitrate = 300000; // 300 kbps for very large videos
                    frameRate = 12;
                } else {
                    width = Math.min(640, originalWidth);
                    height = Math.round(width / aspectRatio);
                    bitrate = 500000; // 500 kbps
                    frameRate = 15;
                }
                break;
            case 'medium':
                if (isVeryLarge) {
                    width = Math.min(960, originalWidth);
                    height = Math.round(width / aspectRatio);
                    bitrate = 1000000; // 1 Mbps
                    frameRate = 20;
                } else {
                    width = Math.min(1280, originalWidth);
                    height = Math.round(width / aspectRatio);
                    bitrate = 1500000; // 1.5 Mbps
                    frameRate = 24;
                }
                break;
            case 'high':
            default:
                if (isVeryLarge) {
                    width = Math.min(1280, originalWidth);
                    height = Math.round(width / aspectRatio);
                    bitrate = 2000000; // 2 Mbps
                    frameRate = 24;
                } else {
                    width = Math.min(1920, originalWidth);
                    height = Math.round(width / aspectRatio);
                    bitrate = 3000000; // 3 Mbps
                    frameRate = 30;
                }
                break;
        }

        return { width, height, bitrate, frameRate };
    }

    /**
     * Convert video using FFmpeg.wasm (fallback when browser can't read the file)
     */
    private async convertWithFFmpeg(
        file: File,
        quality: 'low' | 'medium' | 'high',
        onProgress?: (progress: CompressionProgress) => void
    ): Promise<Blob> {
        try {
            // Load FFmpeg if not already loaded
            if (!this.ffmpegLoaded && !this.ffmpegLoading) {
                this.ffmpegLoading = true;
                
                if (onProgress) {
                    onProgress({
                        stage: 'loading-ffmpeg',
                        progress: 10,
                        message: 'Loading FFmpeg... (this may take a few seconds)',
                        originalSize: file.size
                    });
                }
                
                this.ffmpegInstance = new FFmpeg();
                
                // Set up logging
                this.ffmpegInstance.on('log', ({ message }) => {
                    console.log('FFmpeg:', message);
                });
                
                // Set up progress tracking
                this.ffmpegInstance.on('progress', ({ progress }) => {
                    if (onProgress) {
                        const progressPercent = Math.round(progress * 100);
                        onProgress({
                            stage: 'converting',
                            progress: 20 + (progressPercent * 0.6), // 20-80%
                            message: `Converting: ${progressPercent}%`,
                            originalSize: file.size
                        });
                    }
                });
                
                // Load FFmpeg core from CDN
                // Use CDN URLs directly to avoid CORS and Worker path issues
                const coreBaseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
                const ffmpegBaseURL = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/esm';
                
                // Convert to blob URLs to avoid CORS issues
                const coreURL = await toBlobURL(`${coreBaseURL}/ffmpeg-core.js`, 'text/javascript');
                const wasmURL = await toBlobURL(`${coreBaseURL}/ffmpeg-core.wasm`, 'application/wasm');
                
                // Load worker from CDN and convert to blob URL
                // This ensures the worker is loaded from HTTP, not file://
                const workerCDNURL = `${ffmpegBaseURL}/worker.js`;
                const workerBlobURL = await toBlobURL(workerCDNURL, 'text/javascript');
                
                // Load FFmpeg with explicit worker configuration
                // Using blob URLs ensures they're loaded from the same origin
                await this.ffmpegInstance.load({
                    coreURL: coreURL,
                    wasmURL: wasmURL,
                    workerURL: workerBlobURL,
                });
                
                this.ffmpegLoaded = true;
                this.ffmpegLoading = false;
                
                if (onProgress) {
                    onProgress({
                        stage: 'converting',
                        progress: 20,
                        message: 'FFmpeg loaded. Starting conversion...',
                        originalSize: file.size
                    });
                }
            } else if (this.ffmpegLoading) {
                // Wait for FFmpeg to finish loading
                while (this.ffmpegLoading) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
            
            if (!this.ffmpegInstance) {
                throw new Error('FFmpeg instance not available');
            }
            
            // Write input file to FFmpeg's virtual file system
            const inputFileName = 'input.avi';
            const outputFileName = 'output.mp4';
            
            await this.ffmpegInstance.writeFile(inputFileName, await fetchFile(file));
            
            if (onProgress) {
                onProgress({
                    stage: 'converting',
                    progress: 25,
                    message: 'File loaded. Converting to MP4...',
                    originalSize: file.size
                });
            }
            
            // Get compression settings
            const settings = this.getFFmpegCompressionSettings(quality);
            
            // Run FFmpeg conversion command
            // -i input.avi: input file
            // -c:v libx264: use H.264 codec
            // -preset: encoding speed (faster = faster encoding, larger file)
            // -crf: quality (lower = better quality, larger file)
            // -c:a aac: audio codec
            // -b:a: audio bitrate
            // -movflags +faststart: optimize for web streaming
            await this.ffmpegInstance.exec([
                '-i', inputFileName,
                '-c:v', 'libx264',
                '-preset', settings.preset,
                '-crf', settings.crf.toString(),
                '-vf', settings.height === -1 ? `scale=${settings.width}:-1` : `scale=${settings.width}:${settings.height}`,
                '-r', settings.frameRate.toString(),
                '-c:a', 'aac',
                '-b:a', settings.audioBitrate,
                '-movflags', '+faststart',
                outputFileName
            ]);
            
            if (onProgress) {
                onProgress({
                    stage: 'finalizing',
                    progress: 90,
                    message: 'Finalizing conversion...',
                    originalSize: file.size
                });
            }
            
            // Read output file
            const data = await this.ffmpegInstance.readFile(outputFileName);
            
            // Clean up
            await this.ffmpegInstance.deleteFile(inputFileName);
            await this.ffmpegInstance.deleteFile(outputFileName);
            
            // Convert to Blob
            const blob = new Blob([data], { type: 'video/mp4' });
            
            // Store output filename
            const outputFilename = this.getOutputFilename(file.name, 'video/mp4');
            (blob as any).name = outputFilename;
            
            if (onProgress) {
                const reduction = ((1 - blob.size / file.size) * 100);
                onProgress({
                    stage: 'complete',
                    progress: 100,
                    message: `Conversion complete: ${this.formatFileSize(file.size)} → ${this.formatFileSize(blob.size)} (${reduction > 0 ? reduction.toFixed(1) : '0.0'}% reduction) (converted to MP4)`,
                    originalSize: file.size,
                    compressedSize: blob.size
                });
            }
            
            return blob;
            
        } catch (error: any) {
            console.error('FFmpeg conversion error:', error);
            throw new Error(`FFmpeg conversion error: ${error.message || 'Unknown error'}`);
        }
    }
    
    /**
     * Get FFmpeg compression settings based on quality
     * Uses scale filter with -1 to maintain aspect ratio
     */
    private getFFmpegCompressionSettings(quality: 'low' | 'medium' | 'high') {
        switch (quality) {
            case 'low':
                return {
                    width: 640,
                    height: -1, // -1 maintains aspect ratio
                    crf: 28, // Higher CRF = lower quality, smaller file
                    preset: 'fast',
                    frameRate: 15,
                    audioBitrate: '64k'
                };
            case 'medium':
                return {
                    width: 1280,
                    height: -1,
                    crf: 23,
                    preset: 'medium',
                    frameRate: 24,
                    audioBitrate: '128k'
                };
            case 'high':
                return {
                    width: 1920,
                    height: -1,
                    crf: 20, // Lower CRF = better quality, larger file
                    preset: 'slow',
                    frameRate: 30,
                    audioBitrate: '192k'
                };
            default:
                return {
                    width: 1280,
                    height: -1,
                    crf: 23,
                    preset: 'medium',
                    frameRate: 24,
                    audioBitrate: '128k'
                };
        }
    }

    /**
     * Get supported MIME type for MediaRecorder
     * Note: MediaRecorder typically outputs WebM or MP4, regardless of input format
     * For AVI files, prefer MP4 for better compatibility
     */
    private getMimeType(inputFilename?: string): string {
        const isAvi = inputFilename && inputFilename.toLowerCase().endsWith('.avi');
        const isMov = inputFilename && inputFilename.toLowerCase().endsWith('.mov');
        
        // For AVI and MOV, prefer MP4 for better compatibility
        if (isAvi || isMov) {
            const mp4Types = [
                'video/mp4;codecs=h264',
                'video/mp4;codecs=avc1',
                'video/mp4'
            ];
            
            for (const type of mp4Types) {
                if (MediaRecorder.isTypeSupported(type)) {
                    return type;
                }
            }
        }
        
        // Default order: try MP4 first, then WebM
        const types = [
            'video/mp4;codecs=h264',
            'video/mp4;codecs=avc1',
            'video/mp4',
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm'
        ];

        for (const type of types) {
            if (MediaRecorder.isTypeSupported(type)) {
                return type;
            }
        }

        return 'video/webm'; // Fallback
    }

    /**
     * Check if the input video format can be read by the browser
     */
    private canReadVideoFormat(filename: string): boolean {
        if (!filename) return false;
        
        const extension = filename.toLowerCase();
        const supportedFormats = [
            '.mp4', '.webm', '.ogg', '.ogv', '.mov', 
            '.avi', '.mkv', '.flv', '.wmv', '.m4v', '.3gp'
        ];
        
        return supportedFormats.some(ext => extension.endsWith(ext));
    }

    /**
     * Get output filename for compressed video (preserves original name but changes extension)
     * For AVI files, always use .mp4 extension
     */
    private getOutputFilename(originalFilename: string, outputMimeType: string): string {
        if (!originalFilename) return 'compressed_video.mp4';
        
        const lastDot = originalFilename.lastIndexOf('.');
        const baseName = lastDot > 0 ? originalFilename.substring(0, lastDot) : originalFilename;
        
        // For AVI files, always convert to MP4
        const isAvi = originalFilename.toLowerCase().endsWith('.avi');
        const isMov = originalFilename.toLowerCase().endsWith('.mov');
        
        if (isAvi || isMov) {
            // Force MP4 extension for AVI/MOV files
            return baseName + '.mp4';
        }
        
        // Determine extension from MIME type for other formats
        let extension = '.mp4'; // default to MP4 for better compatibility
        if (outputMimeType.includes('mp4')) {
            extension = '.mp4';
        } else if (outputMimeType.includes('webm')) {
            extension = '.webm';
        } else if (outputMimeType.includes('ogg')) {
            extension = '.ogv';
        }
        
        return baseName + extension;
    }

    /**
     * Get output format info for user feedback
     */
    private getOutputFormatInfo(inputFilename: string): string {
        const inputExt = inputFilename.toLowerCase();
        const mimeType = this.getMimeType();
        
        if (mimeType.includes('webm')) {
            if (inputExt.endsWith('.mp4') || inputExt.endsWith('.mov') || inputExt.endsWith('.avi')) {
                return ' (will be converted to WebM)';
            }
            return ' (WebM format)';
        } else if (mimeType.includes('mp4')) {
            if (inputExt.endsWith('.avi') || inputExt.endsWith('.mov')) {
                return ' (will be converted to MP4)';
            }
            return ' (MP4 format)';
        }
        
        return '';
    }

    /**
     * Format file size for display
     */
    private formatFileSize(bytes: number): string {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    /**
     * Check if video compression is supported
     */
    isSupported(): boolean {
        return typeof MediaRecorder !== 'undefined' && 
               typeof HTMLCanvasElement !== 'undefined' &&
               typeof HTMLVideoElement !== 'undefined';
    }
}


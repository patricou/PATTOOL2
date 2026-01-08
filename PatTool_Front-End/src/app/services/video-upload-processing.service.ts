import { Injectable, NgZone } from '@angular/core';
import { VideoCompressionService, CompressionProgress } from './video-compression.service';

export interface ProcessedFileResult {
  files: File[];
  errors: string[];
}

@Injectable({
  providedIn: 'root'
})
export class VideoUploadProcessingService {

  constructor(
    private videoCompressionService: VideoCompressionService,
    private ngZone: NgZone
  ) {}

  /**
   * Check if a file is a video file based on its name
   */
  isVideoFile(fileName: string): boolean {
    if (!fileName) return false;
    
    const videoExtensions = ['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v', '.3gp'];
    const lowerFileName = fileName.toLowerCase();
    
    return videoExtensions.some(ext => lowerFileName.endsWith(ext));
  }

  /**
   * Format file size in human-readable format
   */
  formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /**
   * Process video files with compression based on quality selection
   * @param selectedFiles All selected files (videos and non-videos)
   * @param quality Compression quality ('low' | 'medium' | 'high' | 'very-high' | 'original' | null)
   * @param onProgress Callback for progress updates
   * @returns Promise with processed files and any errors
   */
  async processVideoFiles(
    selectedFiles: File[],
    quality: 'low' | 'medium' | 'high' | 'very-high' | 'original' | null,
    onProgress?: (message: string) => void
  ): Promise<ProcessedFileResult> {
    const processedFiles: File[] = [];
    const errors: string[] = [];
    const videoFiles = selectedFiles.filter(file => this.isVideoFile(file.name));

    try {
      // If quality is null, user cancelled - use original files
      if (quality === null) {
        if (onProgress) {
          onProgress(`⚠️ Compression cancelled, uploading original files`);
        }
        return { files: [...selectedFiles], errors: [] };
      }

      // If quality is 'original', skip compression
      if (quality === 'original') {
        if (onProgress) {
          onProgress(`📹 Uploading ${videoFiles.length} video file(s) in original quality (no compression)`);
        }
        return { files: [...selectedFiles], errors: [] };
      }

      // No video files or compression not supported
      if (videoFiles.length === 0 || !this.videoCompressionService.isSupported()) {
        if (videoFiles.length > 0 && !this.videoCompressionService.isSupported()) {
          if (onProgress) {
            onProgress(`⚠️ Video compression not supported in this browser, uploading original files`);
          }
        }
        return { files: [...selectedFiles], errors: [] };
      }

      // Process videos with compression
      if (onProgress) {
        onProgress(`🎬 Found ${videoFiles.length} video file(s) - Compressing with ${quality} quality...`);
        onProgress(`ℹ️ Compression will continue even if you switch tabs or minimize the window.`);
      }

      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        
        if (this.isVideoFile(file.name)) {
          try {
            if (onProgress) {
              onProgress(`🎥 Compressing video ${i + 1}/${videoFiles.length}: ${file.name}...`);
            }
            
            // Add timeout for compression (30 minutes max per video)
            const compressionPromise = this.videoCompressionService.compressVideo(
              file,
              quality,
              (progress: CompressionProgress) => {
                // Ensure the callback runs in Angular zone for proper change detection
                this.ngZone.run(() => {
                  if (onProgress) {
                    // Format progress message with stage and percentage if available
                    let progressMessage = progress.message;
                    if (progress.progress !== undefined) {
                      const stageLabel = progress.stage ? `[${progress.stage}] ` : '';
                      progressMessage = `${stageLabel}${progress.progress.toFixed(2)}% - ${progress.message}`;
                    }
                    // Call onProgress which will trigger change detection in the component
                    onProgress(progressMessage);
                  }
                });
              }
            );
            
            const compressionTimeout = new Promise<Blob>((_, reject) => {
              setTimeout(() => {
                reject(new Error('Compression timeout - video took too long to compress'));
              }, 1800000); // 30 minutes timeout
            });
            
            const compressedBlob = await Promise.race([compressionPromise, compressionTimeout]);
            
            // Check if compressed file is larger than original
            if (compressedBlob.size > file.size) {
              const sizeIncrease = ((compressedBlob.size / file.size - 1) * 100).toFixed(1);
              const confirmMessage = `⚠️ Compression Warning\n\n` +
                `The compressed file is ${sizeIncrease}% larger than the original file.\n\n` +
                `Original: ${this.formatFileSize(file.size)}\n` +
                `Compressed: ${this.formatFileSize(compressedBlob.size)}\n\n` +
                `This can happen when:\n` +
                `• The video is already highly compressed\n` +
                `• The compression quality setting is too high\n` +
                `• The video format conversion increases file size\n\n` +
                `Do you still want to upload the compressed file?\n` +
                `(Click "Cancel" to use the original file instead)`;
              
              const useCompressed = window.confirm(confirmMessage);
              
              if (!useCompressed) {
                // User chose to use original file
                if (onProgress) {
                  onProgress(`ℹ️ Using original file (compressed file was larger: ${this.formatFileSize(compressedBlob.size)} vs ${this.formatFileSize(file.size)})`);
                }
                processedFiles.push(file);
                continue; // Skip to next file
              }
              // If user confirmed, continue with compressed file (will be logged below)
            }
            
            // Check if compression actually happened (for AVI/MOV files, format might have changed)
            const isAviOrMov = file.name.toLowerCase().endsWith('.avi') || file.name.toLowerCase().endsWith('.mov');
            const formatChanged = isAviOrMov && (compressedBlob.type.includes('webm') || compressedBlob.type.includes('mp4'));
            
            // If compression failed (same size and no format change for AVI/MOV), use original
            // But skip this check if compressed is larger (already handled above)
            if (compressedBlob.size <= file.size && !formatChanged && compressedBlob.size >= file.size * 0.95) {
              // Compression didn't really happen (probably error was caught and original returned)
              if (onProgress) {
                onProgress(`⚠️ Compression not available for this format. Using original file.`);
              }
              processedFiles.push(file);
            } else {
              // Create a new File from the compressed Blob
              // Use original filename but note that format may have changed (AVI/MOV -> WebM/MP4)
              const outputFilename = (compressedBlob as any).name || file.name;
              const compressedFile = new File(
                [compressedBlob],
                outputFilename,
                { type: compressedBlob.type || file.type }
              );
              
              processedFiles.push(compressedFile);
              
              // Log compression result
              if (compressedBlob.size > file.size) {
                // User confirmed to use compressed file even though it's larger
                const sizeIncrease = ((compressedBlob.size / file.size - 1) * 100).toFixed(1);
                if (onProgress) {
                  onProgress(`⚠️ Using compressed file despite being larger: ${this.formatFileSize(file.size)} → ${this.formatFileSize(compressedBlob.size)} (+${sizeIncrease}%)`);
                }
              } else {
                const reduction = ((1 - compressedBlob.size / file.size) * 100).toFixed(1);
                if (onProgress) {
                  onProgress(`✅ Video compressed: ${this.formatFileSize(file.size)} → ${this.formatFileSize(compressedBlob.size)} (${reduction}% reduction)`);
                }
              }
            }
            
          } catch (error: any) {
            console.error('Compression error:', error);
            const errorMsg = error?.message || 'Unknown compression error';
            errors.push(`Error compressing ${file.name}: ${errorMsg}`);
            if (onProgress) {
              onProgress(`⚠️ Compression failed (${errorMsg}). Using original file.`);
            }
            // Use original file if compression fails
            processedFiles.push(file);
          }
        } else {
          // Non-video files: add as-is
          processedFiles.push(file);
        }
      }

      return { files: processedFiles, errors };

    } catch (error: any) {
      // If anything goes wrong in the compression flow, fall back to uploading original files
      console.error('Error in video compression flow:', error);
      const errorMsg = error?.message || 'Unknown error';
      errors.push(`Error in compression process: ${errorMsg}`);
      if (onProgress) {
        onProgress(`⚠️ Error in compression process: ${errorMsg}. Uploading original files.`);
      }
      return { files: [...selectedFiles], errors };
    }
  }

  /**
   * Add timeout protection to compression quality modal promise
   * @param qualityPromise Promise from askForCompressionQuality
   * @param modalRef Reference to the modal (to dismiss it if timeout)
   * @param onTimeout Callback when timeout occurs
   * @returns Promise that resolves with quality or null if timeout/cancelled
   */
  async withQualityTimeout(
    qualityPromise: Promise<'low' | 'medium' | 'high' | 'very-high' | 'original' | null>,
    modalRef: any,
    onTimeout?: () => void
  ): Promise<'low' | 'medium' | 'high' | 'very-high' | 'original' | null> {
    const timeoutPromise = new Promise<'low' | 'medium' | 'high' | 'very-high' | 'original' | null>((resolve) => {
      setTimeout(() => {
        if (modalRef) {
          // Modal is still open after 5 minutes, assume cancelled
          if (onTimeout) {
            onTimeout();
          }
          if (modalRef) {
            modalRef.dismiss();
          }
          resolve(null);
        }
      }, 300000); // 5 minutes timeout
    });

    return Promise.race([qualityPromise, timeoutPromise]);
  }
}

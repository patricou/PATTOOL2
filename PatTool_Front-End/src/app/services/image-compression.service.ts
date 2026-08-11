import { Injectable } from '@angular/core';
import * as piexif from 'piexifjs';

/** Same default as file upload / share: compress images larger than ~300 KB down toward that size. */
export const IMAGE_UPLOAD_TARGET_BYTES = 300 * 1024;
export const IMAGE_UPLOAD_MAX_DIMENSION = 1920;

/**
 * Client-side image compression used by file upload (and Notes).
 * Target size ~300 KB, max edge 1920 px, JPEG EXIF preserved when possible.
 */
@Injectable({ providedIn: 'root' })
export class ImageCompressionService {

    isImageFile(file: File | Blob): boolean {
        return !!file?.type && file.type.startsWith('image/');
    }

    /**
     * Compress when larger than the target (default ~300 KB, same as file upload).
     * Pass {@code forceJpeg: true} for embedded data-URL storage (Notes).
     */
    async compressForUpload(
        file: File,
        options?: { targetSizeBytes?: number; forceJpeg?: boolean }
    ): Promise<File> {
        const targetSizeBytes = options?.targetSizeBytes ?? IMAGE_UPLOAD_TARGET_BYTES;
        const forceJpeg = options?.forceJpeg === true;
        if (!this.isImageFile(file)) {
            return file;
        }
        // Same rule as file upload: skip when already small, unless we must re-encode to JPEG.
        if (!forceJpeg && file.size <= targetSizeBytes) {
            return file;
        }
        if (forceJpeg && this.isJpeg(file) && file.size <= targetSizeBytes) {
            return file;
        }
        return this.compressImageToTargetSize(file, targetSizeBytes, forceJpeg);
    }

    async fileToDataUrl(file: File | Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    }

    /**
     * Upload-style compression then data URL — used by Notes (always JPEG, ~300 KB).
     */
    async compressToJpegDataUrl(file: File): Promise<string> {
        const compressed = await this.compressForUpload(file, { forceJpeg: true });
        return this.fileToDataUrl(compressed);
    }

    async compressImageToTargetSize(
        file: File,
        targetSizeBytes: number,
        forceJpeg: boolean = false
    ): Promise<File> {
        return new Promise((resolve, reject) => {
            const isJPEG = this.isJpeg(file);

            if (isJPEG) {
                const exifReader = new FileReader();
                exifReader.onload = (exifEvent: ProgressEvent<FileReader>) => {
                    let exifData: unknown = null;
                    try {
                        const exifString = exifEvent.target?.result;
                        if (typeof exifString === 'string') {
                            exifData = piexif.load(exifString);
                        }
                    } catch {
                        exifData = null;
                    }
                    this.performImageCompression(
                        file, targetSizeBytes, exifData, forceJpeg, resolve, reject
                    );
                };
                exifReader.onerror = () => {
                    this.performImageCompression(
                        file, targetSizeBytes, null, forceJpeg, resolve, reject
                    );
                };
                exifReader.readAsBinaryString(file);
            } else {
                this.performImageCompression(
                    file, targetSizeBytes, null, forceJpeg, resolve, reject
                );
            }
        });
    }

    private isJpeg(file: File): boolean {
        const name = (file.name || '').toLowerCase();
        return file.type === 'image/jpeg'
            || file.type === 'image/jpg'
            || name.endsWith('.jpg')
            || name.endsWith('.jpeg');
    }

    private performImageCompression(
        file: File,
        targetSizeBytes: number,
        exifData: any,
        forceJpeg: boolean,
        resolve: (file: File) => void,
        reject: (error: Error) => void
    ): void {
        const reader = new FileReader();

        reader.onload = (e: ProgressEvent<FileReader>) => {
            const img = new Image();

            img.onload = () => {
                let quality = 0.9;
                let minQuality = 0.1;
                let maxQuality = 0.95;
                let bestBlob: Blob | null = null;
                let attempts = 0;
                const maxAttempts = 10;
                const isJPEG = this.isJpeg(file);
                const outputType = forceJpeg || isJPEG || !file.type ? 'image/jpeg' : file.type;
                const outName = forceJpeg && !this.isJpeg(file)
                    ? file.name.replace(/\.[^.]+$/, '') + '.jpg'
                    : file.name;
                const displayedW = img.width;
                const displayedH = img.height;

                const processBlobWithEXIF = (
                    blob: Blob,
                    orientationToReset: number,
                    callback: (finalBlob: Blob) => void
                ): void => {
                    if (isJPEG && exifData && outputType === 'image/jpeg') {
                        try {
                            const blobReader = new FileReader();
                            blobReader.onload = (blobEvent: ProgressEvent<FileReader>) => {
                                try {
                                    const binaryString = blobEvent.target?.result;
                                    if (typeof binaryString !== 'string') {
                                        callback(blob);
                                        return;
                                    }
                                    const modifiedExifData = JSON.parse(JSON.stringify(exifData));
                                    if (modifiedExifData['0th'] && orientationToReset !== 1) {
                                        modifiedExifData['0th'][piexif.ImageIFD.Orientation] = 1;
                                    }
                                    const exifString = piexif.dump(modifiedExifData);
                                    const newBinaryString = piexif.insert(exifString, binaryString);
                                    const byteArray = new Uint8Array(newBinaryString.length);
                                    for (let i = 0; i < newBinaryString.length; i++) {
                                        byteArray[i] = newBinaryString.charCodeAt(i);
                                    }
                                    callback(new Blob([byteArray], { type: outputType }));
                                } catch {
                                    callback(blob);
                                }
                            };
                            blobReader.onerror = () => callback(blob);
                            blobReader.readAsBinaryString(blob);
                        } catch {
                            callback(blob);
                        }
                    } else {
                        callback(blob);
                    }
                };

                const tryCompress = (q: number): void => {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        reject(new Error('Could not get canvas context'));
                        return;
                    }

                    let orientation = 1;
                    if (exifData?.['0th']?.[piexif.ImageIFD.Orientation]) {
                        orientation = exifData['0th'][piexif.ImageIFD.Orientation];
                    }

                    let finalWidth = displayedW;
                    let finalHeight = displayedH;
                    if (displayedW > IMAGE_UPLOAD_MAX_DIMENSION || displayedH > IMAGE_UPLOAD_MAX_DIMENSION) {
                        if (displayedW > displayedH) {
                            finalHeight = (displayedH / displayedW) * IMAGE_UPLOAD_MAX_DIMENSION;
                            finalWidth = IMAGE_UPLOAD_MAX_DIMENSION;
                        } else {
                            finalWidth = (displayedW / displayedH) * IMAGE_UPLOAD_MAX_DIMENSION;
                            finalHeight = IMAGE_UPLOAD_MAX_DIMENSION;
                        }
                    }

                    canvas.width = finalWidth;
                    canvas.height = finalHeight;
                    ctx.clearRect(0, 0, finalWidth, finalHeight);
                    ctx.drawImage(img, 0, 0, finalWidth, finalHeight);

                    canvas.toBlob((blob) => {
                        if (!blob) {
                            reject(new Error('Failed to create blob'));
                            return;
                        }

                        processBlobWithEXIF(blob, orientation, (finalBlob) => {
                            attempts++;

                            const toFile = (b: Blob) => new File([b], outName, {
                                type: outputType,
                                lastModified: Date.now()
                            });

                            if (finalBlob.size <= targetSizeBytes * 1.1 || attempts >= maxAttempts) {
                                resolve(toFile(finalBlob));
                                return;
                            }

                            if (finalBlob.size > targetSizeBytes) {
                                bestBlob = finalBlob;
                                maxQuality = q;
                                const newQuality = (q + minQuality) / 2;
                                if (Math.abs(newQuality - q) < 0.01 || newQuality <= minQuality) {
                                    const finalBlobToUse = bestBlob && bestBlob.size < finalBlob.size
                                        ? bestBlob
                                        : finalBlob;
                                    resolve(toFile(finalBlobToUse));
                                    return;
                                }
                                tryCompress(newQuality);
                            } else {
                                minQuality = q;
                                const newQuality = (q + maxQuality) / 2;
                                if (Math.abs(newQuality - q) < 0.01 || newQuality >= maxQuality) {
                                    resolve(toFile(finalBlob));
                                    return;
                                }
                                tryCompress(newQuality);
                            }
                        });
                    }, outputType, q);
                };

                tryCompress(quality);
            };

            img.onerror = () => reject(new Error('Failed to load image'));
            img.src = String(e.target?.result || '');
        };

        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
    }
}

import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { FileService } from '../services/file.service';
import { VideoMontageClip } from './video-montage.service';

export interface MontageRenderOptions {
  title: string;
  width: number;
  height: number;
  clips: VideoMontageClip[];
  keepSourceAudio?: boolean;
  music?: {
    buffer: ArrayBuffer;
    volume: number;
    loop: boolean;
  };
  signal?: AbortSignal;
  onProgress?: (current: number, total: number) => void;
}

export interface MontageRenderResult {
  blob: Blob;
  mimeType: string;
  fileName: string;
}

const FPS = 30;

@Injectable({ providedIn: 'root' })
export class VideoMontageRenderService {
  constructor(private readonly fileService: FileService) {}

  isSupported(): boolean {
    return typeof MediaRecorder !== 'undefined' && typeof document !== 'undefined';
  }

  pickMimeType(): string {
    const types = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=h264,aac',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return '';
  }

  async render(options: MontageRenderOptions): Promise<MontageRenderResult> {
    if (!this.isSupported()) {
      throw new Error('unsupported');
    }
    const mimeType = this.pickMimeType();
    if (!mimeType) {
      throw new Error('unsupported');
    }
    const width = evenSize(options.width || 1280);
    const height = evenSize(options.height || 720);
    const clips = options.clips || [];
    if (!clips.length) {
      throw new Error('empty');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) {
      throw new Error('canvas');
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    const audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
    const audioDest = audioCtx.createMediaStreamDestination();
    const silence = audioCtx.createGain();
    silence.gain.value = 0;
    const osc = audioCtx.createOscillator();
    osc.connect(silence);
    silence.connect(audioDest);
    osc.start();

    const mixed = new MediaStream();
    canvas.captureStream(FPS).getVideoTracks().forEach((t) => mixed.addTrack(t));
    audioDest.stream.getAudioTracks().forEach((t) => mixed.addTrack(t));

    const bits = height >= 1080 ? 8_000_000 : 4_000_000;
    const recorder = mimeType
      ? new MediaRecorder(mixed, { mimeType, videoBitsPerSecond: bits, audioBitsPerSecond: 128_000 })
      : new MediaRecorder(mixed, { videoBitsPerSecond: bits, audioBitsPerSecond: 128_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        chunks.push(ev.data);
      }
    };

    const objectUrls: string[] = [];
    let musicSource: AudioBufferSourceNode | null = null;
    const throwIfAborted = () => {
      if (options.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
    };

    try {
      if (options.music?.buffer && options.music.buffer.byteLength) {
        try {
          const decoded = await audioCtx.decodeAudioData(options.music.buffer.slice(0));
          const gain = audioCtx.createGain();
          gain.gain.value = Math.max(0, Math.min(1, options.music.volume ?? 0.7));
          gain.connect(audioDest);
          musicSource = audioCtx.createBufferSource();
          musicSource.buffer = decoded;
          musicSource.loop = options.music.loop !== false;
          musicSource.connect(gain);
          musicSource.start(0);
        } catch {
          musicSource = null;
        }
      }

      recorder.start(250);
      await waitRaf();
      drawBlack(ctx, width, height);

      for (let i = 0; i < clips.length; i++) {
        throwIfAborted();
        options.onProgress?.(i + 1, clips.length);
        const clip = clips[i];
        const durationMs = Math.max(400, (clip.durationSec || 3) * 1000);
        if (clip.kind === 'photo') {
          const img = await this.loadImage(clip, objectUrls, options.signal);
          await this.holdImage(ctx, img, width, height, durationMs, throwIfAborted);
        } else {
          await this.playVideoClip(
            ctx,
            audioCtx,
            audioDest,
            clip,
            width,
            height,
            durationMs,
            objectUrls,
            throwIfAborted,
            !!options.keepSourceAudio,
            options.signal
          );
        }
      }

      await new Promise<void>((resolve, reject) => {
        recorder.onstop = () => resolve();
        recorder.onerror = () => reject(new Error('recorder'));
        try {
          recorder.stop();
        } catch (e) {
          reject(e);
        }
      });

      const outType = (recorder.mimeType || mimeType).split(';')[0] || 'video/webm';
      const blob = new Blob(chunks, { type: outType });
      if (!blob.size) {
        throw new Error('empty_output');
      }
      const ext = outType.includes('mp4') ? '.mp4' : '.webm';
      const base = safeFileName(options.title || 'montage');
      return { blob, mimeType: outType, fileName: base + ext };
    } finally {
      try {
        musicSource?.stop();
      } catch {
        // already stopped
      }
      try {
        osc.stop();
      } catch {
        // already stopped
      }
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      } catch {
        // already stopped
      }
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      mixed.getTracks().forEach((t) => t.stop());
      canvas.width = 0;
      canvas.height = 0;
      void audioCtx.close();
      for (const url of objectUrls) {
        URL.revokeObjectURL(url);
      }
      objectUrls.length = 0;
    }
  }

  private async loadImage(clip: VideoMontageClip, objectUrls: string[], signal?: AbortSignal): Promise<HTMLImageElement> {
    const buf = await abortable(firstValueFrom(this.fileService.getFile(clip.fileId)), signal);
    const type = (clip.fileType || 'image/jpeg').split(';')[0];
    const url = URL.createObjectURL(new Blob([buf], { type }));
    objectUrls.push(url);
    return new Promise((resolve, reject) => {
      const img = new Image();
      const onAbort = () => {
        img.src = '';
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      img.onload = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(img);
      };
      img.onerror = () => {
        signal?.removeEventListener('abort', onAbort);
        reject(new Error('image_load'));
      };
      img.src = url;
    });
  }

  private async holdImage(
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    width: number,
    height: number,
    durationMs: number,
    throwIfAborted: () => void
  ): Promise<void> {
    const end = performance.now() + durationMs;
    while (performance.now() < end) {
      throwIfAborted();
      drawContain(ctx, img, img.naturalWidth, img.naturalHeight, width, height);
      await waitRaf();
    }
  }

  private async playVideoClip(
    ctx: CanvasRenderingContext2D,
    audioCtx: AudioContext,
    audioDest: MediaStreamAudioDestinationNode,
    clip: VideoMontageClip,
    width: number,
    height: number,
    durationMs: number,
    objectUrls: string[],
    throwIfAborted: () => void,
    keepSourceAudio: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    const meta = await abortable(
      firstValueFrom(this.fileService.getVideoWithMetadata(clip.fileId, 'high')).catch(() =>
        firstValueFrom(this.fileService.getFileWithMetadata(clip.fileId))
      ),
      signal
    );
    const type = (clip.fileType || 'video/mp4').split(';')[0];
    const url = URL.createObjectURL(new Blob([meta.buffer], { type }));
    objectUrls.push(url);

    const video = document.createElement('video');
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    video.muted = !keepSourceAudio;
    video.volume = keepSourceAudio ? 1 : 0;

    let source: MediaElementAudioSourceNode | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error('video_load'));
      });

      const start = Math.max(0, clip.startSec || 0);
      if (start > 0) {
        await seek(video, start);
      }

      if (keepSourceAudio) {
        try {
          source = audioCtx.createMediaElementSource(video);
          source.connect(audioDest);
        } catch {
          // CORS / already connected — continue without this clip's audio
        }
      }

      try {
        await video.play();
      } catch {
        video.muted = true;
        await video.play();
      }

      const endAt = start + durationMs / 1000;
      while (!video.ended && video.currentTime < endAt) {
        throwIfAborted();
        drawContain(ctx, video, video.videoWidth, video.videoHeight, width, height);
        await waitRaf();
      }
    } finally {
      try {
        video.pause();
      } catch {
        // ignore
      }
      video.onloadedmetadata = null;
      video.onerror = null;
      if (source) {
        try {
          source.disconnect();
        } catch {
          // ignore
        }
      }
      video.removeAttribute('src');
      video.srcObject = null;
      try {
        video.load();
      } catch {
        // ignore
      }
    }
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

function evenSize(n: number): number {
  const v = Math.max(160, Math.round(n));
  return v % 2 === 0 ? v : v - 1;
}

function drawBlack(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
}

function drawContain(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, dstW, dstH);
  if (!srcW || !srcH) {
    return;
  }
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  ctx.drawImage(source, (dstW - dw) / 2, (dstH - dh) / 2, dw, dh);
}

function waitRaf(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    try {
      video.currentTime = time;
    } catch {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    }
  });
}

function safeFileName(title: string): string {
  const base = title.trim().replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  return (base || 'montage').slice(0, 80);
}

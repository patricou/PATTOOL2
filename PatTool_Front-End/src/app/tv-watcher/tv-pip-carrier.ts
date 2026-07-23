import Hls from 'hls.js';
import { attachTvHlsLiveSyncWatchdog } from './tv-hls-config';
import { TvChannel } from '../services/api.service';

/**
 * Persistent <video> outside Angular views so OS Picture-in-Picture survives route changes.
 * The TV page / floating player transfer HLS (or native src) onto this element under a user gesture.
 */
export class TvPipCarrier {
  private video: HTMLVideoElement | null = null;
  private hls: Hls | null = null;
  private detachLiveSync: (() => void) | null = null;
  private channel: TvChannel | null = null;
  private leaveHandler: (() => void) | null = null;
  private leaveListeners = new Set<() => void>();

  get element(): HTMLVideoElement | null {
    return this.video;
  }

  get activeChannel(): TvChannel | null {
    return this.channel;
  }

  isActive(): boolean {
    return !!this.video && document.pictureInPictureElement === this.video;
  }

  onLeave(listener: () => void): () => void {
    this.leaveListeners.add(listener);
    return () => this.leaveListeners.delete(listener);
  }

  ensureVideo(): HTMLVideoElement {
    if (this.video && document.body.contains(this.video)) {
      return this.video;
    }
    this.teardownVideoNode();
    const v = document.createElement('video');
    v.id = 'pattool-tv-pip-carrier';
    v.setAttribute('playsinline', '');
    v.playsInline = true;
    v.controls = false;
    Object.assign(v.style, {
      position: 'fixed',
      width: '2px',
      height: '2px',
      opacity: '0',
      pointerEvents: 'none',
      left: '-100px',
      top: '0',
      zIndex: '-1'
    } as CSSStyleDeclaration);
    document.body.appendChild(v);
    this.leaveHandler = () => {
      this.leaveListeners.forEach((fn) => {
        try {
          fn();
        } catch {
          /* ignore */
        }
      });
    };
    v.addEventListener('leavepictureinpicture', this.leaveHandler);
    this.video = v;
    return v;
  }

  /**
   * Move playback from the in-page video onto the carrier, then enter OS PiP.
   * Must run in a user-gesture stack (PiP button click).
   */
  async enterFromPage(opts: {
    channel: TvChannel;
    pageVideo: HTMLVideoElement;
    hls: Hls | null;
    detachLiveSync: (() => void) | null;
  }): Promise<void> {
    const carrier = this.ensureVideo();
    this.channel = opts.channel;

    if (document.pictureInPictureElement === carrier) {
      return;
    }

    this.clearMediaOnly();

    if (opts.hls) {
      try {
        opts.detachLiveSync?.();
      } catch {
        /* ignore */
      }
      opts.hls.detachMedia();
      opts.hls.attachMedia(carrier);
      this.hls = opts.hls;
      this.detachLiveSync = attachTvHlsLiveSyncWatchdog(opts.hls, carrier);
    } else {
      const src = opts.pageVideo.currentSrc || opts.pageVideo.getAttribute('src') || '';
      const time = opts.pageVideo.currentTime;
      try {
        opts.pageVideo.pause();
        opts.pageVideo.removeAttribute('src');
        opts.pageVideo.load();
      } catch {
        /* ignore */
      }
      if (src) {
        carrier.src = src;
        try {
          carrier.currentTime = time;
        } catch {
          /* ignore */
        }
      }
    }

    const pageVolume = opts.pageVideo.volume;
    const pageMuted = opts.pageVideo.muted;

    // Ensure the in-page element cannot keep producing audio after the transfer.
    try {
      opts.pageVideo.pause();
      opts.pageVideo.muted = true;
      opts.pageVideo.volume = 0;
      if (opts.hls) {
        opts.pageVideo.removeAttribute('src');
        opts.pageVideo.load();
      }
    } catch {
      /* ignore */
    }

    carrier.volume = pageVolume;
    carrier.muted = pageMuted;
    await carrier.play().catch(() => undefined);
    if (document.pictureInPictureElement !== carrier) {
      await carrier.requestPictureInPicture();
    }
  }

  /**
   * Exit OS PiP and attach playback back to the in-page video.
   * Returns the Hls instance (caller owns it again) or null for native playback.
   */
  async returnToPage(pageVideo: HTMLVideoElement): Promise<{
    hls: Hls | null;
    detachLiveSync: (() => void) | null;
  }> {
    const carrier = this.video;
    if (!carrier) {
      return { hls: null, detachLiveSync: null };
    }

    if (document.pictureInPictureElement === carrier) {
      await document.exitPictureInPicture().catch(() => undefined);
    }

    const hls = this.hls;
    try {
      this.detachLiveSync?.();
    } catch {
      /* ignore */
    }
    this.detachLiveSync = null;
    this.hls = null;

    if (hls) {
      hls.detachMedia();
      hls.attachMedia(pageVideo);
      const detachLiveSync = attachTvHlsLiveSyncWatchdog(hls, pageVideo);
      pageVideo.volume = carrier.volume;
      pageVideo.muted = carrier.muted;
      try {
        carrier.pause();
        carrier.removeAttribute('src');
        carrier.load();
      } catch {
        /* ignore */
      }
      await pageVideo.play().catch(() => undefined);
      this.channel = null;
      return { hls, detachLiveSync };
    }

    const src = carrier.currentSrc || carrier.getAttribute('src') || '';
    const time = carrier.currentTime;
    try {
      carrier.removeAttribute('src');
      carrier.load();
    } catch {
      /* ignore */
    }
    if (src) {
      pageVideo.src = src;
      try {
        pageVideo.currentTime = time;
      } catch {
        /* ignore */
      }
    }
    pageVideo.volume = carrier.volume;
    pageVideo.muted = carrier.muted;
    await pageVideo.play().catch(() => undefined);
    this.channel = null;
    return { hls: null, detachLiveSync: null };
  }

  /** Stop PiP + release media (keeps the hidden carrier node for reuse). */
  stop(): void {
    const carrier = this.video;
    if (carrier && document.pictureInPictureElement === carrier) {
      document.exitPictureInPicture().catch(() => undefined);
    }
    this.clearMediaOnly();
    this.channel = null;
  }

  /** Fully remove the carrier node + leave listener (idle / app teardown). */
  dispose(): void {
    this.teardownVideoNode();
    this.leaveListeners.clear();
  }

  private clearMediaOnly(): void {
    try {
      this.detachLiveSync?.();
    } catch {
      /* ignore */
    }
    this.detachLiveSync = null;
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        /* ignore */
      }
      this.hls = null;
    }
    const carrier = this.video;
    if (carrier) {
      try {
        carrier.pause();
        carrier.removeAttribute('src');
        carrier.load();
      } catch {
        /* ignore */
      }
    }
  }

  private teardownVideoNode(): void {
    this.clearMediaOnly();
    const v = this.video;
    if (v && this.leaveHandler) {
      v.removeEventListener('leavepictureinpicture', this.leaveHandler);
    }
    this.leaveHandler = null;
    try {
      v?.remove();
    } catch {
      /* ignore */
    }
    this.video = null;
    this.channel = null;
  }
}

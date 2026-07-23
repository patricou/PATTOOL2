import Hls from 'hls.js';
import { attachTvHlsLiveSyncWatchdog } from './tv-hls-config';
import { TvChannel } from '../services/api.service';

export interface TvDocPipLabels {
  fullscreen: string;
  fullscreenExit: string;
  close: string;
}

interface DocumentPictureInPictureApi {
  window: Window | null;
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

/**
 * Persistent <video> outside Angular views so Picture-in-Picture survives route changes.
 * Prefers Document PiP (custom fullscreen button) when available; falls back to classic video PiP.
 */
export class TvPipCarrier {
  private video: HTMLVideoElement | null = null;
  private hls: Hls | null = null;
  private detachLiveSync: (() => void) | null = null;
  private channel: TvChannel | null = null;
  private leaveHandler: (() => void) | null = null;
  private leaveListeners = new Set<() => void>();
  private docPipWindow: Window | null = null;
  private docPipPageHide: (() => void) | null = null;
  private hostSlot: HTMLDivElement | null = null;
  private suppressLeaveNotify = false;

  get element(): HTMLVideoElement | null {
    return this.video;
  }

  get activeChannel(): TvChannel | null {
    return this.channel;
  }

  isActive(): boolean {
    if (this.isDocPipOpen()) {
      return true;
    }
    return !!this.video && document.pictureInPictureElement === this.video;
  }

  onLeave(listener: () => void): () => void {
    this.leaveListeners.add(listener);
    return () => this.leaveListeners.delete(listener);
  }

  private notifyLeave(): void {
    if (this.suppressLeaveNotify) {
      return;
    }
    this.leaveListeners.forEach((fn) => {
      try {
        fn();
      } catch {
        /* ignore */
      }
    });
  }

  private isDocPipOpen(): boolean {
    return !!(this.docPipWindow && !this.docPipWindow.closed);
  }

  private getDocumentPipApi(): DocumentPictureInPictureApi | null {
    return (
      (window as Window & { documentPictureInPicture?: DocumentPictureInPictureApi })
        .documentPictureInPicture || null
    );
  }

  ensureVideo(): HTMLVideoElement {
    if (this.video && (document.body.contains(this.video) || this.isDocPipOpen())) {
      return this.video;
    }
    this.teardownVideoNode();
    const slot = document.createElement('div');
    slot.id = 'pattool-tv-pip-host';
    Object.assign(slot.style, {
      position: 'fixed',
      width: '2px',
      height: '2px',
      opacity: '0',
      pointerEvents: 'none',
      left: '-100px',
      top: '0',
      zIndex: '-1',
      overflow: 'hidden'
    } as CSSStyleDeclaration);
    document.body.appendChild(slot);
    this.hostSlot = slot;

    const v = document.createElement('video');
    v.id = 'pattool-tv-pip-carrier';
    v.setAttribute('playsinline', '');
    v.playsInline = true;
    v.controls = false;
    Object.assign(v.style, {
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      background: '#000'
    } as CSSStyleDeclaration);
    slot.appendChild(v);
    this.leaveHandler = () => this.notifyLeave();
    v.addEventListener('leavepictureinpicture', this.leaveHandler);
    this.video = v;
    return v;
  }

  /**
   * Move playback from the in-page video onto the carrier, then open PiP.
   * Must run in a user-gesture stack (PiP button click).
   */
  async enterFromPage(opts: {
    channel: TvChannel;
    pageVideo: HTMLVideoElement;
    hls: Hls | null;
    detachLiveSync: (() => void) | null;
    labels?: TvDocPipLabels;
  }): Promise<void> {
    const carrier = this.ensureVideo();
    this.channel = opts.channel;

    // Close any prior PiP surface before opening a fresh one.
    if (this.isDocPipOpen() || document.pictureInPictureElement === carrier) {
      this.suppressLeaveNotify = true;
      try {
        await this.closePipSurface();
      } finally {
        setTimeout(() => {
          this.suppressLeaveNotify = false;
        }, 100);
      }
    }

    this.clearMediaOnlyKeepingElement();

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

    const dpi = this.getDocumentPipApi();
    if (dpi) {
      await this.openDocumentPip(carrier, opts.channel, opts.labels);
      return;
    }

    if (document.pictureInPictureElement !== carrier) {
      await carrier.requestPictureInPicture();
    }
  }

  private async openDocumentPip(
    carrier: HTMLVideoElement,
    _channel: TvChannel,
    labels?: TvDocPipLabels
  ): Promise<void> {
    const dpi = this.getDocumentPipApi();
    if (!dpi) {
      return;
    }
    if (dpi.window && !dpi.window.closed) {
      dpi.window.close();
    }

    const width = Math.max(480, Math.round(window.innerWidth * 0.35));
    const height = Math.max(270, Math.round(width * 9 / 16));
    const pipWindow = await dpi.requestWindow({ width, height });
    const doc = pipWindow.document;
    doc.title = '';

    const style = doc.createElement('style');
    style.textContent = `
      html, body {
        margin: 0; padding: 0; width: 100%; height: 100%;
        overflow: hidden; background: #000; color: #fff;
      }
      .tv-doc-pip {
        position: relative; width: 100%; height: 100%;
        display: flex; align-items: center; justify-content: center;
        background: #000;
      }
      .tv-doc-pip-bar {
        position: absolute; top: 0.45rem; right: 0.45rem; left: 0.45rem;
        display: flex; justify-content: flex-end; gap: 0.4rem; z-index: 10;
        pointer-events: none;
        opacity: 1;
        transform: translateY(0);
        transition: opacity 0.28s ease, transform 0.28s ease;
      }
      .tv-doc-pip-bar.is-hidden {
        opacity: 0;
        transform: translateY(-0.35rem);
        pointer-events: none;
      }
      .tv-doc-pip-bar > * { pointer-events: auto; }
      .tv-doc-pip-bar.is-hidden > * { pointer-events: none; }
      .tv-doc-pip-btn {
        width: 2.5rem; height: 2.5rem; padding: 0; border-radius: 0.45rem;
        background: #000; color: #fff; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 1.05rem;
        box-shadow: 0 2px 10px rgba(0,0,0,0.55);
        border: 1px solid rgba(255,255,255,0.22);
      }
      .tv-doc-pip-btn:hover { background: #111; border-color: rgba(255,255,255,0.4); }
      .tv-doc-pip-btn--fs {
        background: #000;
        border-color: rgba(255,255,255,0.28);
      }
      .tv-doc-pip-btn--fs:hover { background: #111; }
      .tv-doc-pip video {
        width: 100% !important; height: 100% !important;
        max-width: 100%; max-height: 100%;
        object-fit: contain; background: #000;
      }
    `;
    doc.head.appendChild(style);

    Array.from(document.querySelectorAll('link[rel="stylesheet"]')).forEach((node) => {
      try {
        doc.head.appendChild(node.cloneNode(true));
      } catch {
        /* ignore */
      }
    });

    const root = doc.createElement('div');
    root.className = 'tv-doc-pip';

    const bar = doc.createElement('div');
    bar.className = 'tv-doc-pip-bar';

    const fsLabel = labels?.fullscreen || 'Fullscreen';
    const fsExitLabel = labels?.fullscreenExit || 'Exit fullscreen';
    const closeLabel = labels?.close || 'Close';

    const fsBtn = doc.createElement('button');
    fsBtn.type = 'button';
    fsBtn.className = 'tv-doc-pip-btn tv-doc-pip-btn--fs';
    fsBtn.title = fsLabel;
    fsBtn.setAttribute('aria-label', fsLabel);
    fsBtn.innerHTML = '<i class="fa fa-arrows-alt" aria-hidden="true"></i>';
    fsBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      try {
        if (doc.fullscreenElement) {
          await doc.exitFullscreen();
        } else {
          await doc.documentElement.requestFullscreen();
        }
      } catch {
        /* blocked */
      }
    });
    doc.addEventListener('fullscreenchange', () => {
      const on = !!doc.fullscreenElement;
      fsBtn.innerHTML = on
        ? '<i class="fa fa-compress" aria-hidden="true"></i>'
        : '<i class="fa fa-arrows-alt" aria-hidden="true"></i>';
      fsBtn.title = on ? fsExitLabel : fsLabel;
      fsBtn.setAttribute('aria-label', fsBtn.title);
    });

    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tv-doc-pip-btn';
    closeBtn.title = closeLabel;
    closeBtn.setAttribute('aria-label', closeLabel);
    closeBtn.innerHTML = '<i class="fa fa-times" aria-hidden="true"></i>';
    closeBtn.addEventListener('click', () => pipWindow.close());

    bar.appendChild(fsBtn);
    bar.appendChild(closeBtn);
    root.appendChild(bar);
    root.appendChild(carrier);
    doc.body.appendChild(root);
    carrier.controls = true;
    // Native control fullscreen (next to volume) calls video.requestFullscreen(),
    // which is blocked in Document PiP — route it to the PiP document instead.
    const requestDocFs = () => {
      if (doc.fullscreenElement) {
        return doc.exitFullscreen();
      }
      return doc.documentElement.requestFullscreen();
    };
    try {
      carrier.requestFullscreen = (() => requestDocFs()) as typeof carrier.requestFullscreen;
      const webkitCarrier = carrier as HTMLVideoElement & {
        webkitRequestFullscreen?: () => Promise<void> | void;
        webkitRequestFullScreen?: () => Promise<void> | void;
      };
      webkitCarrier.webkitRequestFullscreen = () => requestDocFs();
      webkitCarrier.webkitRequestFullScreen = () => requestDocFs();
    } catch {
      /* ignore */
    }
    carrier.play().catch(() => undefined);

    // Hide chrome 2s after the pointer leaves the PiP window; show again on re-enter.
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const showBar = () => {
      bar.classList.remove('is-hidden');
      if (hideTimer != null) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    };
    const scheduleHide = () => {
      if (hideTimer != null) {
        clearTimeout(hideTimer);
      }
      hideTimer = setTimeout(() => {
        hideTimer = null;
        bar.classList.add('is-hidden');
      }, 2000);
    };
    doc.addEventListener('mouseenter', showBar, true);
    doc.addEventListener('mousemove', showBar);
    doc.addEventListener('pointerdown', showBar);
    doc.addEventListener('mouseleave', scheduleHide, true);
    showBar();
    scheduleHide();

    this.docPipWindow = pipWindow;
    this.docPipPageHide = () => {
      if (hideTimer != null) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      try {
        doc.removeEventListener('mouseenter', showBar, true);
        doc.removeEventListener('mousemove', showBar);
        doc.removeEventListener('pointerdown', showBar);
        doc.removeEventListener('mouseleave', scheduleHide, true);
      } catch {
        /* ignore */
      }
      this.parkCarrierInHost();
      this.docPipWindow = null;
      this.docPipPageHide = null;
      this.notifyLeave();
    };
    pipWindow.addEventListener('pagehide', this.docPipPageHide);
  }

  private parkCarrierInHost(): void {
    const carrier = this.video;
    if (!carrier) {
      return;
    }
    carrier.controls = false;
    const slot = this.hostSlot || this.ensureHostSlot();
    if (carrier.parentElement !== slot) {
      try {
        slot.appendChild(carrier);
      } catch {
        /* ignore */
      }
    }
  }

  private ensureHostSlot(): HTMLDivElement {
    if (this.hostSlot && document.body.contains(this.hostSlot)) {
      return this.hostSlot;
    }
    const slot = document.createElement('div');
    slot.id = 'pattool-tv-pip-host';
    Object.assign(slot.style, {
      position: 'fixed',
      width: '2px',
      height: '2px',
      opacity: '0',
      pointerEvents: 'none',
      left: '-100px',
      top: '0',
      zIndex: '-1',
      overflow: 'hidden'
    } as CSSStyleDeclaration);
    document.body.appendChild(slot);
    this.hostSlot = slot;
    return slot;
  }

  private async closePipSurface(): Promise<void> {
    if (this.isDocPipOpen()) {
      const win = this.docPipWindow!;
      try {
        if (this.docPipPageHide) {
          win.removeEventListener('pagehide', this.docPipPageHide);
        }
      } catch {
        /* ignore */
      }
      this.docPipPageHide = null;
      this.docPipWindow = null;
      this.parkCarrierInHost();
      try {
        if (!win.closed) {
          win.close();
        }
      } catch {
        /* ignore */
      }
      return;
    }
    const carrier = this.video;
    if (carrier && document.pictureInPictureElement === carrier) {
      await document.exitPictureInPicture().catch(() => undefined);
    }
  }

  /**
   * Exit PiP and attach playback back to the in-page video.
   */
  async returnToPage(pageVideo: HTMLVideoElement): Promise<{
    hls: Hls | null;
    detachLiveSync: (() => void) | null;
  }> {
    const carrier = this.video;
    if (!carrier) {
      return { hls: null, detachLiveSync: null };
    }

    this.suppressLeaveNotify = true;
    try {
      await this.closePipSurface();
    } finally {
      setTimeout(() => {
        this.suppressLeaveNotify = false;
      }, 150);
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
    this.suppressLeaveNotify = true;
    try {
      void this.closePipSurface();
    } finally {
      setTimeout(() => {
        this.suppressLeaveNotify = false;
      }, 150);
    }
    this.clearMediaOnlyKeepingElement();
    this.channel = null;
  }

  /** Fully remove the carrier node + leave listener (idle / app teardown). */
  dispose(): void {
    this.suppressLeaveNotify = true;
    try {
      void this.closePipSurface();
    } finally {
      this.suppressLeaveNotify = false;
    }
    this.teardownVideoNode();
    this.leaveListeners.clear();
  }

  private clearMediaOnlyKeepingElement(): void {
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
    this.clearMediaOnlyKeepingElement();
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
    try {
      this.hostSlot?.remove();
    } catch {
      /* ignore */
    }
    this.hostSlot = null;
    this.video = null;
    this.channel = null;
    this.docPipWindow = null;
    this.docPipPageHide = null;
  }
}

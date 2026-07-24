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
  requestWindow(options?: {
    width?: number;
    height?: number;
    disallowReturnToOpener?: boolean;
    preferInitialWindowPlacement?: boolean;
  }): Promise<Window>;
}

/**
 * Persistent <video> outside Angular views so Picture-in-Picture survives route changes.
 * Uses classic video PiP (no Document-PiP title bar). Falls back to Document PiP only
 * when classic video PiP is unavailable; fullscreen there goes through an opener shell.
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
  private lastLabels: TvDocPipLabels | undefined;
  private fsShell: HTMLDivElement | null = null;
  private inOpenerFullscreen = false;
  private fsChangeHandler: (() => void) | null = null;

  get element(): HTMLVideoElement | null {
    return this.video;
  }

  get activeChannel(): TvChannel | null {
    return this.channel;
  }

  isActive(): boolean {
    if (this.inOpenerFullscreen) {
      return true;
    }
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

    // Classic video PiP has no browser title bar / frame chrome (unlike Document PiP).
    const canClassicPip =
      !!(document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled &&
      typeof carrier.requestPictureInPicture === 'function';
    if (canClassicPip) {
      if (document.pictureInPictureElement !== carrier) {
        await carrier.requestPictureInPicture();
      }
      return;
    }

    const dpi = this.getDocumentPipApi();
    if (dpi) {
      await this.openDocumentPip(carrier, opts.channel, opts.labels);
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

    this.lastLabels = labels;
    const width = Math.max(480, Math.round(window.innerWidth * 0.35));
    const height = Math.max(270, Math.round(width * 9 / 16));
    // Hide the "back to tab" control; keep the floating surface as video-only as possible.
    const pipWindow = await dpi.requestWindow({
      width,
      height,
      disallowReturnToOpener: true
    });
    const doc = pipWindow.document;
    doc.title = '';

    const style = doc.createElement('style');
    style.textContent = `
      html, body {
        margin: 0; padding: 0; width: 100%; height: 100%;
        overflow: hidden; background: #000; color: #fff;
        border: 0; outline: 0;
      }
      .tv-doc-pip {
        position: relative; width: 100%; height: 100%;
        display: flex; align-items: center; justify-content: center;
        background: #000; border: 0; margin: 0; padding: 0;
      }
      .tv-doc-pip-bar {
        position: absolute; top: 0.4rem; right: 0.4rem;
        display: flex; justify-content: flex-end; gap: 0.35rem; z-index: 10;
        pointer-events: none;
        opacity: 1;
        transition: opacity 0.28s ease;
      }
      .tv-doc-pip-bar.is-hidden {
        opacity: 0;
        pointer-events: none;
      }
      .tv-doc-pip-bar > * { pointer-events: auto; }
      .tv-doc-pip-bar.is-hidden > * { pointer-events: none; }
      .tv-doc-pip-btn {
        width: 2.35rem; height: 2.35rem; padding: 0; border-radius: 0.4rem;
        background: rgba(0,0,0,0.55); color: #fff; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 1rem;
        border: 0;
        box-shadow: none;
      }
      .tv-doc-pip-btn:hover { background: rgba(0,0,0,0.8); }
      .tv-doc-pip video {
        width: 100% !important; height: 100% !important;
        max-width: 100%; max-height: 100%;
        object-fit: contain; background: #000;
        border: 0; outline: 0; display: block;
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
    const closeLabel = labels?.close || 'Close';

    const fsBtn = doc.createElement('button');
    fsBtn.type = 'button';
    fsBtn.className = 'tv-doc-pip-btn tv-doc-pip-btn--fs';
    fsBtn.title = fsLabel;
    fsBtn.setAttribute('aria-label', fsLabel);
    fsBtn.innerHTML = '<i class="fa fa-arrows-alt" aria-hidden="true"></i>';
    fsBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      // Fullscreen API is disabled inside Document PiP — use the opener shell.
      this.enterOpenerFullscreen();
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
    // No native controls chrome (title/border bar) — only our auto-hiding buttons.
    carrier.controls = false;
    try {
      carrier.requestFullscreen = (() => {
        this.enterOpenerFullscreen();
        return Promise.resolve();
      }) as typeof carrier.requestFullscreen;
      const webkitCarrier = carrier as HTMLVideoElement & {
        webkitRequestFullscreen?: () => void;
        webkitRequestFullScreen?: () => void;
      };
      webkitCarrier.webkitRequestFullscreen = () => {
        this.enterOpenerFullscreen();
      };
      webkitCarrier.webkitRequestFullScreen = () => {
        this.enterOpenerFullscreen();
      };
    } catch {
      /* ignore */
    }
    carrier.play().catch(() => undefined);

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
      }, 1600);
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
      // Opener fullscreen already relocated the video — don't park / notify leave.
      if (this.inOpenerFullscreen) {
        this.docPipWindow = null;
        this.docPipPageHide = null;
        return;
      }
      this.parkCarrierInHost();
      this.docPipWindow = null;
      this.docPipPageHide = null;
      this.notifyLeave();
    };
    pipWindow.addEventListener('pagehide', this.docPipPageHide);
  }

  /**
   * Document PiP cannot use the Fullscreen API (blocked by Chrome/spec).
   * Move the video into a shell in the opener, call requestFullscreen() while the
   * PiP-click user-activation is still propagated, then close PiP.
   */
  private enterOpenerFullscreen(): void {
    const carrier = this.video;
    if (!carrier || this.inOpenerFullscreen) {
      return;
    }

    const pipWin = this.isDocPipOpen() ? this.docPipWindow : null;
    this.removeFsShellSync(false);

    const shell = document.createElement('div');
    shell.id = 'pattool-tv-pip-fs-shell';
    Object.assign(shell.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      background: '#000',
      zIndex: '2147483646',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: '0',
      margin: '0',
      padding: '0'
    } as CSSStyleDeclaration);

    Object.assign(carrier.style, {
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      background: '#000',
      border: '0'
    } as CSSStyleDeclaration);
    carrier.controls = false;

    shell.appendChild(carrier);
    document.body.appendChild(shell);
    this.fsShell = shell;
    this.inOpenerFullscreen = true;

    this.fsChangeHandler = () => {
      if (!document.fullscreenElement && this.inOpenerFullscreen && this.fsShell === shell) {
        this.mountFsExitChrome(shell);
      }
    };
    document.addEventListener('fullscreenchange', this.fsChangeHandler);

    void carrier.play().catch(() => undefined);
    try {
      window.focus();
    } catch {
      /* ignore */
    }

    let fsReq: Promise<void>;
    try {
      fsReq = shell.requestFullscreen();
    } catch (err) {
      fsReq = Promise.reject(err);
    }

    this.suppressLeaveNotify = true;
    this.closeDocPipWindowOnly(pipWin);
    setTimeout(() => {
      this.suppressLeaveNotify = false;
    }, 100);

    void fsReq.then(
      () => undefined,
      () => {
        if (this.inOpenerFullscreen && this.fsShell === shell) {
          this.mountFsExitChrome(shell);
        }
      }
    );
  }

  private closeDocPipWindowOnly(win: Window | null): void {
    const pip = win || (this.isDocPipOpen() ? this.docPipWindow : null);
    if (!pip) {
      this.docPipWindow = null;
      this.docPipPageHide = null;
      return;
    }
    try {
      if (this.docPipPageHide) {
        pip.removeEventListener('pagehide', this.docPipPageHide);
      }
    } catch {
      /* ignore */
    }
    this.docPipPageHide = null;
    this.docPipWindow = null;
    try {
      if (!pip.closed) {
        pip.close();
      }
    } catch {
      /* ignore */
    }
  }

  private mountFsExitChrome(shell: HTMLDivElement): void {
    if (shell.dataset['fsChrome'] === '1') {
      return;
    }
    shell.dataset['fsChrome'] = '1';
    shell.style.position = 'fixed';

    const exitLabel = this.lastLabels?.fullscreenExit || 'Exit fullscreen';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = exitLabel;
    btn.setAttribute('aria-label', exitLabel);
    btn.innerHTML = '<i class="fa fa-compress" aria-hidden="true"></i>';
    Object.assign(btn.style, {
      position: 'absolute',
      top: '0.75rem',
      right: '0.75rem',
      width: '2.5rem',
      height: '2.5rem',
      padding: '0',
      borderRadius: '0.45rem',
      background: 'rgba(0,0,0,0.65)',
      color: '#fff',
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '1.05rem',
      border: '0',
      zIndex: '2'
    } as CSSStyleDeclaration);
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      void this.exitOpenerFullscreen(true);
    });
    shell.appendChild(btn);

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && this.inOpenerFullscreen && !document.fullscreenElement) {
        void this.exitOpenerFullscreen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    (shell as HTMLDivElement & { __fsEsc?: (ev: KeyboardEvent) => void }).__fsEsc = onKey;
  }

  private async exitOpenerFullscreen(reopenPip: boolean): Promise<void> {
    if (!this.inOpenerFullscreen && !this.fsShell) {
      return;
    }
    this.inOpenerFullscreen = false;
    await this.teardownFsShell(true);

    if (!reopenPip || !this.channel || !this.video) {
      return;
    }
    const dpi = this.getDocumentPipApi();
    if (dpi) {
      try {
        await this.openDocumentPip(this.video, this.channel, this.lastLabels);
        return;
      } catch {
        /* fall through */
      }
    }
    try {
      if (document.pictureInPictureElement !== this.video) {
        await this.video.requestPictureInPicture();
      }
    } catch {
      /* ignore */
    }
  }

  private removeFsShellSync(exitBrowserFullscreen: boolean): void {
    if (this.fsChangeHandler) {
      document.removeEventListener('fullscreenchange', this.fsChangeHandler);
      this.fsChangeHandler = null;
    }
    const shell = this.fsShell;
    if (shell) {
      const esc = (shell as HTMLDivElement & { __fsEsc?: (ev: KeyboardEvent) => void }).__fsEsc;
      if (esc) {
        document.removeEventListener('keydown', esc);
        delete (shell as HTMLDivElement & { __fsEsc?: (ev: KeyboardEvent) => void }).__fsEsc;
      }
    }
    if (exitBrowserFullscreen && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
    if (shell && this.video && shell.contains(this.video)) {
      this.parkCarrierInHost();
    }
    if (shell) {
      try {
        shell.remove();
      } catch {
        /* ignore */
      }
    }
    this.fsShell = null;
    this.inOpenerFullscreen = false;
  }

  private async teardownFsShell(exitBrowserFullscreen: boolean): Promise<void> {
    if (this.fsChangeHandler) {
      document.removeEventListener('fullscreenchange', this.fsChangeHandler);
      this.fsChangeHandler = null;
    }

    const shell = this.fsShell;
    if (shell) {
      const esc = (shell as HTMLDivElement & { __fsEsc?: (ev: KeyboardEvent) => void }).__fsEsc;
      if (esc) {
        document.removeEventListener('keydown', esc);
        delete (shell as HTMLDivElement & { __fsEsc?: (ev: KeyboardEvent) => void }).__fsEsc;
      }
    }

    if (exitBrowserFullscreen && document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        /* ignore */
      }
    }

    this.parkCarrierInHost();
    try {
      this.fsShell?.remove();
    } catch {
      /* ignore */
    }
    this.fsShell = null;
    this.inOpenerFullscreen = false;
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
    if (this.inOpenerFullscreen || this.fsShell) {
      await this.teardownFsShell(true);
    }
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
    this.lastLabels = undefined;
    this.fsShell = null;
    this.inOpenerFullscreen = false;
    this.fsChangeHandler = null;
  }
}

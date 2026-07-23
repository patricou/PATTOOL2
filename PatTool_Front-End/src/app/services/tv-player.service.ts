import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import Hls from 'hls.js';
import { TvChannel } from './api.service';
import { resolveTvStreamUrl } from '../tv-watcher/tv-stream.util';
import { TvDocPipLabels, TvPipCarrier } from '../tv-watcher/tv-pip-carrier';

export interface TvFloatingState {
  open: boolean;
  minimized: boolean;
  channel: TvChannel | null;
  /**
   * Invisible shell host used only to keep OS Picture-in-Picture alive across routes.
   * The in-app floating chrome is hidden.
   */
  pipHostOnly?: boolean;
}

/** Payload written before opening / updating the OS pop-out window. */
export interface TvPopoutPayload {
  channel: TvChannel;
  ts: number;
}

@Injectable({ providedIn: 'root' })
export class TvPlayerService {
  static readonly POPOUT_STORAGE_KEY = 'pattool.tv.popout';
  static readonly POPOUT_WINDOW_NAME = 'pattool-tv-popout';

  private readonly stateSubject = new BehaviorSubject<TvFloatingState>({
    open: false,
    minimized: false,
    channel: null,
    pipHostOnly: false
  });

  /** Emitted when detached playback ends and the in-page player should resume. */
  private readonly resumeOnPageSubject = new Subject<TvChannel>();
  readonly resumeOnPage$ = this.resumeOnPageSubject.asObservable();

  private pendingResumeChannel: TvChannel | null = null;
  private popoutWatchTimer: ReturnType<typeof setInterval> | null = null;
  private popoutChannel: TvChannel | null = null;
  private readonly pipCarrier = new TvPipCarrier();
  private pipLeaveUnsub: (() => void) | null = null;
  /** Ignore carrier leavepictureinpicture while we intentionally move/stop media. */
  private suppressPipLeaveHandling = false;
  private suppressPipLeaveTimer: ReturnType<typeof setTimeout> | null = null;

  readonly state$ = this.stateSubject.asObservable();

  constructor() {
    this.pipLeaveUnsub = this.pipCarrier.onLeave(() => this.onOsPipClosed());
  }

  /** True when the persistent OS PiP carrier owns the Picture-in-Picture window. */
  isOsPipActive(): boolean {
    return this.pipCarrier.isActive();
  }

  get osPipChannel(): TvChannel | null {
    return this.pipCarrier.activeChannel;
  }

  /**
   * Transfer in-page playback onto the persistent carrier and open OS PiP.
   * Must be called from a user gesture (PiP button).
   */
  async enterOsPipFromPage(opts: {
    channel: TvChannel;
    pageVideo: HTMLVideoElement;
    hls: Hls | null;
    detachLiveSync: (() => void) | null;
    labels?: TvDocPipLabels;
  }): Promise<void> {
    await this.pipCarrier.enterFromPage(opts);
  }

  /** Exit OS PiP and move playback back to the in-page video element. */
  async exitOsPipToPage(pageVideo: HTMLVideoElement): Promise<{
    hls: Hls | null;
    detachLiveSync: (() => void) | null;
  }> {
    this.beginSuppressPipLeave();
    try {
      const result = await this.pipCarrier.returnToPage(pageVideo);
      // Drop keep-alive shell if any — media already belongs to the page player.
      if (this.stateSubject.value.pipHostOnly) {
        this.stateSubject.next({ open: false, minimized: false, channel: null, pipHostOnly: false });
      }
      return result;
    } finally {
      this.endSuppressPipLeaveSoon();
    }
  }

  /**
   * Tear down the OS PiP carrier media (and exit PiP if open).
   * Does not request page resume — callers that need resume must do it themselves.
   */
  stopOsPip(options?: { dispose?: boolean }): void {
    this.beginSuppressPipLeave();
    try {
      if (options?.dispose) {
        this.pipCarrier.dispose();
      } else {
        this.pipCarrier.stop();
      }
    } finally {
      this.endSuppressPipLeaveSoon();
    }
  }

  /**
   * When returning to the TV page while keep-alive PiP is running, drop the invisible
   * host without stopping the carrier (avoids a second decoder when the page resumes UI).
   */
  detachPipHostOnly(): void {
    if (!this.stateSubject.value.pipHostOnly) {
      return;
    }
    this.stateSubject.next({ open: false, minimized: false, channel: null, pipHostOnly: false });
  }

  private beginSuppressPipLeave(): void {
    this.suppressPipLeaveHandling = true;
    if (this.suppressPipLeaveTimer != null) {
      clearTimeout(this.suppressPipLeaveTimer);
      this.suppressPipLeaveTimer = null;
    }
  }

  private endSuppressPipLeaveSoon(): void {
    if (this.suppressPipLeaveTimer != null) {
      clearTimeout(this.suppressPipLeaveTimer);
    }
    this.suppressPipLeaveTimer = setTimeout(() => {
      this.suppressPipLeaveHandling = false;
      this.suppressPipLeaveTimer = null;
    }, 250);
  }

  private onOsPipClosed(): void {
    if (this.suppressPipLeaveHandling) {
      return;
    }
    const channel =
      this.stateSubject.value.channel || this.pipCarrier.activeChannel;
    const wasPipHost = this.stateSubject.value.open && !!this.stateSubject.value.pipHostOnly;
    // Always silence the carrier — otherwise page resume starts a second stream.
    this.beginSuppressPipLeave();
    try {
      this.pipCarrier.stop();
    } finally {
      this.endSuppressPipLeaveSoon();
    }
    if (wasPipHost) {
      this.stateSubject.next({ open: false, minimized: false, channel: null, pipHostOnly: false });
    }
    if (channel) {
      this.requestResumeOnPage(channel);
    }
  }

  get snapshot(): TvFloatingState {
    return this.stateSubject.value;
  }

  get isOpen(): boolean {
    return this.stateSubject.value.open;
  }

  /** True while an OS pop-out window is being watched. */
  get isPopoutActive(): boolean {
    return this.popoutWatchTimer != null || this.popoutChannel != null;
  }

  /** Open (or switch) the floating TV window with a channel. */
  openFloating(channel: TvChannel, options?: { pipHostOnly?: boolean }): void {
    if (!channel?.streamUrl && !channel?.id) {
      return;
    }
    this.clearPopoutWatch();
    const normalized: TvChannel = {
      ...channel,
      streamUrl: resolveTvStreamUrl(channel)
    };
    this.clearPendingResume();
    const pipHostOnly = !!options?.pipHostOnly;
    this.stateSubject.next({
      open: true,
      minimized: pipHostOnly ? true : false,
      channel: normalized,
      pipHostOnly
    });
  }

  setChannel(channel: TvChannel): void {
    if (!this.stateSubject.value.open) {
      this.openFloating(channel);
      return;
    }
    this.stateSubject.next({
      ...this.stateSubject.value,
      channel: {
        ...channel,
        streamUrl: resolveTvStreamUrl(channel)
      },
      minimized: this.stateSubject.value.pipHostOnly ? true : false,
      pipHostOnly: false
    });
  }

  minimize(): void {
    if (!this.stateSubject.value.open) {
      return;
    }
    this.stateSubject.next({ ...this.stateSubject.value, minimized: true });
  }

  restore(): void {
    if (!this.stateSubject.value.open) {
      return;
    }
    this.stateSubject.next({
      ...this.stateSubject.value,
      minimized: false,
      pipHostOnly: false
    });
  }

  /**
   * Close the in-page floating player.
   * By default asks the TV page to resume the last channel.
   */
  close(options?: { resumeOnPage?: boolean }): void {
    const channel = this.stateSubject.value.channel;
    const wasOpen = this.stateSubject.value.open;
    const wasPipHost = !!this.stateSubject.value.pipHostOnly;
    this.stateSubject.next({ open: false, minimized: false, channel: null, pipHostOnly: false });
    if (wasPipHost) {
      this.stopOsPip();
    }
    if (wasOpen && options?.resumeOnPage !== false && channel && !wasPipHost) {
      this.requestResumeOnPage(channel);
    }
  }

  /**
   * Open (or focus) a separate browser window with only the TV player.
   * The window can be moved outside the main PatTool tab / onto another monitor.
   * Closes the in-page floating player to avoid double audio.
   * When the pop-out closes, resumes playback on the TV page.
   */
  openExternalWindow(channel: TvChannel): Window | null {
    if (!channel?.streamUrl && !channel?.id) {
      return null;
    }
    const normalized: TvChannel = {
      ...channel,
      streamUrl: resolveTvStreamUrl(channel)
    };
    const payload: TvPopoutPayload = { channel: normalized, ts: Date.now() };
    try {
      localStorage.setItem(TvPlayerService.POPOUT_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* private mode / quota — popout may fail to read channel */
    }

    const hash = '#/tools/tv-popout';
    const url = `${window.location.origin}${window.location.pathname}${window.location.search}${hash}`;
    const features =
      'popup=yes,width=960,height=540,left=80,top=80,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=no';

    this.clearPopoutWatch();
    // Pop-out takes over: do not resume on page until that window closes.
    this.close({ resumeOnPage: false });
    this.clearPendingResume();

    const win = window.open(url, TvPlayerService.POPOUT_WINDOW_NAME, features);
    if (win) {
      try {
        win.focus();
      } catch {
        /* ignore */
      }
      this.popoutChannel = normalized;
      this.popoutWatchTimer = setInterval(() => {
        if (win.closed) {
          const ch = this.popoutChannel;
          this.clearPopoutWatch();
          this.popoutChannel = null;
          if (ch) {
            this.requestResumeOnPage(ch);
          }
        }
      }, 400);
    } else if (normalized) {
      // Popup blocked — resume on page instead of leaving a blank player.
      this.requestResumeOnPage(normalized);
    }
    return win;
  }

  /** Channel waiting to resume if the TV page was not mounted when detach ended. */
  consumePendingResume(): TvChannel | null {
    const ch = this.pendingResumeChannel;
    this.pendingResumeChannel = null;
    return ch;
  }

  clearPendingResume(): void {
    this.pendingResumeChannel = null;
  }

  readPopoutPayload(): TvPopoutPayload | null {
    try {
      const raw = localStorage.getItem(TvPlayerService.POPOUT_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as TvPopoutPayload;
      if (!parsed?.channel) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  static supportsVideoPictureInPicture(): boolean {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return false;
    }
    if ('documentPictureInPicture' in window) {
      return true;
    }
    return !!(document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled;
  }

  private requestResumeOnPage(channel: TvChannel): void {
    this.pendingResumeChannel = channel;
    this.resumeOnPageSubject.next(channel);
  }

  private clearPopoutWatch(): void {
    if (this.popoutWatchTimer != null) {
      clearInterval(this.popoutWatchTimer);
      this.popoutWatchTimer = null;
    }
  }
}

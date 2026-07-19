import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { TvChannel } from './api.service';
import { resolveTvStreamUrl } from '../tv-watcher/tv-stream.util';

export interface TvFloatingState {
  open: boolean;
  minimized: boolean;
  channel: TvChannel | null;
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
    channel: null
  });

  /** Emitted when detached playback ends and the in-page player should resume. */
  private readonly resumeOnPageSubject = new Subject<TvChannel>();
  readonly resumeOnPage$ = this.resumeOnPageSubject.asObservable();

  private pendingResumeChannel: TvChannel | null = null;
  private popoutWatchTimer: ReturnType<typeof setInterval> | null = null;
  private popoutChannel: TvChannel | null = null;

  readonly state$ = this.stateSubject.asObservable();

  get snapshot(): TvFloatingState {
    return this.stateSubject.value;
  }

  get isOpen(): boolean {
    return this.stateSubject.value.open;
  }

  /** Open (or switch) the floating TV window with a channel. */
  openFloating(channel: TvChannel): void {
    if (!channel?.streamUrl && !channel?.id) {
      return;
    }
    this.clearPopoutWatch();
    const normalized: TvChannel = {
      ...channel,
      streamUrl: resolveTvStreamUrl(channel)
    };
    this.clearPendingResume();
    this.stateSubject.next({
      open: true,
      minimized: false,
      channel: normalized
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
      minimized: false
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
    this.stateSubject.next({ ...this.stateSubject.value, minimized: false });
  }

  /**
   * Close the in-page floating player.
   * By default asks the TV page to resume the last channel.
   */
  close(options?: { resumeOnPage?: boolean }): void {
    const channel = this.stateSubject.value.channel;
    const wasOpen = this.stateSubject.value.open;
    this.stateSubject.next({ open: false, minimized: false, channel: null });
    if (wasOpen && options?.resumeOnPage !== false && channel) {
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
    if (typeof document === 'undefined') {
      return false;
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

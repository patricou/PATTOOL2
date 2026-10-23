import { Injectable } from '@angular/core';
import { BehaviorSubject, Subscription } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { of } from 'rxjs';

import { ApiService, RadioNowPlaying, RadioStation, RadioTrackImage } from './api.service';

const POLL_MS = 6_000;
const HANDOFF_MS = 1_600;

/**
 * Polls the track on air for whichever player currently owns the stream
 * (the radio page or the floating receiver).
 */
@Injectable({ providedIn: 'root' })
export class RadioNowPlayingService {
  private readonly stateSubject = new BehaviorSubject<RadioNowPlaying | null>(null);
  readonly state$ = this.stateSubject.asObservable();

  private owner = '';
  private streamUrl = '';
  private station: RadioStation | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private grace: ReturnType<typeof setTimeout> | null = null;
  private request: Subscription | null = null;

  constructor(private api: ApiService) {}

  watch(owner: string, station: RadioStation | null | undefined): void {
    this.clearGrace();
    const url = (station?.streamUrl || '').trim();
    if (!owner || !url || isRadioPodcastUrl(url)) {
      if (this.owner === owner) {
        this.release(owner);
      }
      return;
    }
    const urlChanged = this.streamUrl !== url;
    this.owner = owner;
    this.station = station!;
    this.streamUrl = url;
    if (urlChanged) {
      this.stateSubject.next(null);
    }
    this.poll();
    this.restartTimer();
  }

  release(owner: string): void {
    if (!owner || this.owner !== owner) {
      return;
    }
    this.owner = '';
    this.stopTimer();
    this.request?.unsubscribe();
    this.request = null;
    this.clearGrace();
    this.grace = setTimeout(() => {
      this.grace = null;
      if (this.owner) {
        return;
      }
      this.streamUrl = '';
      this.station = null;
      this.stateSubject.next(null);
    }, HANDOFF_MS);
  }

  private poll(): void {
    const station = this.station;
    const url = this.streamUrl;
    if (!station || !url) {
      return;
    }
    this.request?.unsubscribe();
    this.request = this.api.getRadioNowPlaying(station).pipe(
      catchError(() => of(null))
    ).subscribe((res) => {
      if (this.streamUrl !== url || res == null) {
        return;
      }
      this.stateSubject.next(normalizeNowPlaying(res, (imageUrl) => this.api.absoluteApiUrl(imageUrl)));
    });
  }

  private restartTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private clearGrace(): void {
    if (this.grace) {
      clearTimeout(this.grace);
      this.grace = null;
    }
  }
}

export function isRadioPodcastUrl(url: string): boolean {
  const value = (url || '').toLowerCase();
  const path = value.split('?')[0];
  return path.endsWith('.m4a') || path.includes('/podcast');
}

export function normalizeNowPlaying(
  res: RadioNowPlaying | null | undefined,
  resolveUrl?: (url: string) => string
): RadioNowPlaying | null {
  if (!res) {
    return null;
  }
  const title = (res.title || '').trim();
  const artist = (res.artist || '').trim();
  const label = (res.label || '').trim() || (artist && title ? `${artist} — ${title}` : title);
  const images = (res.images || [])
    .filter((img): img is RadioTrackImage => !!img?.url)
    .map((img) => ({
      ...img,
      url: resolveUrl ? resolveUrl(img.url) : img.url
    }))
    .filter((img) => !!img.url);
  if (!label && images.length === 0) {
    return null;
  }
  return { title, artist, album: (res.album || '').trim(), label, images };
}

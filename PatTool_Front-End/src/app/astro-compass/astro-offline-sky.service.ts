import { Injectable } from '@angular/core';

export type AstroSkyClockMode = 'live' | 'offline';
export type AstroSkyEpoch = 'past' | 'present' | 'future';

const PRESENT_TOLERANCE_MS = 120_000;

/**
 * Sky instant for the astro compass.
 * Live uses the device clock (network feeds stay allowed).
 * Offline uses a chosen instant and must not trigger position fetches:
 * planets, stars and deep-sky are computed locally; satellites only if a TLE
 * is already in memory.
 */
@Injectable({ providedIn: 'root' })
export class AstroOfflineSkyService {
  mode: AstroSkyClockMode = 'live';
  /** Frozen sky instant. Ignored while {@link followClock} is true. */
  skyAtMs = Date.now();
  /** Offline present follows the device clock, still without network fetches. */
  followClock = true;

  isOffline(): boolean {
    return this.mode === 'offline';
  }

  skyNowMs(): number {
    if (this.mode === 'live' || this.followClock) {
      return Date.now();
    }
    return this.skyAtMs;
  }

  skyDate(): Date {
    return new Date(this.skyNowMs());
  }

  epoch(): AstroSkyEpoch {
    if (this.mode === 'live' || this.followClock) {
      return 'present';
    }
    const delta = this.skyAtMs - Date.now();
    if (Math.abs(delta) < PRESENT_TOLERANCE_MS) {
      return 'present';
    }
    return delta < 0 ? 'past' : 'future';
  }

  /** Live ↔ offline present. Past/future offsets are cleared on the way back to live. */
  toggle(): void {
    if (this.mode === 'live') {
      this.mode = 'offline';
      this.followClock = true;
      this.skyAtMs = Date.now();
      return;
    }
    this.mode = 'live';
    this.followClock = true;
    this.skyAtMs = Date.now();
  }

  /** Offline present: device clock, no position network. */
  setPresent(): void {
    this.mode = 'offline';
    this.followClock = true;
    this.skyAtMs = Date.now();
  }

  /** Offline instant at a fixed offset from the real now (past or future anchor). */
  setOffsetFromNow(deltaMs: number): void {
    this.mode = 'offline';
    this.followClock = false;
    this.skyAtMs = Date.now() + deltaMs;
  }

  /** Shift the offline instant. A live or following clock starts from the real now. */
  nudge(deltaMs: number): void {
    const base = this.mode === 'offline' && !this.followClock ? this.skyAtMs : Date.now();
    this.mode = 'offline';
    this.followClock = false;
    this.skyAtMs = base + deltaMs;
  }

  setAbsolute(ms: number): void {
    if (!Number.isFinite(ms)) {
      return;
    }
    this.mode = 'offline';
    this.skyAtMs = ms;
    this.followClock = Math.abs(ms - Date.now()) < PRESENT_TOLERANCE_MS;
  }

  /** Stamp so trails and caches drop when the simulated instant jumps. */
  trailStamp(): string {
    if (this.mode !== 'offline') {
      return ':live';
    }
    return this.followClock ? ':off:now' : `:off:${this.skyAtMs}`;
  }

  /** Value for input type="datetime-local" in the device timezone. */
  localInputValue(ms = this.skyNowMs()): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}

import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { RadioStation } from './api.service';

export interface RadioFloatingState {
  open: boolean;
  minimized: boolean;
  station: RadioStation | null;
  /**
   * Invisible shell host used only to keep Document / OS Picture-in-Picture alive across routes.
   * The World Receiver cabinet still renders so it can be moved into the PiP window.
   */
  pipHostOnly?: boolean;
  /**
   * After the stream starts, open Document PiP with the floating World Receiver face
   * (same look as PiP from the Radio page).
   */
  autoPip?: boolean;
}

@Injectable({ providedIn: 'root' })
export class RadioPlayerService {
  private readonly stateSubject = new BehaviorSubject<RadioFloatingState>({
    open: false,
    minimized: false,
    station: null,
    pipHostOnly: false,
    autoPip: false
  });

  private readonly resumeOnPageSubject = new Subject<RadioStation>();
  readonly resumeOnPage$ = this.resumeOnPageSubject.asObservable();

  private pendingResumeStation: RadioStation | null = null;
  private favoritesSnapshot: RadioStation[] = [];

  readonly state$ = this.stateSubject.asObservable();

  get snapshot(): RadioFloatingState {
    return this.stateSubject.value;
  }

  get isOpen(): boolean {
    return this.stateSubject.value.open;
  }

  /** Favorites used as preset buttons on the floating World Receiver. */
  get favorites(): RadioStation[] {
    return this.favoritesSnapshot;
  }

  setFavorites(stations: RadioStation[] | null | undefined): void {
    this.favoritesSnapshot = Array.isArray(stations) ? stations.map((s) => ({ ...s })) : [];
  }

  openFloating(
    station: RadioStation,
    options?: { pipHostOnly?: boolean; autoPip?: boolean; minimized?: boolean }
  ): void {
    if (!station?.streamUrl && !station?.id) {
      return;
    }
    this.clearPendingResume();
    const pipHostOnly = !!options?.pipHostOnly;
    const autoPip = !!options?.autoPip || pipHostOnly;
    this.stateSubject.next({
      open: true,
      minimized: options?.minimized != null ? !!options.minimized : pipHostOnly,
      station: { ...station },
      pipHostOnly,
      autoPip
    });
  }

  setStation(station: RadioStation): void {
    if (!this.stateSubject.value.open) {
      this.openFloating(station);
      return;
    }
    // Only swap the station — keep PiP / World Receiver / minimized flags as-is.
    // (Previously this forced minimized + cleared pipHostOnly, which collapsed the
    // cabinet into the compact toolbar when using preset buttons.)
    this.stateSubject.next({
      ...this.stateSubject.value,
      station: { ...station }
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
      pipHostOnly: false,
      autoPip: false
    });
  }

  /**
   * Close the floating radio.
   * By default asks the radio page to resume the last station.
   */
  close(options?: { resumeOnPage?: boolean }): void {
    const station = this.stateSubject.value.station;
    const wasOpen = this.stateSubject.value.open;
    this.stateSubject.next({
      open: false,
      minimized: false,
      station: null,
      pipHostOnly: false,
      autoPip: false
    });
    if (wasOpen && options?.resumeOnPage !== false && station) {
      this.pendingResumeStation = station;
      this.resumeOnPageSubject.next(station);
    } else {
      this.clearPendingResume();
    }
  }

  consumePendingResume(): RadioStation | null {
    const s = this.pendingResumeStation;
    this.pendingResumeStation = null;
    return s;
  }

  clearPendingResume(): void {
    this.pendingResumeStation = null;
  }
}

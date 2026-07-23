import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { RadioStation } from './api.service';

export interface RadioFloatingState {
  open: boolean;
  minimized: boolean;
  station: RadioStation | null;
  /**
   * Invisible shell host used only to keep OS Picture-in-Picture alive across routes.
   */
  pipHostOnly?: boolean;
}

@Injectable({ providedIn: 'root' })
export class RadioPlayerService {
  private readonly stateSubject = new BehaviorSubject<RadioFloatingState>({
    open: false,
    minimized: false,
    station: null,
    pipHostOnly: false
  });

  private readonly resumeOnPageSubject = new Subject<RadioStation>();
  readonly resumeOnPage$ = this.resumeOnPageSubject.asObservable();

  private pendingResumeStation: RadioStation | null = null;

  readonly state$ = this.stateSubject.asObservable();

  get snapshot(): RadioFloatingState {
    return this.stateSubject.value;
  }

  get isOpen(): boolean {
    return this.stateSubject.value.open;
  }

  openFloating(station: RadioStation, options?: { pipHostOnly?: boolean }): void {
    if (!station?.streamUrl && !station?.id) {
      return;
    }
    this.clearPendingResume();
    const pipHostOnly = !!options?.pipHostOnly;
    this.stateSubject.next({
      open: true,
      minimized: pipHostOnly ? true : false,
      station: { ...station },
      pipHostOnly
    });
  }

  setStation(station: RadioStation): void {
    if (!this.stateSubject.value.open) {
      this.openFloating(station);
      return;
    }
    this.stateSubject.next({
      ...this.stateSubject.value,
      station: { ...station },
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
   * Close the floating radio.
   * By default asks the radio page to resume the last station.
   */
  close(options?: { resumeOnPage?: boolean }): void {
    const station = this.stateSubject.value.station;
    const wasOpen = this.stateSubject.value.open;
    const wasPipHost = !!this.stateSubject.value.pipHostOnly;
    this.stateSubject.next({ open: false, minimized: false, station: null, pipHostOnly: false });
    if (wasOpen && options?.resumeOnPage !== false && station && !wasPipHost) {
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

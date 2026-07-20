import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { RadioStation } from './api.service';

export interface RadioFloatingState {
  open: boolean;
  minimized: boolean;
  station: RadioStation | null;
}

@Injectable({ providedIn: 'root' })
export class RadioPlayerService {
  private readonly stateSubject = new BehaviorSubject<RadioFloatingState>({
    open: false,
    minimized: false,
    station: null
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

  openFloating(station: RadioStation): void {
    if (!station?.streamUrl && !station?.id) {
      return;
    }
    this.clearPendingResume();
    this.stateSubject.next({
      open: true,
      minimized: false,
      station: { ...station }
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

  close(): void {
    const station = this.stateSubject.value.station;
    this.stateSubject.next({ open: false, minimized: false, station: null });
    if (station) {
      this.pendingResumeStation = station;
      this.resumeOnPageSubject.next(station);
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

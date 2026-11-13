import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

/** Asks the app shell to show the calculator over the current page. */
@Injectable({ providedIn: 'root' })
export class CalculatorModalService {
  private readonly openRequests = new Subject<void>();
  readonly open$ = this.openRequests.asObservable();
  private listening = false;
  private pending = false;

  open(): void {
    if (!this.listening) {
      this.pending = true;
      return;
    }
    this.openRequests.next();
  }

  /** Call once the shell is subscribed, so a guard that ran earlier is not lost. */
  attach(): void {
    this.listening = true;
    if (!this.pending) {
      return;
    }
    this.pending = false;
    this.openRequests.next();
  }
}

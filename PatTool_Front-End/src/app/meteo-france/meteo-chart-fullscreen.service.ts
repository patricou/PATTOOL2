import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class MeteoChartFullscreenService {
  private closeFn: (() => void) | null = null;

  register(closeFn: () => void): void {
    this.closeFn = closeFn;
  }

  unregister(closeFn: () => void): void {
    if (this.closeFn === closeFn) {
      this.closeFn = null;
    }
  }

  closeIfActive(): boolean {
    if (!this.closeFn) {
      return false;
    }
    const fn = this.closeFn;
    this.closeFn = null;
    fn();
    return true;
  }
}

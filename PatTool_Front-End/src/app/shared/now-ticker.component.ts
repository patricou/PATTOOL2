import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';

export interface NowTickerItem {
  key?: string;
  value: string;
}

/** Full-width scrolling strip, same shape as the satellite ticker. */
@Component({
  selector: 'app-now-ticker',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './now-ticker.component.html',
  styleUrls: ['./now-ticker.component.css']
})
export class NowTickerComponent {
  @Input() label = '';
  @Input() icon = 'fa-music';
  @Input() accent = '#1f6feb';
  @Input() idle = '';
  @Input() ariaLabel = '';
  @Input() items: NowTickerItem[] = [];

  readonly repeats = [0, 1, 2, 3, 4, 5, 6, 7];

  trackIndex(index: number): number {
    return index;
  }

  get durationSec(): number {
    const one = this.items.reduce(
      (sum, item) => sum + (item.key ? item.key.length + 2 : 0) + item.value.length + 4,
      0
    );
    const seconds = (one * this.repeats.length * 8) / 72;
    return Math.max(28, Math.min(160, Math.round(seconds)));
  }
}

export function clipNowTickerText(value: string | null | undefined, max = 360): string {
  const clean = (value || '').replace(/\s+/g, ' ').trim();
  if (!clean) {
    return '';
  }
  if (clean.length <= max) {
    return clean;
  }
  return clean.slice(0, max - 1).trimEnd() + '…';
}

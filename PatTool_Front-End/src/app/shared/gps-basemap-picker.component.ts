import { CommonModule } from '@angular/common';
import { Component, EventEmitter, HostListener, Input, Output } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

import { LeafletBasemapOption } from './leaflet-basemap.service';

@Component({
  selector: 'app-gps-basemap-picker',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  template: `
    <div class="gbp" (click)="$event.stopPropagation()">
      <span class="gbp__label" *ngIf="label">{{ label }}</span>
      <div class="gbp__wrap">
        <button type="button"
                class="gbp__trigger"
                (click)="toggle($event)"
                [attr.aria-expanded]="open"
                [attr.aria-label]="label || null">
          <span class="gbp__value">
            <ng-container *ngIf="currentOption as opt; else gbpIdFallback">
              {{ opt.labelKey ? (opt.labelKey | translate) : opt.label }}
            </ng-container>
            <ng-template #gbpIdFallback>{{ layerId }}</ng-template>
          </span>
          <i class="fa fa-caret-down gbp__caret" aria-hidden="true"></i>
        </button>
        <ul class="gbp__list"
            *ngIf="open"
            role="listbox"
            [ngStyle]="menuStyle">
          <li *ngFor="let opt of options">
            <button type="button"
                    class="gbp__opt"
                    role="option"
                    [class.gbp__opt--active]="opt.id === layerId"
                    [attr.aria-selected]="opt.id === layerId"
                    (click)="choose(opt.id, $event)">
              {{ opt.labelKey ? (opt.labelKey | translate) : opt.label }}
            </button>
          </li>
        </ul>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .gbp {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      min-width: 0;
      position: relative;
    }
    .gbp__label {
      font-size: 0.8rem;
      color: #6c757d;
      white-space: nowrap;
    }
    .gbp__wrap { position: relative; min-width: 0; }
    .gbp__trigger {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      width: auto;
      min-width: 9.5rem;
      max-width: 16rem;
      margin: 0;
      padding: 0.32rem 0.55rem;
      border-radius: 0.4rem;
      border: 1px solid rgba(0, 0, 0, 0.18);
      background: #fff;
      color: #212529;
      font-family: inherit;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.25;
      text-align: left;
      cursor: pointer;
      -webkit-appearance: none;
      appearance: none;
    }
    .gbp__value {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .gbp__caret { flex: 0 0 auto; opacity: 0.8; }
    .gbp__list {
      position: fixed;
      z-index: 1025;
      list-style: none;
      margin: 0;
      padding: 0.15rem 0;
      overflow-x: hidden;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      border-radius: 0.4rem;
      border: 1px solid rgba(0, 0, 0, 0.16);
      background: #fff;
      color: #212529;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);
    }
    .gbp__list li { margin: 0; padding: 0; }
    .gbp__opt {
      display: block;
      width: 100%;
      margin: 0;
      padding: 0.38rem 0.65rem;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: #212529;
      font-family: inherit;
      font-size: 13px;
      font-weight: 400;
      line-height: 1.25;
      text-align: left;
      cursor: pointer;
      -webkit-appearance: none;
      appearance: none;
    }
    .gbp__opt:hover,
    .gbp__opt:focus-visible {
      background: #e9ecef;
      outline: none;
    }
    .gbp__opt--active {
      background: #dbeafe;
      color: #111;
      font-weight: 600;
    }
    .gbp__opt--active:hover,
    .gbp__opt--active:focus-visible {
      background: #cfe2ff;
    }
  `]
})
export class GpsBasemapPickerComponent {
  @Input() layerId = '';
  @Input() options: LeafletBasemapOption[] = [];
  @Input() label = '';
  @Output() layerIdChange = new EventEmitter<string>();

  open = false;
  menuStyle: Record<string, string> | null = null;
  private trigger: HTMLElement | null = null;
  private ignoreDocClick = false;

  get currentOption(): LeafletBasemapOption | undefined {
    return this.options.find((o) => o.id === this.layerId);
  }

  toggle(event: Event): void {
    event.stopPropagation();
    this.open = !this.open;
    this.trigger = this.open ? (event.currentTarget as HTMLElement) : null;
    this.ignoreDocClick = true;
    queueMicrotask(() => {
      this.ignoreDocClick = false;
    });
    if (this.open) {
      this.layoutMenu();
    } else {
      this.menuStyle = null;
    }
  }

  choose(id: string, event?: Event): void {
    event?.stopPropagation();
    this.open = false;
    this.menuStyle = null;
    this.trigger = null;
    if (id !== this.layerId) {
      this.layerIdChange.emit(id);
    }
  }

  close(): void {
    this.open = false;
    this.menuStyle = null;
    this.trigger = null;
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    if (this.ignoreDocClick) {
      return;
    }
    this.close();
  }

  @HostListener('document:show.bs.dropdown')
  onMainNavDropdown(): void {
    this.close();
  }

  @HostListener('window:resize')
  onResize(): void {
    if (this.open) {
      this.layoutMenu();
    }
  }

  private layoutMenu(): void {
    const trigger = this.trigger;
    if (!trigger) {
      this.menuStyle = null;
      return;
    }
    const r = trigger.getBoundingClientRect();
    const width = Math.max(r.width, 200);
    const maxHeight = Math.min(window.innerHeight * 0.45, 288);
    const spaceBelow = window.innerHeight - r.bottom - 8;
    const openUp = spaceBelow < 140 && r.top > spaceBelow;
    const top = openUp ? Math.max(8, r.top - 4 - maxHeight) : r.bottom + 4;
    let left = r.left;
    if (left + width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - width - 8);
    }
    this.menuStyle = {
      top: `${top}px`,
      left: `${left}px`,
      width: `${width}px`,
      maxHeight: `${maxHeight}px`
    };
  }
}

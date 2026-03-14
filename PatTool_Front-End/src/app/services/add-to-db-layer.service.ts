import { Injectable } from '@angular/core';

const LAYER_ID = 'pat-add-to-db-layer';

/**
 * Renders overlay and toast for "add photo to DB" (slideshow) at body level
 * so they appear above NgbModal (which is also appended to body).
 */
@Injectable({
  providedIn: 'root'
})
export class AddToDbLayerService {
  private container: HTMLElement | null = null;
  private overlayEl: HTMLElement | null = null;
  private toastEl: HTMLElement | null = null;

  private getOrCreateContainer(): HTMLElement {
    if (this.container) return this.container;
    let el = document.getElementById(LAYER_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = LAYER_ID;
      document.body.appendChild(el);
    }
    this.container = el;
    return el;
  }

  showOverlay(loadingText: string): void {
    this.hideOverlay();
    const container = this.getOrCreateContainer();
    const div = document.createElement('div');
    div.className = 'add-to-db-overlay';
    div.setAttribute('role', 'status');
    div.setAttribute('aria-live', 'polite');
    div.innerHTML = `
      <div class="spinner-border text-light" role="status"></div>
      <span class="text-light mt-2">${escapeHtml(loadingText)}</span>
    `;
    container.appendChild(div);
    this.overlayEl = div;
  }

  hideOverlay(): void {
    if (this.overlayEl && this.overlayEl.parentNode) {
      this.overlayEl.parentNode.removeChild(this.overlayEl);
    }
    this.overlayEl = null;
  }

  showToast(title: string, message: string, success: boolean): void {
    this.hideToast();
    const container = this.getOrCreateContainer();
    const div = document.createElement('div');
    div.className = 'add-to-db-toast ' + (success ? 'add-to-db-toast-success' : 'add-to-db-toast-error');
    div.setAttribute('role', 'alert');
    const iconClass = success ? 'fa-check-circle' : 'fa-exclamation-circle';
    div.innerHTML = `
      <i class="fa fa-2x ${iconClass}"></i>
      <span class="add-to-db-toast-content">
        <strong>${escapeHtml(title)}</strong>
        <span class="d-block mt-1">${escapeHtml(message)}</span>
      </span>
    `;
    container.appendChild(div);
    this.toastEl = div;
  }

  hideToast(): void {
    if (this.toastEl && this.toastEl.parentNode) {
      this.toastEl.parentNode.removeChild(this.toastEl);
    }
    this.toastEl = null;
  }
}

function escapeHtml(text: string): string {
  const span = document.createElement('span');
  span.textContent = text;
  return span.innerHTML;
}

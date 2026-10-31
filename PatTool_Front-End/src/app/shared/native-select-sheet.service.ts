import { Injectable, NgZone } from '@angular/core';
import { Capacitor } from '@capacitor/core';

const MOBILE_MQ = '(max-width: 800px)';
const SEARCH_AFTER = 8;

/**
 * On Android, iOS and narrow screens, a native &lt;select&gt; opens the OS picker.
 * This keeps the closed control as-is and opens the app sheet instead.
 */
@Injectable({ providedIn: 'root' })
export class NativeSelectSheetService {
  private started = false;
  private active = false;
  private suppressClick = false;
  private pointerDownX = 0;
  private pointerDownY = 0;
  private pointerDownOnSelect = false;
  private observer?: MutationObserver;
  private media?: MediaQueryList;
  private root?: HTMLElement;
  private previousBodyOverflow = '';
  private markQueued = false;

  private readonly onMediaChange = (): void => {
    this.syncActive();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.active || this.root || event.button !== 0) {
      this.pointerDownOnSelect = false;
      return;
    }
    this.pointerDownX = event.clientX;
    this.pointerDownY = event.clientY;
    this.pointerDownOnSelect = !!this.selectFromPoint(event.clientX, event.clientY);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.active || this.root || event.button !== 0 || !this.pointerDownOnSelect) {
      return;
    }
    this.pointerDownOnSelect = false;
    if (Math.hypot(event.clientX - this.pointerDownX, event.clientY - this.pointerDownY) > 12) {
      return;
    }
    const select = this.selectFromPoint(event.clientX, event.clientY);
    if (!select) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.suppressClick = true;
    this.open(select);
  };

  private readonly onClick = (event: MouseEvent): void => {
    if (this.suppressClick) {
      this.suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!this.active || this.root) {
      return;
    }
    const select = this.selectFromPoint(event.clientX, event.clientY);
    if (!select) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.open(select);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.root) {
      event.preventDefault();
      this.close();
      return;
    }
    if (!this.active || this.root) {
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLSelectElement && active.classList.contains('pat-select-sheet-target')) {
      event.preventDefault();
      this.open(active);
    }
  };

  constructor(private readonly ngZone: NgZone) {}

  start(): void {
    if (this.started || typeof document === 'undefined') {
      return;
    }
    this.started = true;
    this.ngZone.runOutsideAngular(() => {
      this.media = window.matchMedia(MOBILE_MQ);
      this.media.addEventListener('change', this.onMediaChange);
      document.addEventListener('pointerdown', this.onPointerDown, { capture: true, passive: true });
      document.addEventListener('pointerup', this.onPointerUp, { capture: true, passive: false });
      document.addEventListener('click', this.onClick, true);
      document.addEventListener('keydown', this.onKeyDown, true);
      this.observer = new MutationObserver(() => this.queueMark());
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'hidden']
      });
      this.syncActive();
    });
  }

  private syncActive(): void {
    const next = nativeMobilePlatform() || !!this.media?.matches;
    if (next === this.active) {
      if (next) {
        this.markSelects();
      }
      return;
    }
    this.active = next;
    if (!next) {
      this.close();
      this.clearMarks();
      return;
    }
    this.markSelects();
  }

  private queueMark(): void {
    if (!this.active || this.markQueued) {
      return;
    }
    this.markQueued = true;
    requestAnimationFrame(() => {
      this.markQueued = false;
      if (this.active) {
        this.markSelects();
      }
    });
  }

  private markSelects(): void {
    document.querySelectorAll('select').forEach((node) => {
      if (!(node instanceof HTMLSelectElement)) {
        return;
      }
      if (this.shouldUpgrade(node)) {
        if (node.classList.contains('pat-select-sheet-target')) {
          return;
        }
        if (!node.hasAttribute('data-pat-tabindex')) {
          node.setAttribute('data-pat-tabindex', node.getAttribute('tabindex') ?? '');
        }
        node.tabIndex = -1;
        node.classList.add('pat-select-sheet-target');
        return;
      }
      if (node.classList.contains('pat-select-sheet-target') || node.hasAttribute('data-pat-tabindex')) {
        this.restoreSelect(node);
      }
    });
  }

  private clearMarks(): void {
    document.querySelectorAll('select').forEach((node) => {
      if (node instanceof HTMLSelectElement) {
        this.restoreSelect(node);
      }
    });
  }

  private restoreSelect(select: HTMLSelectElement): void {
    select.classList.remove('pat-select-sheet-target');
    if (!select.hasAttribute('data-pat-tabindex')) {
      return;
    }
    const previous = select.getAttribute('data-pat-tabindex') ?? '';
    select.removeAttribute('data-pat-tabindex');
    if (previous === '') {
      select.removeAttribute('tabindex');
    } else {
      select.tabIndex = Number(previous);
    }
  }

  private shouldUpgrade(select: HTMLSelectElement): boolean {
    if (select.multiple || select.size > 1 || select.disabled) {
      return false;
    }
    if (select.classList.contains('pat-sheet-select-native')) {
      return false;
    }
    if (select.closest('.ag-root-wrapper, .ag-popup, .pat-sheet-select')) {
      return false;
    }
    return true;
  }

  private selectFromPoint(x: number, y: number): HTMLSelectElement | null {
    const top = document.elementFromPoint(x, y);
    if (!(top instanceof Element) || top.closest('.pat-sheet-select-root')) {
      return null;
    }
    if (top.closest('button, a, input, textarea, [role="button"]')) {
      return null;
    }
    const label = top.closest('label');
    if (label instanceof HTMLLabelElement) {
      const fromLabel = this.selectForLabel(label);
      if (fromLabel) {
        return fromLabel;
      }
    }
    const selects = document.querySelectorAll('select.pat-select-sheet-target');
    for (let i = 0; i < selects.length; i++) {
      const node = selects[i];
      if (!(node instanceof HTMLSelectElement) || !this.isHitTarget(node)) {
        continue;
      }
      const rect = node.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        continue;
      }
      const host = node.parentElement;
      if (host && (top === host || host.contains(top))) {
        return node;
      }
    }
    return null;
  }

  private selectForLabel(label: HTMLLabelElement): HTMLSelectElement | null {
    const control = label.control;
    if (control instanceof HTMLSelectElement && control.classList.contains('pat-select-sheet-target') && this.isHitTarget(control)) {
      return control;
    }
    const nested = label.querySelector('select.pat-select-sheet-target');
    if (nested instanceof HTMLSelectElement && this.isHitTarget(nested)) {
      return nested;
    }
    return null;
  }

  private isHitTarget(select: HTMLSelectElement): boolean {
    if (!this.shouldUpgrade(select)) {
      return false;
    }
    const style = window.getComputedStyle(select);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    const rect = select.getBoundingClientRect();
    return rect.width >= 8 && rect.height >= 8;
  }

  private open(select: HTMLSelectElement): void {
    if (this.root || !this.shouldUpgrade(select)) {
      return;
    }
    const searchable = select.options.length > SEARCH_AFTER;
    const title = selectTitle(select);
    const root = document.createElement('div');
    root.className = 'pat-sheet-select-root' + (searchable ? ' pat-sheet-select-root--search' : '');
    root.addEventListener('click', () => this.close());

    const sheet = document.createElement('div');
    sheet.className = 'pat-sheet-select-sheet' + (searchable ? ' pat-sheet-select-sheet--search' : '');
    sheet.setAttribute('role', 'listbox');
    if (title) {
      sheet.setAttribute('aria-label', title);
    }
    sheet.addEventListener('click', (event) => event.stopPropagation());

    const handle = document.createElement('div');
    handle.className = 'pat-sheet-select-handle';
    handle.setAttribute('aria-hidden', 'true');
    sheet.appendChild(handle);

    if (title) {
      const head = document.createElement('header');
      head.className = 'pat-sheet-select-head';
      const heading = document.createElement('h2');
      heading.className = 'pat-sheet-select-title';
      heading.textContent = title;
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'pat-sheet-select-close';
      closeBtn.setAttribute('aria-label', 'Close');
      const icon = document.createElement('i');
      icon.className = 'fa fa-times';
      icon.setAttribute('aria-hidden', 'true');
      closeBtn.appendChild(icon);
      closeBtn.addEventListener('click', () => this.close());
      head.appendChild(heading);
      head.appendChild(closeBtn);
      sheet.appendChild(head);
    }

    const list = document.createElement('div');
    list.className = 'pat-sheet-select-list';

    if (searchable) {
      const search = document.createElement('div');
      search.className = 'pat-sheet-select-search';
      const searchIcon = document.createElement('i');
      searchIcon.className = 'fa fa-search';
      searchIcon.setAttribute('aria-hidden', 'true');
      const input = document.createElement('input');
      input.type = 'search';
      input.className = 'pat-sheet-select-search-input';
      input.autocomplete = 'off';
      input.placeholder = title;
      input.enterKeyHint = 'search';
      input.inputMode = 'search';
      input.addEventListener('input', () => this.fillOptions(list, select, input.value));
      input.addEventListener('click', (event) => event.stopPropagation());
      search.appendChild(searchIcon);
      search.appendChild(input);
      sheet.appendChild(search);
      setTimeout(() => input.focus(), 40);
    }

    sheet.appendChild(list);
    root.appendChild(sheet);
    this.fillOptions(list, select, '');
    this.previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.appendChild(root);
    this.root = root;
    this.applyViewport(root);
  }

  private fillOptions(list: HTMLElement, select: HTMLSelectElement, query: string): void {
    list.replaceChildren();
    const needle = foldSearchText(query);
    let shown = 0;
    let lastGroup = '';
    for (let index = 0; index < select.options.length; index++) {
      const option = select.options[index];
      if (option.hidden) {
        continue;
      }
      const label = option.text.replace(/\s+/g, ' ').trim();
      if (needle && !foldSearchText(label).includes(needle)) {
        continue;
      }
      const group = option.parentElement instanceof HTMLOptGroupElement
        ? option.parentElement.label
        : '';
      if (group && group !== lastGroup) {
        lastGroup = group;
        const groupEl = document.createElement('div');
        groupEl.className = 'pat-sheet-select-group';
        groupEl.textContent = group;
        list.appendChild(groupEl);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pat-sheet-select-option';
      button.setAttribute('role', 'option');
      const selected = index === select.selectedIndex;
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (selected) {
        button.classList.add('pat-sheet-select-option--on');
      }
      button.disabled = option.disabled;
      const text = document.createElement('span');
      text.className = 'pat-sheet-select-option-label';
      text.textContent = label;
      button.appendChild(text);
      if (selected) {
        const check = document.createElement('i');
        check.className = 'fa fa-check pat-sheet-select-check';
        check.setAttribute('aria-hidden', 'true');
        button.appendChild(check);
      }
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (option.disabled) {
          return;
        }
        this.pick(select, index);
      });
      list.appendChild(button);
      shown++;
    }
    if (!shown) {
      const empty = document.createElement('p');
      empty.className = 'pat-sheet-select-empty';
      empty.textContent = '—';
      list.appendChild(empty);
    }
  }

  private pick(select: HTMLSelectElement, index: number): void {
    try {
      this.ngZone.run(() => {
        if (select.selectedIndex !== index) {
          select.selectedIndex = index;
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        select.dispatchEvent(new Event('blur'));
      });
    } finally {
      this.close();
    }
  }

  private close(): void {
    const root = this.root;
    this.root = undefined;
    if (root) {
      root.remove();
      document.body.style.overflow = this.previousBodyOverflow;
    }
  }

  private applyViewport(root: HTMLElement): void {
    const top = window.visualViewport?.offsetTop ?? 0;
    const height = window.visualViewport?.height ?? window.innerHeight;
    root.style.top = `${top}px`;
    root.style.height = `${height}px`;
    root.style.bottom = 'auto';
  }
}

function nativeMobilePlatform(): boolean {
  try {
    const platform = Capacitor.getPlatform();
    return platform === 'android' || platform === 'ios';
  } catch {
    return false;
  }
}

function selectTitle(select: HTMLSelectElement): string {
  const labelledBy = select.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) {
      return text;
    }
  }
  if (select.labels && select.labels.length) {
    const copy = select.labels[0].cloneNode(true) as HTMLElement;
    copy.querySelectorAll('select').forEach((node) => node.remove());
    const text = copy.textContent?.replace(/\s+/g, ' ').trim();
    if (text) {
      return text;
    }
  }
  return (select.getAttribute('aria-label') || select.getAttribute('title') || '').trim();
}

function foldSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

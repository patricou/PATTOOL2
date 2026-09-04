import {
  ApplicationRef,
  ChangeDetectorRef,
  Component,
  EmbeddedViewRef,
  EventEmitter,
  HostListener,
  Inject,
  Input,
  NgZone,
  OnDestroy,
  OnInit,
  Output,
  TemplateRef,
  ViewChild,
  ViewEncapsulation,
  forwardRef
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { CommonModule } from '@angular/common';
import { ControlValueAccessor, FormsModule, NG_VALUE_ACCESSOR } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

export interface SheetSelectOption {
  value: unknown;
  label?: string;
  labelKey?: string;
  labelParams?: Record<string, unknown>;
  icon?: string;
}

const MOBILE_MQ = '(max-width: 800px)';

@Component({
  selector: 'app-sheet-select',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './sheet-select.component.html',
  styleUrls: ['./sheet-select.component.css'],
  encapsulation: ViewEncapsulation.None,
  providers: [{
    provide: NG_VALUE_ACCESSOR,
    useExisting: forwardRef(() => SheetSelectComponent),
    multi: true
  }]
})
export class SheetSelectComponent implements ControlValueAccessor, OnInit, OnDestroy {

  @Input() options: SheetSelectOption[] = [];
  @Input() title = '';
  @Input() selectId = '';
  @Input() size: 'md' | 'sm' = 'md';
  @Input() searchable: boolean | null = null;
  @Input() searchPlaceholder = '';
  @Input() disabled = false;

  @Output() selectionChange = new EventEmitter<unknown>();

  @ViewChild('sheetTpl') sheetTpl?: TemplateRef<unknown>;

  value: unknown;
  open = false;
  isMobile = false;
  filterQuery = '';

  readonly compareValues = (a: unknown, b: unknown): boolean =>
    String(a ?? '') === String(b ?? '');

  private sheetView?: EmbeddedViewRef<unknown>;
  private media?: MediaQueryList;
  private previousBodyOverflow = '';
  private langSub?: Subscription;
  private viewportBound = false;
  private onChange: (value: unknown) => void = () => {};
  private onTouched: () => void = () => {};

  private readonly onVisualViewport = (): void => {
    this.applyVisualViewport();
  };

  private readonly onMediaChange = (event: MediaQueryListEvent): void => {
    this.ngZone.run(() => {
      this.isMobile = event.matches;
      if (!this.isMobile) {
        this.close();
      }
      this.cdr.markForCheck();
    });
  };

  constructor(
    @Inject(DOCUMENT) private readonly document: Document,
    private readonly appRef: ApplicationRef,
    private readonly translate: TranslateService,
    private readonly ngZone: NgZone,
    private readonly cdr: ChangeDetectorRef
  ) {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.isMobile = window.matchMedia(MOBILE_MQ).matches;
    }
  }

  ngOnInit(): void {
    this.langSub = this.translate.onLangChange.subscribe(() => this.cdr.markForCheck());
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    this.media = window.matchMedia(MOBILE_MQ);
    this.isMobile = this.media.matches;
    this.media.addEventListener('change', this.onMediaChange);
  }

  ngOnDestroy(): void {
    this.langSub?.unsubscribe();
    this.media?.removeEventListener('change', this.onMediaChange);
    this.unbindVisualViewport();
    this.close();
  }

  writeValue(value: unknown): void {
    this.value = value;
    this.cdr.markForCheck();
  }

  registerOnChange(fn: (value: unknown) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled = isDisabled;
  }

  trackOption(_index: number, opt: SheetSelectOption): string {
    return String(opt.value ?? '');
  }

  get selectedOption(): SheetSelectOption | undefined {
    return this.options.find((opt) => this.compareValues(opt.value, this.value));
  }

  get isSearchable(): boolean {
    if (this.searchable === false) {
      return false;
    }
    if (this.searchable === true) {
      return true;
    }
    return this.options.length > 8;
  }

  get visibleOptions(): SheetSelectOption[] {
    const query = (this.filterQuery || '').trim();
    if (!query) {
      return this.options;
    }
    const matched = this.options.filter((opt) => this.optionMatches(opt, query));
    const seen = new Set(matched.map((opt) => String(opt.value ?? '')));
    const extras: SheetSelectOption[] = [];
    const allOpt = this.options.find((opt) => String(opt.value ?? '') === 'all');
    if (allOpt && !seen.has('all')) {
      extras.push(allOpt);
      seen.add('all');
    }
    const current = this.options.find((opt) => this.compareValues(opt.value, this.value));
    if (current && !seen.has(String(current.value ?? ''))) {
      extras.push(current);
    }
    return extras.length ? [...extras, ...matched] : matched;
  }

  optionLabel(opt: SheetSelectOption): string {
    if (opt.label) {
      return opt.label;
    }
    if (opt.labelKey) {
      const translated = this.translate.instant(opt.labelKey, opt.labelParams);
      if (translated && translated !== opt.labelKey) {
        return translated;
      }
    }
    return String(opt.value ?? '');
  }

  onFilter(query: string): void {
    this.filterQuery = query;
    this.sheetView?.detectChanges();
    this.cdr.markForCheck();
  }

  onSearchInput(event: Event): void {
    this.onFilter((event.target as HTMLInputElement).value);
  }

  private optionMatches(opt: SheetSelectOption, query: string): boolean {
    const hay = foldSearchText(this.optionLabel(opt));
    const needle = foldSearchText(query);
    return fuzzyIncludes(hay, needle);
  }

  markTouched(): void {
    this.onTouched();
  }

  commit(value: unknown): void {
    if (value == null && this.value != null && this.value !== '') {
      return;
    }
    if (this.compareValues(this.value, value)) {
      this.value = value;
      return;
    }
    this.value = value;
    this.onChange(value);
    this.selectionChange.emit(value);
  }

  openSheet(): void {
    if (this.disabled || this.open) {
      return;
    }
    this.filterQuery = '';
    this.open = true;
    this.onTouched();
    this.mountSheet();
    this.bindVisualViewport();
    this.previousBodyOverflow = this.document.body.style.overflow;
    this.document.body.style.overflow = 'hidden';
    setTimeout(() => this.focusSearch(), 40);
  }

  close(): void {
    if (!this.open && !this.sheetView) {
      return;
    }
    this.open = false;
    this.filterQuery = '';
    this.document.body.style.overflow = this.previousBodyOverflow;
    this.unbindVisualViewport();
    this.unmountSheet();
  }

  pick(opt: SheetSelectOption): void {
    this.commit(opt.value);
    this.close();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open) {
      this.close();
    }
  }

  private mountSheet(): void {
    if (this.sheetView || !this.sheetTpl) {
      return;
    }
    this.sheetView = this.sheetTpl.createEmbeddedView({});
    this.appRef.attachView(this.sheetView);
    for (const node of this.sheetView.rootNodes) {
      if (node instanceof Node) {
        this.document.body.appendChild(node);
      }
    }
  }

  private unmountSheet(): void {
    if (!this.sheetView) {
      return;
    }
    this.appRef.detachView(this.sheetView);
    this.sheetView.destroy();
    this.sheetView = undefined;
  }

  private bindVisualViewport(): void {
    if (this.viewportBound || typeof window === 'undefined') {
      return;
    }
    this.viewportBound = true;
    this.applyVisualViewport();
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', this.onVisualViewport);
      vv.addEventListener('scroll', this.onVisualViewport);
    } else {
      window.addEventListener('resize', this.onVisualViewport);
    }
  }

  private unbindVisualViewport(): void {
    if (!this.viewportBound || typeof window === 'undefined') {
      return;
    }
    this.viewportBound = false;
    const vv = window.visualViewport;
    if (vv) {
      vv.removeEventListener('resize', this.onVisualViewport);
      vv.removeEventListener('scroll', this.onVisualViewport);
    } else {
      window.removeEventListener('resize', this.onVisualViewport);
    }
  }

  private applyVisualViewport(): void {
    const top = window.visualViewport?.offsetTop ?? 0;
    const height = window.visualViewport?.height ?? window.innerHeight;
    for (const node of this.sheetView?.rootNodes || []) {
      if (!(node instanceof HTMLElement) || !node.classList.contains('pat-sheet-select-root')) {
        continue;
      }
      node.style.top = `${top}px`;
      node.style.height = `${height}px`;
      node.style.bottom = 'auto';
    }
  }

  private focusSearch(): void {
    if (!this.isSearchable) {
      return;
    }
    for (const node of this.sheetView?.rootNodes || []) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      const input = node.querySelector<HTMLInputElement>('.pat-sheet-select-search-input');
      if (input) {
        input.focus();
        return;
      }
    }
  }
}

function foldSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function fuzzyIncludes(hay: string, needle: string): boolean {
  if (!needle) {
    return true;
  }
  if (hay.includes(needle) || (hay.length >= 4 && needle.includes(hay))) {
    return true;
  }
  const maxDist = needle.length >= 8 ? 2 : needle.length >= 4 ? 1 : 0;
  if (maxDist === 0) {
    return false;
  }
  if (Math.abs(hay.length - needle.length) <= maxDist && levenshtein(hay, needle) <= maxDist) {
    return true;
  }
  if (hay.length > needle.length) {
    for (let i = 0; i <= hay.length - needle.length; i++) {
      if (levenshtein(hay.slice(i, i + needle.length), needle) <= maxDist) {
        return true;
      }
    }
  }
  return false;
}

function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (!a.length) {
    return b.length;
  }
  if (!b.length) {
    return a.length;
  }
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    let prev = i;
    row[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cur = row[j + 1];
      row[j + 1] = a[i] === b[j] ? prev : Math.min(prev, row[j], row[j + 1]) + 1;
      prev = cur;
    }
  }
  return row[b.length];
}

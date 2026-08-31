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
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { TranslateService } from '@ngx-translate/core';

export interface SheetSelectOption {
  value: unknown;
  label?: string;
  labelKey?: string;
  labelParams?: Record<string, unknown>;
  icon?: string;
}

const MOBILE_MQ = '(max-width: 767.98px)';

@Component({
  selector: 'app-sheet-select',
  standalone: true,
  imports: [CommonModule],
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
  searchQuery = '';

  private sheetView?: EmbeddedViewRef<unknown>;
  private media?: MediaQueryList;
  private previousBodyOverflow = '';
  private onChange: (value: unknown) => void = () => {};
  private onTouched: () => void = () => {};

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
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    this.media = window.matchMedia(MOBILE_MQ);
    this.isMobile = this.media.matches;
    this.media.addEventListener('change', this.onMediaChange);
  }

  ngOnDestroy(): void {
    this.media?.removeEventListener('change', this.onMediaChange);
    this.close();
  }

  writeValue(value: unknown): void {
    this.value = value;
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

  get selectedOption(): SheetSelectOption | undefined {
    return this.options.find((opt) => this.isSelected(opt));
  }

  get showSearch(): boolean {
    return this.searchable === true || (this.searchable !== false && this.options.length >= 10);
  }

  get visibleOptions(): SheetSelectOption[] {
    const query = this.searchQuery.trim().toLowerCase();
    if (!query) {
      return this.options;
    }
    return this.options.filter((opt) => this.optionText(opt).toLowerCase().includes(query));
  }

  optionText(opt: SheetSelectOption): string {
    if (opt.label != null && opt.label !== '') {
      return opt.label;
    }
    if (opt.labelKey) {
      return this.translate.instant(opt.labelKey, opt.labelParams);
    }
    return opt.value == null ? '' : String(opt.value);
  }

  isSelected(opt: SheetSelectOption): boolean {
    return Object.is(opt.value, this.value);
  }

  markTouched(): void {
    this.onTouched();
  }

  selectedIndex(): number {
    const index = this.options.findIndex((opt) => this.isSelected(opt));
    return index < 0 ? 0 : index;
  }

  onNativeChange(event: Event): void {
    const index = Number((event.target as HTMLSelectElement).value);
    const opt = this.options[index];
    if (!opt) {
      return;
    }
    this.commit(opt.value);
  }

  onSearchInput(event: Event): void {
    this.searchQuery = (event.target as HTMLInputElement).value;
    this.sheetView?.detectChanges();
  }

  openSheet(): void {
    if (this.disabled || this.open) {
      return;
    }
    this.searchQuery = '';
    this.open = true;
    this.onTouched();
    this.mountSheet();
    this.previousBodyOverflow = this.document.body.style.overflow;
    this.document.body.style.overflow = 'hidden';
    setTimeout(() => this.focusSearch(), 40);
  }

  close(): void {
    if (!this.open && !this.sheetView) {
      return;
    }
    this.open = false;
    this.searchQuery = '';
    this.document.body.style.overflow = this.previousBodyOverflow;
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

  private commit(value: unknown): void {
    this.value = value;
    this.onChange(value);
    this.selectionChange.emit(value);
  }

  private mountSheet(): void {
    if (this.sheetView || !this.sheetTpl) {
      return;
    }
    this.sheetView = this.sheetTpl.createEmbeddedView(null);
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

  private focusSearch(): void {
    if (!this.showSearch) {
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

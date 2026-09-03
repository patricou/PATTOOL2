import {
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnDestroy,
  OnInit,
  Output,
  ViewEncapsulation,
  forwardRef
} from '@angular/core';
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

  value: unknown;

  readonly compareValues = (a: unknown, b: unknown): boolean =>
    String(a ?? '') === String(b ?? '');

  private langSub?: Subscription;
  private onChange: (value: unknown) => void = () => {};
  private onTouched: () => void = () => {};

  constructor(
    private readonly translate: TranslateService,
    private readonly cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.langSub = this.translate.onLangChange.subscribe(() => this.cdr.markForCheck());
  }

  ngOnDestroy(): void {
    this.langSub?.unsubscribe();
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
}

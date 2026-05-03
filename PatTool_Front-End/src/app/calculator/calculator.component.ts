import { Component, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';

type CalcOp = '+' | '-' | '*' | '/';

@Component({
  selector: 'app-calculator',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NavigationButtonsModule],
  templateUrl: './calculator.component.html',
  styleUrls: ['./calculator.component.css']
})
export class CalculatorComponent {
  @ViewChild('tapeScroll') tapeScroll?: ElementRef<HTMLDivElement>;

  /** Chaîne affichée (nombre courant ou résultat). */
  display = '0';

  /** Liste verticale nombre / opérateur / = résultat (visible par défaut). */
  tapeLines: string[] = [];

  /** Détail du calcul : affiché par défaut ; désactiver pour masquer la liste. */
  tapeMode = true;

  private buf = '0';
  private acc: number | null = null;
  private pendingOp: CalcOp | null = null;
  /** Si true, la prochaine touche chiffre remplace `buf`. */
  private fresh = true;

  private static readonly TAPE_MAX_LINES = 220;

  digit(d: string): void {
    if (this.display === 'Error') {
      this.clearAll();
    }
    if (this.fresh) {
      this.buf = d === '.' ? '0.' : d;
      this.fresh = false;
    } else {
      if (d === '.' && this.buf.includes('.')) {
        return;
      }
      if (this.buf === '0' && d !== '.') {
        this.buf = d;
      } else {
        this.buf += d;
      }
    }
    this.display = this.buf;
  }

  operator(op: CalcOp): void {
    if (this.display === 'Error') {
      return;
    }
    const cur = parseFloat(this.buf);
    if (!Number.isFinite(cur)) {
      return;
    }

    const operandLabel = this.fresh ? this.display : this.buf;
    this.tapePush(operandLabel);
    this.tapePush(this.opTapeSymbol(op));

    if (this.acc !== null && this.pendingOp !== null && !this.fresh) {
      const r = this.compute(this.acc, cur, this.pendingOp);
      if (r === null) {
        this.setError();
        return;
      }
      this.acc = r;
      this.display = this.formatForDisplay(this.acc);
    } else {
      this.acc = cur;
      this.display = this.formatForDisplay(this.acc);
    }

    this.pendingOp = op;
    this.fresh = true;
    this.buf = '0';
  }

  equals(): void {
    if (this.display === 'Error' || this.pendingOp === null || this.acc === null) {
      return;
    }
    const cur = parseFloat(this.buf);
    if (!Number.isFinite(cur)) {
      return;
    }
    const r = this.compute(this.acc, cur, this.pendingOp);
    if (r === null) {
      this.setError();
      return;
    }
    this.tapePush(this.buf);
    this.tapePush('=');
    this.tapePush(this.formatForDisplay(r));

    this.acc = null;
    this.pendingOp = null;
    this.buf = this.formatForDisplay(r);
    this.display = this.buf;
    this.fresh = true;
  }

  clearEntry(): void {
    if (this.display === 'Error') {
      this.clearAll();
      return;
    }
    this.buf = '0';
    this.display = '0';
    this.fresh = true;
  }

  clearAll(): void {
    this.display = '0';
    this.buf = '0';
    this.acc = null;
    this.pendingOp = null;
    this.fresh = true;
    this.tapeLines = [];
  }

  backspace(): void {
    if (this.display === 'Error' || this.fresh) {
      return;
    }
    if (this.buf.length <= 1) {
      this.buf = '0';
    } else {
      this.buf = this.buf.slice(0, -1);
    }
    this.display = this.buf;
  }

  toggleSign(): void {
    if (this.display === 'Error') {
      return;
    }
    if (this.buf === '0' || this.buf === '0.') {
      return;
    }
    if (this.buf.startsWith('-')) {
      this.buf = this.buf.slice(1);
    } else {
      this.buf = '-' + this.buf;
    }
    this.display = this.buf;
  }

  percent(): void {
    if (this.display === 'Error') {
      return;
    }
    const cur = parseFloat(this.buf);
    if (!Number.isFinite(cur)) {
      return;
    }
    const r = cur / 100;
    const before = this.buf;
    this.buf = this.formatForDisplay(r);
    this.display = this.buf;
    this.fresh = true;
    this.tapePush(before);
    this.tapePush('%');
    this.tapePush(this.display);
  }

  onKeydown(ev: KeyboardEvent): void {
    const k = ev.key;
    if (/^[0-9]$/.test(k)) {
      ev.preventDefault();
      this.digit(k);
      return;
    }
    if (k === '.' || k === ',') {
      ev.preventDefault();
      this.digit('.');
      return;
    }
    if (k === '+' || k === '-') {
      ev.preventDefault();
      this.operator(k as CalcOp);
      return;
    }
    if (k === '*') {
      ev.preventDefault();
      this.operator('*');
      return;
    }
    if (k === '/') {
      ev.preventDefault();
      ev.stopPropagation();
      this.operator('/');
      return;
    }
    if (k === 'Enter' || k === '=') {
      ev.preventDefault();
      this.equals();
      return;
    }
    if (k === 'Escape') {
      ev.preventDefault();
      this.clearAll();
      return;
    }
    if (k === 'Backspace') {
      ev.preventDefault();
      this.backspace();
    }
  }

  private compute(a: number, b: number, op: CalcOp): number | null {
    switch (op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        if (b === 0) {
          return null;
        }
        return a / b;
      default:
        return b;
    }
  }

  private formatForDisplay(n: number): string {
    if (!Number.isFinite(n)) {
      return 'Error';
    }
    const s = String(n);
    if (s.includes('e') || s.length > 14) {
      return n.toPrecision(10).replace(/\.?0+e/, 'e');
    }
    const rounded = Math.round(n * 1e12) / 1e12;
    let out = String(rounded);
    if (out.includes('e')) {
      out = n.toPrecision(10);
    }
    return out;
  }

  private setError(): void {
    this.display = 'Error';
    this.buf = '0';
    this.acc = null;
    this.pendingOp = null;
    this.fresh = true;
    this.tapePush('Error');
  }

  private opTapeSymbol(op: CalcOp): string {
    switch (op) {
      case '+':
        return '+';
      case '-':
        return '−';
      case '*':
        return '×';
      case '/':
        return '÷';
      default:
        return String(op);
    }
  }

  private tapePush(line: string): void {
    const t = typeof line === 'string' ? line.trim() : '';
    if (t === '') {
      return;
    }
    this.tapeLines = [...this.tapeLines, t];
    const max = CalculatorComponent.TAPE_MAX_LINES;
    if (this.tapeLines.length > max) {
      this.tapeLines = this.tapeLines.slice(-max);
    }
    queueMicrotask(() => this.scrollTapeToBottom());
  }

  private scrollTapeToBottom(): void {
    const el = this.tapeScroll?.nativeElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }
}

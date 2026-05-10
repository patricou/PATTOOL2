import { AfterViewInit, Component, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';

type CalcOp = '+' | '-' | '*' | '/' | '^' | 'mod';
type SciUnaryKind =
  | 'sqrt'
  | 'square'
  | 'cube'
  | 'cbrt'
  | 'inv'
  | 'sin'
  | 'cos'
  | 'tan'
  | 'asin'
  | 'acos'
  | 'atan'
  | 'sinh'
  | 'cosh'
  | 'tanh'
  | 'log10'
  | 'ln'
  | 'log2'
  | 'exp'
  | 'exp10'
  | 'abs'
  | 'fact';

@Component({
  selector: 'app-calculator',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NavigationButtonsModule],
  templateUrl: './calculator.component.html',
  styleUrls: ['./calculator.component.css']
})
export class CalculatorComponent implements AfterViewInit {
  @ViewChild('tapeScroll') tapeScroll?: ElementRef<HTMLDivElement>;
  @ViewChild('calcPanel') calcPanel?: ElementRef<HTMLElement>;

  /** Chaîne affichée (nombre courant ou résultat). */
  display = '0';

  /** Liste verticale nombre / opérateur / = résultat (visible par défaut). */
  tapeLines: string[] = [];

  /** Détail du calcul : affiché par défaut ; désactiver pour masquer la liste. */
  tapeMode = true;

  /** Mode scientifique : panneau de fonctions avancées. */
  scientificMode = false;

  /** Sin / cos / tan : entrée en degrés si true, en radians si false. Même logique pour le résultat des arcs. */
  sciUseDegrees = true;

  private buf = '0';
  private acc: number | null = null;
  private pendingOp: CalcOp | null = null;
  /** Si true, la prochaine touche chiffre remplace `buf`. */
  private fresh = true;

  private static readonly TAPE_MAX_LINES = 220;

  ngAfterViewInit(): void {
    this.refocusKeyboardPanel();
  }

  /** Reprend le focus sur le panneau (bandeau calcul / affichage) pour saisir au clavier. */
  refocusKeyboardPanel(): void {
    const el = this.calcPanel?.nativeElement;
    el?.focus({ preventScroll: true });
  }

  /**
   * Chiffre depuis la touche physique (Digit0–9, Numpad0–9) pour les claviers où `key` n’est pas un chiffre (ex. AZERTY).
   */
  private digitFromPhysicalKey(ev: KeyboardEvent): string | null {
    const { code, key } = ev;
    // AZERTY : la touche « 6 » produit « - » sans Shift ; le moins doit rester une opération.
    if (code === 'Digit6' && key === '-') {
      return null;
    }
    if (code.startsWith('Digit') && code.length === 6) {
      return code.slice(5);
    }
    if (code.startsWith('Numpad') && code.length === 7) {
      const d = code.slice(6);
      if (/^[0-9]$/.test(d)) {
        return d;
      }
    }
    return null;
  }

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
    if (this.display === 'Error') {
      return;
    }
    // Après un opérateur : on attend un nouveau nombre (buf encore à « 0 ») — ne pas effacer l’accumulateur affiché.
    if (this.pendingOp !== null && this.fresh && this.buf === '0') {
      return;
    }
    if (this.buf.length <= 1) {
      this.buf = '0';
      this.fresh = true;
    } else {
      this.buf = this.buf.slice(0, -1);
      if (this.buf === '-') {
        this.buf = '0';
        this.fresh = true;
      } else {
        this.fresh = this.buf === '0';
      }
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

  insertConstant(which: 'pi' | 'e'): void {
    if (this.display === 'Error') {
      this.clearAll();
      return;
    }
    const val = which === 'pi' ? Math.PI : Math.E;
    const lbl = which === 'pi' ? 'π' : 'e';
    const s = this.formatForDisplay(val);
    if (this.tapeMode) {
      this.tapePush(lbl);
      this.tapePush(s);
    }
    this.buf = s;
    this.display = this.buf;
    this.fresh = true;
  }

  scientificUnary(kind: SciUnaryKind): void {
    if (this.display === 'Error') {
      return;
    }
    const beforeShown = (
      !this.fresh ? this.buf : String(this.display).trim()
    ).replace(',', '.');
    const x = parseFloat(beforeShown);
    if (!Number.isFinite(x)) {
      return;
    }

    let r: number | null = null;

    switch (kind) {
      case 'sqrt':
        r = x < 0 ? null : Math.sqrt(x);
        break;
      case 'square':
        r = x * x;
        break;
      case 'cube':
        r = x * x * x;
        break;
      case 'cbrt':
        r = Math.cbrt(x);
        break;
      case 'inv':
        r = x === 0 ? null : 1 / x;
        break;
      case 'sin': {
        const rad = this.sciUseDegrees ? (x * Math.PI) / 180 : x;
        r = Math.sin(rad);
        break;
      }
      case 'cos': {
        const rad = this.sciUseDegrees ? (x * Math.PI) / 180 : x;
        r = Math.cos(rad);
        break;
      }
      case 'tan': {
        const rad = this.sciUseDegrees ? (x * Math.PI) / 180 : x;
        const cos = Math.cos(rad);
        r = Math.abs(cos) < 1e-15 ? null : Math.tan(rad);
        break;
      }
      case 'asin': {
        if (x < -1 || x > 1) {
          r = null;
          break;
        }
        let v = Math.asin(x);
        if (this.sciUseDegrees) {
          v = (v * 180) / Math.PI;
        }
        r = v;
        break;
      }
      case 'acos': {
        if (x < -1 || x > 1) {
          r = null;
          break;
        }
        let v = Math.acos(x);
        if (this.sciUseDegrees) {
          v = (v * 180) / Math.PI;
        }
        r = v;
        break;
      }
      case 'atan': {
        let v = Math.atan(x);
        if (this.sciUseDegrees) {
          v = (v * 180) / Math.PI;
        }
        r = v;
        break;
      }
      case 'sinh':
        r = Math.sinh(x);
        break;
      case 'cosh':
        r = Math.cosh(x);
        break;
      case 'tanh':
        r = Math.tanh(x);
        break;
      case 'log10':
        r = x <= 0 ? null : Math.log10(x);
        break;
      case 'ln':
        r = x <= 0 ? null : Math.log(x);
        break;
      case 'log2':
        r = x <= 0 ? null : Math.log2(x);
        break;
      case 'exp':
        r = Math.exp(x);
        break;
      case 'exp10':
        r = Math.pow(10, x);
        break;
      case 'abs':
        r = Math.abs(x);
        break;
      case 'fact':
        r = this.factorialInt(x);
        break;
      default:
        return;
    }

    if (r === null || !Number.isFinite(r)) {
      this.setError();
      return;
    }
    const out = this.formatForDisplay(r);

    if (this.tapeMode) {
      this.tapePush(this.sciUnaryTapeExpr(kind, beforeShown));
      this.tapePush('=');
      this.tapePush(out);
    }

    this.acc = null;
    this.pendingOp = null;
    this.buf = out;
    this.display = this.buf;
    this.fresh = true;
  }

  private factorialInt(x: number): number | null {
    if (!Number.isFinite(x)) {
      return null;
    }
    const n = Math.round(x);
    if (Math.abs(x - n) > 1e-9 || n < 0 || n > 170) {
      return null;
    }
    if (n === 0 || n === 1) {
      return 1;
    }
    let p = 1;
    for (let i = 2; i <= n; i++) {
      p *= i;
      if (!Number.isFinite(p)) {
        return null;
      }
    }
    return p;
  }

  private sciUnaryTapeExpr(kind: SciUnaryKind, before: string): string {
    const deg = this.sciUseDegrees;
    const trigIn = deg ? '°' : ' rad';
    switch (kind) {
      case 'sqrt':
        return '√(' + before + ')';
      case 'square':
        return '(' + before + ')²';
      case 'cube':
        return '(' + before + ')³';
      case 'cbrt':
        return '∛(' + before + ')';
      case 'inv':
        return '1÷(' + before + ')';
      case 'sin':
        return 'sin(' + before + trigIn + ')';
      case 'cos':
        return 'cos(' + before + trigIn + ')';
      case 'tan':
        return 'tan(' + before + trigIn + ')';
      case 'asin':
        return 'asin(' + before + ')' + (deg ? ' → °' : ' → rad');
      case 'acos':
        return 'acos(' + before + ')' + (deg ? ' → °' : ' → rad');
      case 'atan':
        return 'atan(' + before + ')' + (deg ? ' → °' : ' → rad');
      case 'sinh':
        return 'sinh(' + before + ')';
      case 'cosh':
        return 'cosh(' + before + ')';
      case 'tanh':
        return 'tanh(' + before + ')';
      case 'log10':
        return 'log(' + before + ')';
      case 'ln':
        return 'ln(' + before + ')';
      case 'log2':
        return 'log₂(' + before + ')';
      case 'exp':
        return 'exp(' + before + ')';
      case 'exp10':
        return '10^(' + before + ')';
      case 'abs':
        return '|' + before + '|';
      case 'fact':
        return '(' + before + ')!';
      default:
        return String(kind);
    }
  }

  onKeydown(ev: KeyboardEvent): void {
    const k = ev.key;
    if (/^[0-9]$/.test(k)) {
      ev.preventDefault();
      this.digit(k);
      return;
    }
    const physicalDigit = this.digitFromPhysicalKey(ev);
    if (physicalDigit !== null) {
      ev.preventDefault();
      this.digit(physicalDigit);
      return;
    }
    if (k === '.' || k === ',' || ev.code === 'NumpadDecimal') {
      ev.preventDefault();
      this.digit('.');
      return;
    }
    if (k === '+' || k === '-' || ev.code === 'NumpadAdd' || ev.code === 'NumpadSubtract') {
      ev.preventDefault();
      const op: CalcOp =
        k === '+' || ev.code === 'NumpadAdd' ? '+' : '-';
      this.operator(op);
      return;
    }
    if (k === '*' || ev.code === 'NumpadMultiply') {
      ev.preventDefault();
      this.operator('*');
      return;
    }
    if (k === '/' || ev.code === 'NumpadDivide') {
      ev.preventDefault();
      ev.stopPropagation();
      this.operator('/');
      return;
    }
    if (this.scientificMode && k === '^') {
      ev.preventDefault();
      this.operator('^');
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
    if (k === 'Backspace' || ev.code === 'NumpadBackspace') {
      ev.preventDefault();
      this.backspace();
      return;
    }
    if (k === 'Delete') {
      ev.preventDefault();
      this.clearEntry();
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
      case '^': {
        const r = Math.pow(a, b);
        return Number.isFinite(r) ? r : null;
      }
      case 'mod':
        if (b === 0) {
          return null;
        }
        return ((a % b) + b) % b;
      default:
        return null;
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
      case '^':
        return '^';
      case 'mod':
        return 'mod';
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

import { AfterViewInit, Component, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { BaseChartDirective } from 'ng2-charts';
import { Chart, ChartConfiguration, ChartOptions, registerables } from 'chart.js';
import { compile } from 'mathjs';

Chart.register(...registerables);

/** Préréglage formule + bornes de graphe + x pour évaluation ponctuelle. */
interface FormulaPreset {
  readonly expr: string;
  readonly labelKey: string;
  readonly plotXMin: number;
  readonly plotXMax: number;
  readonly formulaEvalX: number;
}

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
  imports: [CommonModule, FormsModule, TranslateModule, BaseChartDirective],
  templateUrl: './calculator.component.html',
  styleUrls: ['./calculator.component.css']
})
export class CalculatorComponent implements AfterViewInit {
  @ViewChild('tapeScroll') tapeScroll?: ElementRef<HTMLDivElement>;
  @ViewChild('calcPanel') calcPanel?: ElementRef<HTMLElement>;
  @ViewChild(BaseChartDirective) formulaChart?: BaseChartDirective;

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

  /** Mode formule f(x) + tracé de courbe (mathjs). */
  formulaMode = false;

  /** Expression avec variable libre `x` (ex. sin(x), x^2 + 3*x - 1, sqrt(abs(x))). */
  formulaExpr = 'sin(x)';

  /** Évaluation ponctuelle : abscisse pour « Calculer f(x) ». */
  formulaEvalX = 0;

  /** Résultat numérique ou chaîne vide. */
  formulaScalarResult = '';

  /** Message d’erreur de syntaxe ou de domaine. */
  formulaError = '';

  /** Bornes du graphe. */
  plotXMin = -6.28;
  plotXMax = 6.28;

  /** Nombre d’échantillons (approximation de la courbe). */
  plotSamples = 180;

  /** Boutons d’exemples : expr mathjs valides (variable x). */
  readonly formulaPresets: readonly FormulaPreset[] = [
    {
      expr: 'sin(x)',
      labelKey: 'CALCULATOR.FORMULA_PRESET_SIN',
      plotXMin: -6.28,
      plotXMax: 6.28,
      formulaEvalX: 1
    },
    {
      expr: 'cos(x)',
      labelKey: 'CALCULATOR.FORMULA_PRESET_COS',
      plotXMin: -6.28,
      plotXMax: 6.28,
      formulaEvalX: 0
    },
    {
      expr: 'tan(x)',
      labelKey: 'CALCULATOR.FORMULA_PRESET_TAN',
      plotXMin: -1.3,
      plotXMax: 1.3,
      formulaEvalX: 0.5
    },
    {
      expr: 'x^2',
      labelKey: 'CALCULATOR.FORMULA_PRESET_SQ',
      plotXMin: -5,
      plotXMax: 5,
      formulaEvalX: 2
    },
    {
      expr: 'x^3 - x',
      labelKey: 'CALCULATOR.FORMULA_PRESET_CUBE_POLY',
      plotXMin: -2,
      plotXMax: 2,
      formulaEvalX: 1
    },
    {
      expr: 'exp(-x^2)',
      labelKey: 'CALCULATOR.FORMULA_PRESET_GAUSS',
      plotXMin: -4,
      plotXMax: 4,
      formulaEvalX: 0
    },
    {
      expr: 'sqrt(abs(x))',
      labelKey: 'CALCULATOR.FORMULA_PRESET_SQRT_ABS',
      plotXMin: -6,
      plotXMax: 6,
      formulaEvalX: 4
    },
    {
      expr: 'exp(x)',
      labelKey: 'CALCULATOR.FORMULA_PRESET_EXP',
      plotXMin: -3,
      plotXMax: 3,
      formulaEvalX: 1
    },
    {
      expr: 'ln(x)',
      labelKey: 'CALCULATOR.FORMULA_PRESET_LN',
      plotXMin: 0.05,
      plotXMax: 10,
      formulaEvalX: 2
    }
  ];

  chartType: 'line' = 'line';
  chartData: ChartConfiguration<'line'>['data'] = { datasets: [] };
  chartOptions: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'nearest', intersect: false, axis: 'x' },
    plugins: {
      legend: {
        display: true,
        position: 'top',
        labels: { color: '#cbd5e1', boxWidth: 12 }
      },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const pt = ctx.raw as { x: number; y: number };
            if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number') {
              return '';
            }
            return `x=${pt.x.toPrecision(6)}, f(x)=${pt.y.toPrecision(6)}`;
          }
        }
      }
    },
    scales: {
      x: {
        type: 'linear',
        title: { display: true, text: 'x', color: '#94a3b8' },
        ticks: { color: '#94a3b8' },
        grid: { color: 'rgba(148, 163, 184, 0.15)' }
      },
      y: {
        title: { display: true, text: 'f(x)', color: '#94a3b8' },
        ticks: { color: '#94a3b8' },
        grid: { color: 'rgba(148, 163, 184, 0.15)' }
      }
    }
  };

  private buf = '0';
  private acc: number | null = null;
  private pendingOp: CalcOp | null = null;
  /** Si true, la prochaine touche chiffre remplace `buf`. */
  private fresh = true;

  private static readonly TAPE_MAX_LINES = 220;

  ngAfterViewInit(): void {
    this.refocusKeyboardPanel();
  }

  /** Valeur réelle finie ; rejette complexes hors axe réel. */
  private static toFiniteReal(value: unknown): number | null {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (value && typeof value === 'object' && 're' in value) {
      const re = (value as { re: unknown }).re;
      const im = (value as { im?: unknown }).im;
      if (typeof re !== 'number') {
        return null;
      }
      if (typeof im === 'number' && Math.abs(im) > 1e-9) {
        return null;
      }
      return Number.isFinite(re) ? re : null;
    }
    return null;
  }

  /** Calcule f(formulaEvalX) ; les trigonométriques suivent les radians (voir libellé i18n). */
  evaluateFormulaScalar(): void {
    this.formulaError = '';
    this.formulaScalarResult = '';
    const expr = this.formulaExpr.trim();
    if (!expr) {
      this.formulaError = 'CALCULATOR.FORMULA_ERR_EMPTY';
      return;
    }
    try {
      const code = compile(expr);
      const raw = code.evaluate({ x: this.formulaEvalX });
      const y = CalculatorComponent.toFiniteReal(raw);
      if (y === null) {
        this.formulaError = 'CALCULATOR.FORMULA_ERR_NONREAL';
        return;
      }
      this.formulaScalarResult = this.formatForDisplay(y);
      if (this.tapeMode) {
        this.tapePush(`f(${this.formulaEvalX})`);
        this.tapePush('=');
        this.tapePush(this.formulaScalarResult);
      }
    } catch {
      this.formulaError = 'CALCULATOR.FORMULA_ERR_SYNTAX';
    }
  }

  /** Échantillonne y = f(x) sur [plotXMin, plotXMax] et met à jour le graphique. */
  plotFormulaCurve(): void {
    this.formulaError = '';
    const expr = this.formulaExpr.trim();
    if (!expr) {
      this.formulaError = 'CALCULATOR.FORMULA_ERR_EMPTY';
      return;
    }
    const xmin = Number(this.plotXMin);
    const xmax = Number(this.plotXMax);
    if (!Number.isFinite(xmin) || !Number.isFinite(xmax) || xmax <= xmin) {
      this.formulaError = 'CALCULATOR.FORMULA_ERR_RANGE';
      return;
    }
    let code;
    try {
      code = compile(expr);
    } catch {
      this.formulaError = 'CALCULATOR.FORMULA_ERR_SYNTAX';
      return;
    }
    const cap = 450;
    const n = Math.min(cap, Math.max(48, Math.round(this.plotSamples)));
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= n; i++) {
      const x = xmin + ((xmax - xmin) * i) / n;
      try {
        const raw = code.evaluate({ x });
        const y = CalculatorComponent.toFiniteReal(raw);
        if (y !== null) {
          pts.push({ x, y });
        }
      } catch {
        /* point hors domaine : on saute */
      }
    }
    if (pts.length === 0) {
      this.formulaError = 'CALCULATOR.FORMULA_ERR_NOPOINTS';
      this.chartData = { datasets: [] };
      queueMicrotask(() => this.formulaChart?.update());
      return;
    }
    const label =
      expr.length > 42 ? expr.slice(0, 39).trimEnd() + '…' : expr;
    this.chartData = {
      datasets: [
        {
          label,
          data: pts,
          parsing: false,
          borderColor: '#2dd4bf',
          backgroundColor: 'rgba(45, 212, 191, 0.08)',
          tension: 0.12,
          spanGaps: false,
          pointRadius: 0,
          borderWidth: 2
        }
      ]
    };
    queueMicrotask(() => this.formulaChart?.update());
  }

  /** Applique un exemple (expression + fenêtre x + trace auto). */
  applyFormulaPreset(p: FormulaPreset): void {
    this.formulaExpr = p.expr;
    this.plotXMin = p.plotXMin;
    this.plotXMax = p.plotXMax;
    this.formulaEvalX = p.formulaEvalX;
    this.formulaError = '';
    this.formulaScalarResult = '';
    queueMicrotask(() => this.plotFormulaCurve());
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
    const tgt = ev.target as HTMLElement | null;
    if (tgt?.closest('.calculator-formula-panel')) {
      return;
    }
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

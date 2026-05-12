import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { BaseChartDirective } from 'ng2-charts';
import { Chart, ChartConfiguration, ChartOptions, registerables } from 'chart.js';
import { compile, type EvalFunction } from 'mathjs';

Chart.register(...registerables);

/** Préréglage formule + bornes de graphe + x pour évaluation ponctuelle. */
interface FormulaPreset {
  readonly expr: string;
  readonly labelKey: string;
  readonly plotXMin: number;
  readonly plotXMax: number;
  readonly formulaEvalX: number;
}

/** Pastille plein écran : insertion dans l’expression (mathjs). */
interface FormulaMathChip {
  readonly expr: string;
  readonly label: string;
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
export class CalculatorComponent implements AfterViewInit, OnDestroy {
  constructor(private readonly translate: TranslateService) {}

  @ViewChild('tapeScroll') tapeScroll?: ElementRef<HTMLDivElement>;
  @ViewChild('calcPanel') calcPanel?: ElementRef<HTMLElement>;
  @ViewChild('formulaChartHost') formulaChartHost?: ElementRef<HTMLElement>;
  @ViewChild('formulaExprMain') formulaExprMain?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('formulaExprFs') formulaExprFs?: ElementRef<HTMLTextAreaElement>;
  @ViewChild(BaseChartDirective) formulaChart?: BaseChartDirective;

  /** Plein écran natif pour la zone du graphique f(x). */
  formulaChartFullscreen = false;

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

  /** Intégrale définie ∫ₐᵇ f(x) dx (méthode de Simpson, nombre pair de sous-intervalles). */
  formulaIntegralA = 0;
  formulaIntegralB = 1;
  /** Nombre de sous-intervalles sur [a, b] ; doit être pair (≥ 4), ajusté automatiquement si besoin. */
  formulaIntegralPanels = 256;
  formulaIntegralResult = '';

  /** Message d’erreur de syntaxe ou de domaine. */
  formulaError = '';

  /** Bornes du graphe. */
  plotXMin = -6.28;
  plotXMax = 6.28;

  /** Nombre d’échantillons (approximation de la courbe). */
  plotSamples = 180;

  /** Si true, trace aussi ∫ depuis x min jusqu’à x (trapèzes sur la grille). */
  formulaPlotIntegralCurve = false;

  /** Texte sous le graphe : fonction représentée par la courbe ∫ cumulée (vide sinon). */
  formulaIntegralCurveCaption = '';

  /** Pastilles « fonctions » en bas du graphe plein écran (tap = insertion au curseur). */
  readonly formulaFullscreenMathChips: readonly FormulaMathChip[] = [
    { expr: 'x', label: 'x' },
    { expr: 'pi', label: 'π' },
    { expr: 'e', label: 'e' },
    { expr: '(', label: '(' },
    { expr: ')', label: ')' },
    { expr: '+', label: '+' },
    { expr: '-', label: '−' },
    { expr: '*', label: '×' },
    { expr: '/', label: '/' },
    { expr: '^', label: '^' },
    { expr: ',', label: ',' },
    { expr: '0', label: '0' },
    { expr: '1', label: '1' },
    { expr: '2', label: '2' },
    { expr: '3', label: '3' },
    { expr: '4', label: '4' },
    { expr: '5', label: '5' },
    { expr: '6', label: '6' },
    { expr: '7', label: '7' },
    { expr: '8', label: '8' },
    { expr: '9', label: '9' },
    { expr: '.', label: '.' },
    { expr: 'sin(x)', label: 'sin' },
    { expr: 'cos(x)', label: 'cos' },
    { expr: 'tan(x)', label: 'tan' },
    { expr: '1/tan(x)', label: 'cot' },
    { expr: '1/cos(x)', label: 'sec' },
    { expr: '1/sin(x)', label: 'csc' },
    { expr: 'asin(x)', label: 'asin' },
    { expr: 'acos(x)', label: 'acos' },
    { expr: 'atan(x)', label: 'atan' },
    { expr: 'sinh(x)', label: 'sinh' },
    { expr: 'cosh(x)', label: 'cosh' },
    { expr: 'tanh(x)', label: 'tanh' },
    { expr: 'asinh(x)', label: 'asinh' },
    { expr: 'acosh(x)', label: 'acosh' },
    { expr: 'atanh(x)', label: 'atanh' },
    { expr: 'exp(x)', label: 'exp' },
    { expr: 'exp(-x)', label: 'e⁻ˣ' },
    { expr: 'exp(-x^2)', label: 'e⁻ˣ²' },
    { expr: 'log(x)', label: 'ln' },
    { expr: 'log10(x)', label: 'log₁₀' },
    { expr: 'log2(x)', label: 'log₂' },
    { expr: 'log(x, 3)', label: 'log₃' },
    { expr: 'sqrt(x)', label: '√' },
    { expr: 'sqrt(abs(x))', label: '√|x|' },
    { expr: 'cbrt(x)', label: '∛' },
    { expr: 'abs(x)', label: '|x|' },
    { expr: 'sign(x)', label: 'sign' },
    { expr: 'floor(x)', label: '⌊x⌋' },
    { expr: 'ceil(x)', label: '⌈x⌉' },
    { expr: 'round(x)', label: 'rnd' },
    { expr: 'x^2', label: 'x²' },
    { expr: 'x^3', label: 'x³' },
    { expr: 'x^4', label: 'x⁴' },
    { expr: '1/x', label: '1/x' },
    { expr: 'x^2 + 1', label: 'x²+1' },
    { expr: 'x^3 - x', label: 'x³−x' },
    { expr: '2^x', label: '2ˣ' },
    { expr: '10^x', label: '10ˣ' },
    { expr: 'mod(x, 1)', label: '{x}' },
    { expr: 'log(x^2 + 1)', label: 'ln(x²+1)' },
    { expr: 'sqrt(x^2 + 1)', label: '√(x²+1)' },
    { expr: 'sin(x)*cos(x)', label: 'sin·cos' },
    { expr: 'sin(x)^2', label: 'sin²' },
    { expr: 'cos(x)^2', label: 'cos²' },
    { expr: 'max(x, 0)', label: 'max(x,0)' },
    { expr: 'min(x, 1)', label: 'min(x,1)' },
    { expr: 'hypot(x, 1)', label: 'hypot' },
    { expr: 'nthRoot(x, 3)', label: '³√·' },
    { expr: 'gcd(round(x), 6)', label: 'gcd' },
    { expr: 'combinations(round(abs(x)), 2)', label: 'C(n,2)' },
    { expr: 'factorial(min(round(abs(x)), 12))', label: 'n!' },
    { expr: 'gamma(x + 1)', label: 'Γ' },
    { expr: 'erf(x)', label: 'erf' },
    { expr: 'sin(pi * x)', label: 'sin(πx)' },
    { expr: 'cos(2*pi*x)', label: 'cos(2πx)' },
    { expr: 'sinc(x)', label: 'sinc' },
    { expr: 'x * exp(-x)', label: 'xe⁻ˣ' },
    { expr: '(x^2 - 1)/(x^2 + 1)', label: 'rats' },
    { expr: 'atan(1/x)', label: 'atan(1/x)' },
    { expr: 'sqrt(1 - x^2)', label: '√(1−x²)' },
    { expr: 'log(abs(x) + 1)', label: 'ln(|x|+1)' },
    { expr: 'x * log(abs(x) + 1)', label: 'x·ln(|x|+1)' },
    { expr: 'x*sin(x)', label: 'x·sin' },
    { expr: 'x*cos(x)', label: 'x·cos' },
    { expr: 'exp(x)/(1 + exp(x))', label: 'σ(x)' },
    { expr: 'abs(x - 1)', label: '|x−1|' },
    { expr: 'square(x)', label: 'square' },
    { expr: 'cube(x)', label: 'cube' },
    { expr: 'pow(x, 5)', label: 'x⁵' },
    { expr: 'norm([-2, x, 3])', label: '‖·‖' },
    { expr: 'distance([x, 0], [0, 1])', label: 'dist' }
  ];

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
      expr: 'log(x)',
      labelKey: 'CALCULATOR.FORMULA_PRESET_LN',
      plotXMin: 0.05,
      plotXMax: 10,
      formulaEvalX: 2
    },
    {
      expr: 'log10(x)',
      labelKey: 'CALCULATOR.FORMULA_PRESET_LOG10',
      plotXMin: 0.05,
      plotXMax: 12,
      formulaEvalX: 100
    },
    {
      expr: 'log2(x)',
      labelKey: 'CALCULATOR.FORMULA_PRESET_LOG2',
      plotXMin: 0.05,
      plotXMax: 16,
      formulaEvalX: 8
    },
    {
      expr: 'log(x, 5)',
      labelKey: 'CALCULATOR.FORMULA_PRESET_LOG_BASE',
      plotXMin: 0.05,
      plotXMax: 30,
      formulaEvalX: 25
    },
    {
      expr: 'log(x^2 + 1)',
      labelKey: 'CALCULATOR.FORMULA_PRESET_LOG_NAT_POLY',
      plotXMin: -6,
      plotXMax: 6,
      formulaEvalX: 2
    },
    {
      expr: 'log(x + 1)',
      labelKey: 'CALCULATOR.FORMULA_PRESET_LOG_NAT_SHIFT',
      plotXMin: -0.9,
      plotXMax: 10,
      formulaEvalX: 3
    },
    {
      expr: 'x^2 / 2',
      labelKey: 'CALCULATOR.FORMULA_PRESET_INT_X',
      plotXMin: -4,
      plotXMax: 4,
      formulaEvalX: 2
    },
    {
      expr: '-cos(x)',
      labelKey: 'CALCULATOR.FORMULA_PRESET_INT_SIN',
      plotXMin: -6.28,
      plotXMax: 6.28,
      formulaEvalX: 1
    },
    {
      expr: 'sin(x)',
      labelKey: 'CALCULATOR.FORMULA_PRESET_INT_COS',
      plotXMin: -6.28,
      plotXMax: 6.28,
      formulaEvalX: 1
    },
    {
      expr: 'exp(x)',
      labelKey: 'CALCULATOR.FORMULA_PRESET_INT_EXP',
      plotXMin: -3,
      plotXMax: 3,
      formulaEvalX: 1
    },
    {
      expr: 'atan(x)',
      labelKey: 'CALCULATOR.FORMULA_PRESET_INT_ARCTAN',
      plotXMin: -6,
      plotXMax: 6,
      formulaEvalX: 1
    },
    {
      expr: 'x * log(x) - x',
      labelKey: 'CALCULATOR.FORMULA_PRESET_INT_LOGX',
      plotXMin: 0.05,
      plotXMax: 8,
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

  /** Pastilles insérées telles quelles au curseur (pas de composition avec la formule affichée). */
  private static readonly FORMULA_CHIP_ATOMIC_EXPR = new Set([
    'x',
    'pi',
    'e',
    '(',
    ')',
    '+',
    '-',
    '*',
    '/',
    '^',
    ',',
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    '.'
  ]);

  private static formulaChipIsAtomic(chipExpr: string): boolean {
    return CalculatorComponent.FORMULA_CHIP_ATOMIC_EXPR.has(chipExpr);
  }

  ngAfterViewInit(): void {
    this.refocusKeyboardPanel();
  }

  ngOnDestroy(): void {
    void this.exitFormulaChartFullscreenIfActive();
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  @HostListener('document:mozfullscreenchange')
  onDocumentFullscreenChange(): void {
    this.syncFormulaChartFullscreenState();
  }

  /** Quitte le plein écran du graphe si le mode formule est désactivé (évite un état incohérent). */
  onFormulaModeChange(enabled: boolean): void {
    if (!enabled) {
      void this.exitFormulaChartFullscreenIfActive();
    }
  }

  toggleFormulaChartFullscreen(): void {
    const host = this.formulaChartHost?.nativeElement;
    if (!host) {
      return;
    }
    if (CalculatorComponent.getFullscreenElement() === host) {
      void CalculatorComponent.exitFullscreenDocument().then(() =>
        this.refreshFormulaChartLayout()
      );
    } else {
      void CalculatorComponent.requestFullscreenElement(host)
        .then(() => this.refreshFormulaChartLayout())
        .catch(() => {
          /* navigateur ou politique refuse le plein écran */
        });
    }
  }

  private syncFormulaChartFullscreenState(): void {
    const host = this.formulaChartHost?.nativeElement;
    this.formulaChartFullscreen =
      !!host && CalculatorComponent.getFullscreenElement() === host;
    this.refreshFormulaChartLayout();
  }

  private refreshFormulaChartLayout(): void {
    queueMicrotask(() => {
      this.formulaChart?.chart?.resize();
      this.formulaChart?.update();
    });
  }

  private exitFormulaChartFullscreenIfActive(): Promise<void> {
    const host = this.formulaChartHost?.nativeElement;
    if (!host || CalculatorComponent.getFullscreenElement() !== host) {
      return Promise.resolve();
    }
    return CalculatorComponent.exitFullscreenDocument().then(() =>
      this.refreshFormulaChartLayout()
    );
  }

  private static getFullscreenElement(): Element | null {
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      mozFullScreenElement?: Element | null;
    };
    return (
      doc.fullscreenElement ??
      doc.webkitFullscreenElement ??
      doc.mozFullScreenElement ??
      null
    );
  }

  private static requestFullscreenElement(el: HTMLElement): Promise<void> {
    const anyEl = el as HTMLElement & {
      webkitRequestFullscreen?: () => void;
      mozRequestFullScreen?: () => void;
    };
    if (typeof el.requestFullscreen === 'function') {
      return el.requestFullscreen();
    }
    if (typeof anyEl.webkitRequestFullscreen === 'function') {
      anyEl.webkitRequestFullscreen();
      return Promise.resolve();
    }
    if (typeof anyEl.mozRequestFullScreen === 'function') {
      anyEl.mozRequestFullScreen();
      return Promise.resolve();
    }
    return Promise.reject(new Error('fullscreen unsupported'));
  }

  private static exitFullscreenDocument(): Promise<void> {
    const doc = document as Document & {
      webkitExitFullscreen?: () => void;
      mozCancelFullScreen?: () => void;
    };
    if (typeof document.exitFullscreen === 'function') {
      return document.exitFullscreen();
    }
    if (typeof doc.webkitExitFullscreen === 'function') {
      doc.webkitExitFullscreen();
      return Promise.resolve();
    }
    if (typeof doc.mozCancelFullScreen === 'function') {
      doc.mozCancelFullScreen();
      return Promise.resolve();
    }
    return Promise.resolve();
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

  /** Évalue une expression compilée en x ; null si non réel ou hors domaine. */
  private static evaluateCompiledAt(code: EvalFunction, x: number): number | null {
    try {
      return CalculatorComponent.toFiniteReal(code.evaluate({ x }));
    } catch {
      return null;
    }
  }

  /**
   * ∫_{segment}^x f approximée par trapèzes sur la même grille que la courbe ;
   * si f est indéfinie sur un pas, la cumul redémarre à 0 au prochain segment valide.
   */
  private static cumulativeIntegralUniformTrapezoid(
    code: EvalFunction,
    xmin: number,
    xmax: number,
    n: number
  ): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    let acc = 0;
    let prevX: number | null = null;
    let prevY: number | null = null;
    for (let i = 0; i <= n; i++) {
      const x = xmin + ((xmax - xmin) * i) / n;
      const y = CalculatorComponent.evaluateCompiledAt(code, x);
      if (y === null) {
        prevX = null;
        prevY = null;
        acc = 0;
        continue;
      }
      if (prevX === null || prevY === null) {
        out.push({ x, y: 0 });
        prevX = x;
        prevY = y;
        continue;
      }
      acc += ((x - prevX) * (prevY + y)) / 2;
      out.push({ x, y: acc });
      prevX = x;
      prevY = y;
    }
    return out;
  }

  /** Configure axe(s) Y et infobulle selon présence de la courbe ∫ f. */
  private configureFormulaChartScales(integralCurveActive: boolean): void {
    const tickMain = '#94a3b8';
    const gridMain = 'rgba(148, 163, 184, 0.15)';
    const scaleX = {
      type: 'linear' as const,
      title: { display: true, text: 'x', color: tickMain },
      ticks: { color: tickMain },
      grid: { color: gridMain }
    };
    const scaleY = {
      type: 'linear' as const,
      position: 'left' as const,
      title: { display: true, text: 'f(x)', color: tickMain },
      ticks: { color: tickMain },
      grid: { color: gridMain }
    };
    if (integralCurveActive) {
      const tickInt = '#c4b5fd';
      this.chartOptions.scales = {
        x: scaleX,
        y: scaleY,
        y1: {
          type: 'linear',
          position: 'right',
          title: {
            display: true,
            text: this.translate.instant('CALCULATOR.FORMULA_YAXIS_INTEGRAL'),
            color: tickInt
          },
          ticks: { color: tickInt },
          grid: {
            drawOnChartArea: false,
            color: 'rgba(167, 139, 250, 0.14)'
          }
        }
      };
    } else {
      this.chartOptions.scales = {
        x: scaleX,
        y: scaleY
      };
    }
    const plugins = this.chartOptions.plugins ?? {};
    this.chartOptions.plugins = {
      ...plugins,
      tooltip: {
        ...plugins.tooltip,
        callbacks: {
          ...plugins.tooltip?.callbacks,
          label: (ctx) => {
            const pt = ctx.raw as { x: number; y: number };
            if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number') {
              return '';
            }
            const xs = pt.x.toPrecision(6);
            const ys = pt.y.toPrecision(6);
            if (ctx.datasetIndex === 0) {
              return `x=${xs}, f(x)=${ys}`;
            }
            return `x=${xs}, ∫≈${ys}`;
          }
        }
      }
    };
  }

  /** Recalcule la courbe après activation/désactivation du tracé ∫ f. */
  onFormulaPlotIntegralCurveChange(): void {
    queueMicrotask(() => this.plotFormulaCurve());
  }

  /** Pastille : littéraux / opérateurs au curseur ; les modèles avec x composent avec la formule (ou la portion sélectionnée). */
  insertFormulaMathChip(expr: string): void {
    const ta =
      (this.formulaChartFullscreen ? this.formulaExprFs : this.formulaExprMain)?.nativeElement ?? null;
    const cur = this.formulaExpr ?? '';

    if (!ta) {
      const trimmed = cur.trim();
      if (
        !CalculatorComponent.formulaChipIsAtomic(expr) &&
        trimmed.length > 0 &&
        /\bx\b/.test(expr)
      ) {
        this.formulaExpr = expr.replace(/\bx\b/g, `(${trimmed})`);
      } else {
        this.formulaExpr = cur + expr;
      }
      return;
    }

    const start = ta.selectionStart ?? cur.length;
    const end = ta.selectionEnd ?? start;
    const rawSel = start !== end ? cur.slice(start, end) : '';
    const inner = (rawSel.trim() || cur.trim()) || '';

    const insertAtCursor = (insertion: string, selStart: number, selEnd: number) => {
      const next = cur.slice(0, selStart) + insertion + cur.slice(selEnd);
      this.formulaExpr = next;
      const pos = selStart + insertion.length;
      queueMicrotask(() => {
        ta.focus();
        ta.setSelectionRange(pos, pos);
      });
    };

    if (CalculatorComponent.formulaChipIsAtomic(expr)) {
      insertAtCursor(expr, start, end);
      return;
    }

    if (inner.length === 0 || !/\bx\b/.test(expr)) {
      insertAtCursor(expr, start, end);
      return;
    }

    const composed = expr.replace(/\bx\b/g, `(${inner})`);

    if (rawSel.trim().length > 0) {
      insertAtCursor(composed, start, end);
      return;
    }

    this.formulaExpr = composed;
    queueMicrotask(() => {
      ta.focus();
      ta.setSelectionRange(composed.length, composed.length);
    });
  }

  /** Calcule f(formulaEvalX) ; les trigonométriques suivent les radians (voir libellé i18n). */
  evaluateFormulaScalar(): void {
    this.formulaError = '';
    this.formulaIntegralResult = '';
    this.formulaScalarResult = '';
    const expr = this.formulaExpr.trim();
    if (!expr) {
      this.formulaError = 'CALCULATOR.FORMULA_ERR_EMPTY';
      return;
    }
    try {
      const code = compile(expr);
      const y = CalculatorComponent.evaluateCompiledAt(code, this.formulaEvalX);
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

  /** ∫ₐᵇ f(x) dx par Simpson composite (nombre pair de sous-intervalles). */
  evaluateFormulaIntegral(): void {
    this.formulaError = '';
    this.formulaScalarResult = '';
    this.formulaIntegralResult = '';
    const expr = this.formulaExpr.trim();
    if (!expr) {
      this.formulaError = 'CALCULATOR.FORMULA_ERR_EMPTY';
      return;
    }
    const a = Number(this.formulaIntegralA);
    const b = Number(this.formulaIntegralB);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
      this.formulaError = 'CALCULATOR.FORMULA_ERR_INTEGRAL_RANGE';
      return;
    }
    let n = Math.round(Number(this.formulaIntegralPanels));
    if (!Number.isFinite(n) || n < 4) {
      n = 256;
    }
    if (n % 2 !== 0) {
      n += 1;
    }
    const cap = 20000;
    if (n > cap) {
      n = cap - (cap % 2);
    }
    let code: EvalFunction;
    try {
      code = compile(expr);
    } catch {
      this.formulaError = 'CALCULATOR.FORMULA_ERR_SYNTAX';
      return;
    }
    const h = (b - a) / n;
    const y0 = CalculatorComponent.evaluateCompiledAt(code, a);
    const yn = CalculatorComponent.evaluateCompiledAt(code, b);
    if (y0 === null || yn === null) {
      this.formulaError = 'CALCULATOR.FORMULA_ERR_INTEGRAL_FAIL';
      return;
    }
    let sum = y0 + yn;
    for (let i = 1; i < n; i++) {
      const x = a + i * h;
      const yi = CalculatorComponent.evaluateCompiledAt(code, x);
      if (yi === null) {
        this.formulaError = 'CALCULATOR.FORMULA_ERR_INTEGRAL_FAIL';
        return;
      }
      sum += (i % 2 === 0 ? 2 : 4) * yi;
    }
    const integral = (h / 3) * sum;
    if (!Number.isFinite(integral)) {
      this.formulaError = 'CALCULATOR.FORMULA_ERR_INTEGRAL_FAIL';
      return;
    }
    this.formulaIntegralResult = this.formatForDisplay(integral);
    if (this.tapeMode) {
      this.tapePush(`∫_${a}^{${b}}`);
      this.tapePush('=');
      this.tapePush(this.formulaIntegralResult);
    }
  }

  /** Échantillonne y = f(x) sur [plotXMin, plotXMax] et met à jour le graphique. */
  plotFormulaCurve(): void {
    this.formulaError = '';
    this.formulaIntegralCurveCaption = '';
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
    let code: EvalFunction;
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
      const y = CalculatorComponent.evaluateCompiledAt(code, x);
      if (y !== null) {
        pts.push({ x, y });
      }
    }
    if (pts.length === 0) {
      this.formulaError = 'CALCULATOR.FORMULA_ERR_NOPOINTS';
      this.configureFormulaChartScales(false);
      this.chartData = { datasets: [] };
      queueMicrotask(() => this.formulaChart?.update());
      return;
    }

    let integralPts: { x: number; y: number }[] = [];
    if (this.formulaPlotIntegralCurve) {
      integralPts = CalculatorComponent.cumulativeIntegralUniformTrapezoid(
        code,
        xmin,
        xmax,
        n
      );
    }

    const dualAxis =
      this.formulaPlotIntegralCurve && integralPts.length >= 2;
    this.configureFormulaChartScales(dualAxis);

    const label =
      expr.length > 42 ? expr.slice(0, 39).trimEnd() + '…' : expr;
    const xminDisp = this.formatForDisplay(xmin);
    if (dualAxis) {
      this.formulaIntegralCurveCaption = this.translate.instant(
        'CALCULATOR.FORMULA_INTEGRAL_CURVE_CAPTION',
        { xmin: xminDisp, expr: label }
      );
    }

    const datasets: NonNullable<
      ChartConfiguration<'line'>['data']['datasets']
    > = [
      {
        label,
        data: pts,
        ...(dualAxis ? { yAxisID: 'y' as const } : {}),
        parsing: false,
        borderColor: '#2dd4bf',
        backgroundColor: 'rgba(45, 212, 191, 0.08)',
        tension: 0.12,
        spanGaps: false,
        pointRadius: 0,
        borderWidth: 2
      }
    ];

    if (dualAxis) {
      datasets.push({
        label: this.translate.instant('CALCULATOR.FORMULA_LEGEND_INTEGRAL_CURVE_DETAIL', {
          xmin: xminDisp,
          expr: label
        }),
        data: integralPts,
        yAxisID: 'y1',
        parsing: false,
        borderColor: '#a78bfa',
        backgroundColor: 'rgba(167, 139, 250, 0.06)',
        tension: 0.12,
        spanGaps: false,
        pointRadius: 0,
        borderWidth: 2
      });
    }

    this.chartData = { datasets };
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
    this.formulaIntegralResult = '';
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

import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';

import { ApiService, ChemElement, ChemMolecule } from '../services/api.service';
import { MoleculeViewer3dComponent } from './molecule-viewer-3d.component';
import { cpkHex, cpkTextColor } from './chem-data';

interface BohrShell {
  radius: number;
  electrons: { x: number; y: number }[];
}

interface BohrModel {
  symbol: string;
  protons: number;
  neutrons: number;
  electrons: number;
  shells: BohrShell[];
}

interface Frac {
  n: number;
  d: number;
}

interface BalancedTerm {
  coef: number;
  formula: string;
  side: 'L' | 'R';
}

interface ReactionSpecies {
  coef: number;
  formula: string;
  side: 'L' | 'R';
  composition: { symbol: string; count: number }[];
  imageUrl: string;
}

type ChemTab = 'table' | 'molecule' | 'compare' | 'reactions';

@Component({
  selector: 'app-chimie',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, MoleculeViewer3dComponent],
  templateUrl: './chimie.component.html',
  styleUrls: ['./chimie.component.css']
})
export class ChimieComponent implements OnInit, OnDestroy {

  activeTab: ChemTab = 'table';

  // --- Periodic table ---
  elements: ChemElement[] = [];
  selectedElement: ChemElement | null = null;
  selectedBohr: BohrModel | null = null;
  categoryFilter = '';
  isLoadingElements = false;
  elementsError = '';

  // --- Molecule explorer ---
  moleculeQuery = '';
  molecule: ChemMolecule | null = null;
  imageUrl = '';
  isLoadingMolecule = false;
  moleculeError = '';
  suggestions: string[] = [];
  showSuggestions = false;

  // --- Compare ---
  queryA = '';
  molA: ChemMolecule | null = null;
  imageA = '';
  loadingA = false;
  errorA = '';
  queryB = '';
  molB: ChemMolecule | null = null;
  imageB = '';
  loadingB = false;
  errorB = '';

  // --- Reactions ---
  equationInput = '2 H2 + O2 = 2 H2O';
  balancedTerms: BalancedTerm[] = [];
  reactionSpecies: ReactionSpecies[] = [];
  reactionError = '';
  readonly exampleReactions: string[] = [
    '2 H2 + O2 = 2 H2O',
    'CH4 + O2 = CO2 + H2O',
    'C6H12O6 + O2 = CO2 + H2O',
    'Fe + O2 = Fe2O3',
    'NH3 + O2 = NO + H2O',
    'KMnO4 + HCl = KCl + MnCl2 + H2O + Cl2'
  ];

  readonly featuredMolecules: string[] = [
    'water', 'caffeine', 'ethanol', 'glucose', 'benzene', 'aspirin',
    'paracetamol', 'methane', 'ammonia', 'carbon dioxide', 'citric acid',
    'ibuprofen', 'dopamine', 'cholesterol', 'sucrose', 'acetic acid'
  ];

  private static readonly CATEGORY_CLASS: Record<string, string> = {
    'Nonmetal': 'cat-nonmetal',
    'Noble gas': 'cat-noble',
    'Alkali metal': 'cat-alkali',
    'Alkaline earth metal': 'cat-alkaline-earth',
    'Metalloid': 'cat-metalloid',
    'Halogen': 'cat-halogen',
    'Transition metal': 'cat-transition',
    'Post-transition metal': 'cat-post-transition',
    'Lanthanide': 'cat-lanthanide',
    'Actinide': 'cat-actinide'
  };

  private static readonly CORES: Record<string, number[]> = {
    He: [2],
    Ne: [2, 8],
    Ar: [2, 8, 8],
    Kr: [2, 8, 18, 8],
    Xe: [2, 8, 18, 18, 8],
    Rn: [2, 8, 18, 32, 18, 8]
  };

  private subs: Subscription[] = [];
  private readonly searchInput$ = new Subject<string>();

  constructor(private api: ApiService, private cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
    this.loadElements();
    const sub = this.searchInput$
      .pipe(debounceTime(220), distinctUntilChanged())
      .subscribe((q) => this.fetchSuggestions(q));
    this.subs.push(sub);
    this.balanceEquation();
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.searchInput$.complete();
  }

  // ==================================================================
  // Periodic table
  // ==================================================================

  loadElements(): void {
    this.isLoadingElements = true;
    this.elementsError = '';
    const sub = this.api.getChemElements().subscribe({
      next: (elements) => {
        this.elements = elements;
        this.isLoadingElements = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.elementsError = 'CHIMIE.ERROR_ELEMENTS';
        this.isLoadingElements = false;
        this.cdr.markForCheck();
      }
    });
    this.subs.push(sub);
  }

  categoryClass(element: ChemElement): string {
    return ChimieComponent.CATEGORY_CLASS[element.groupBlock] ?? 'cat-unknown';
  }

  categoryClassByName(category: string): string {
    return ChimieComponent.CATEGORY_CLASS[category] ?? 'cat-unknown';
  }

  isDimmed(element: ChemElement): boolean {
    return !!this.categoryFilter && element.groupBlock !== this.categoryFilter;
  }

  get categories(): string[] {
    return Object.keys(ChimieComponent.CATEGORY_CLASS);
  }

  toggleCategory(category: string): void {
    this.categoryFilter = this.categoryFilter === category ? '' : category;
  }

  selectElement(element: ChemElement): void {
    this.selectedElement = element;
    this.selectedBohr = this.buildBohrModel(element);
    this.cdr.markForCheck();
  }

  closeElement(): void {
    this.selectedElement = null;
    this.selectedBohr = null;
  }

  viewElementAsMolecule(element: ChemElement): void {
    this.activeTab = 'molecule';
    this.moleculeQuery = element.name;
    this.searchMolecule();
  }

  private buildBohrModel(element: ChemElement): BohrModel {
    const counts = this.bohrShellCounts(element.electronConfiguration, element.atomicNumber);
    const mass = parseFloat(element.atomicMass);
    const neutrons = Number.isFinite(mass) ? Math.max(0, Math.round(mass) - element.atomicNumber) : 0;
    const shells: BohrShell[] = counts.map((count, i) => {
      const radius = 34 + i * 20;
      const electrons = [];
      for (let e = 0; e < count; e++) {
        const angle = (2 * Math.PI * e) / count - Math.PI / 2;
        electrons.push({
          x: +(Math.cos(angle) * radius).toFixed(2),
          y: +(Math.sin(angle) * radius).toFixed(2)
        });
      }
      return { radius, electrons };
    });
    return {
      symbol: element.symbol,
      protons: element.atomicNumber,
      neutrons,
      electrons: counts.reduce((a, b) => a + b, 0),
      shells
    };
  }

  private bohrShellCounts(config: string, atomicNumber: number): number[] {
    const shells: number[] = [];
    const add = (n: number, count: number) => {
      shells[n - 1] = (shells[n - 1] || 0) + count;
    };
    if (config) {
      const coreMatch = config.match(/^\[([A-Za-z]+)\]/);
      if (coreMatch) {
        const core = ChimieComponent.CORES[coreMatch[1]];
        if (core) {
          core.forEach((c, i) => add(i + 1, c));
        }
      }
      const re = /(\d)[spdf](\d+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(config)) !== null) {
        add(parseInt(m[1], 10), parseInt(m[2], 10));
      }
    }
    const total = shells.reduce((a, b) => a + (b || 0), 0);
    if (!shells.length || total !== atomicNumber) {
      return this.fallbackShells(atomicNumber);
    }
    for (let i = 0; i < shells.length; i++) {
      if (!shells[i]) {
        shells[i] = 0;
      }
    }
    return shells;
  }

  private fallbackShells(z: number): number[] {
    const capacities = [2, 8, 18, 32, 32, 18, 8];
    const shells: number[] = [];
    let remaining = z;
    for (const cap of capacities) {
      if (remaining <= 0) {
        break;
      }
      const here = Math.min(cap, remaining);
      shells.push(here);
      remaining -= here;
    }
    return shells;
  }

  // ==================================================================
  // Molecule explorer
  // ==================================================================

  onQueryInput(value: string): void {
    this.searchInput$.next(value);
    this.showSuggestions = true;
  }

  private fetchSuggestions(q: string): void {
    const term = (q || '').trim();
    if (term.length < 2) {
      this.suggestions = [];
      this.cdr.markForCheck();
      return;
    }
    const sub = this.api.chemAutocomplete(term, 8).subscribe({
      next: (res) => {
        this.suggestions = res.suggestions ?? [];
        this.cdr.markForCheck();
      },
      error: () => {
        this.suggestions = [];
        this.cdr.markForCheck();
      }
    });
    this.subs.push(sub);
  }

  pickSuggestion(name: string): void {
    this.moleculeQuery = name;
    this.suggestions = [];
    this.showSuggestions = false;
    this.searchMolecule();
  }

  pickFeatured(name: string): void {
    this.moleculeQuery = name;
    this.searchMolecule();
  }

  searchMolecule(): void {
    const term = this.moleculeQuery.trim();
    if (!term) {
      return;
    }
    this.showSuggestions = false;
    this.suggestions = [];
    this.isLoadingMolecule = true;
    this.moleculeError = '';
    const sub = this.api.getChemMoleculeByName(term).subscribe({
      next: (mol) => {
        this.molecule = mol;
        this.imageUrl = this.api.chemImageUrl(mol.cid);
        this.isLoadingMolecule = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.molecule = null;
        this.imageUrl = '';
        this.moleculeError = err?.status === 404 ? 'CHIMIE.ERROR_NOT_FOUND' : 'CHIMIE.ERROR_MOLECULE';
        this.isLoadingMolecule = false;
        this.cdr.markForCheck();
      }
    });
    this.subs.push(sub);
  }

  // ==================================================================
  // Compare (two molecules side by side)
  // ==================================================================

  searchCompare(slot: 'A' | 'B'): void {
    const term = (slot === 'A' ? this.queryA : this.queryB).trim();
    if (!term) {
      return;
    }
    if (slot === 'A') {
      this.loadingA = true;
      this.errorA = '';
    } else {
      this.loadingB = true;
      this.errorB = '';
    }
    const sub = this.api.getChemMoleculeByName(term).subscribe({
      next: (mol) => {
        if (slot === 'A') {
          this.molA = mol;
          this.imageA = this.api.chemImageUrl(mol.cid);
          this.loadingA = false;
        } else {
          this.molB = mol;
          this.imageB = this.api.chemImageUrl(mol.cid);
          this.loadingB = false;
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        const msg = err?.status === 404 ? 'CHIMIE.ERROR_NOT_FOUND' : 'CHIMIE.ERROR_MOLECULE';
        if (slot === 'A') {
          this.molA = null;
          this.imageA = '';
          this.errorA = msg;
          this.loadingA = false;
        } else {
          this.molB = null;
          this.imageB = '';
          this.errorB = msg;
          this.loadingB = false;
        }
        this.cdr.markForCheck();
      }
    });
    this.subs.push(sub);
  }

  // ==================================================================
  // Reactions (chemical equation balancer)
  // ==================================================================

  setEquation(example: string): void {
    this.equationInput = example;
    this.balanceEquation();
  }

  balanceEquation(): void {
    this.reactionError = '';
    this.balancedTerms = [];
    this.reactionSpecies = [];

    const eq = this.equationInput.trim();
    if (!eq) {
      return;
    }
    const sides = eq.split(/=|->|→|⇌|<=>/);
    if (sides.length !== 2) {
      this.reactionError = 'CHIMIE.RX_ERR_FORMAT';
      return;
    }
    const lhs = sides[0].split('+').map((s) => s.trim()).filter(Boolean);
    const rhs = sides[1].split('+').map((s) => s.trim()).filter(Boolean);
    if (!lhs.length || !rhs.length) {
      this.reactionError = 'CHIMIE.RX_ERR_FORMAT';
      return;
    }
    const formulas = [...lhs, ...rhs].map((s) =>
      s.replace(/^\s*\d+\s*/, '').replace(/[·*].*$/, '').trim()
    );
    const parsed = formulas.map((f) => this.parseFormula(f));
    if (parsed.some((p) => p === null || Object.keys(p as object).length === 0)) {
      this.reactionError = 'CHIMIE.RX_ERR_PARSE';
      return;
    }
    const nLhs = lhs.length;
    const elements = Array.from(new Set(parsed.flatMap((p) => Object.keys(p as object))));
    const matrix: Frac[][] = elements.map((el) =>
      parsed.map((p, j) => {
        const v = (p as Record<string, number>)[el] || 0;
        return this.fr(j < nLhs ? v : -v);
      })
    );
    const coeffs = this.nullspaceIntegerVector(matrix, formulas.length);
    if (!coeffs) {
      this.reactionError = 'CHIMIE.RX_ERR_BALANCE';
      return;
    }

    this.balancedTerms = formulas.map((f, j) => ({
      coef: coeffs[j],
      formula: f,
      side: j < nLhs ? 'L' : 'R'
    }));
    this.reactionSpecies = formulas.map((f, j) => ({
      coef: coeffs[j],
      formula: f,
      side: j < nLhs ? 'L' : 'R',
      composition: Object.entries(parsed[j] as Record<string, number>).map(([symbol, count]) => ({
        symbol,
        count
      })),
      imageUrl: ''
    }));
    this.resolveReactionImages();
  }

  get lhsTerms(): BalancedTerm[] {
    return this.balancedTerms.filter((t) => t.side === 'L');
  }

  get rhsTerms(): BalancedTerm[] {
    return this.balancedTerms.filter((t) => t.side === 'R');
  }

  private resolveReactionImages(): void {
    for (const species of this.reactionSpecies) {
      const sub = this.api.getChemCidByFormula(species.formula).subscribe({
        next: (res) => {
          if (res?.cid) {
            species.imageUrl = this.api.chemImageUrl(res.cid);
            this.cdr.markForCheck();
          }
        },
        error: () => {
          /* best effort — composition badges are always shown */
        }
      });
      this.subs.push(sub);
    }
  }

  private parseFormula(formula: string): Record<string, number> | null {
    const tokens = formula.match(/[A-Z][a-z]?|\d+|\(|\)|\[|\]/g);
    if (!tokens || !tokens.length) {
      return null;
    }
    const stack: Record<string, number>[] = [{}];
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === '(' || t === '[') {
        stack.push({});
        i++;
      } else if (t === ')' || t === ']') {
        let mult = 1;
        if (i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1])) {
          mult = parseInt(tokens[i + 1], 10);
          i++;
        }
        const top = stack.pop();
        if (!top || stack.length === 0) {
          return null;
        }
        const parent = stack[stack.length - 1];
        for (const el in top) {
          parent[el] = (parent[el] || 0) + top[el] * mult;
        }
        i++;
      } else if (/^[A-Z][a-z]?$/.test(t)) {
        let count = 1;
        if (i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1])) {
          count = parseInt(tokens[i + 1], 10);
          i++;
        }
        const top = stack[stack.length - 1];
        top[t] = (top[t] || 0) + count;
        i++;
      } else {
        i++;
      }
    }
    return stack.length === 1 ? stack[0] : null;
  }

  // --- rational arithmetic + nullspace ---

  private gcd(a: number, b: number): number {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b) {
      const t = a % b;
      a = b;
      b = t;
    }
    return a || 1;
  }

  private fr(n: number, d = 1): Frac {
    if (d < 0) {
      n = -n;
      d = -d;
    }
    const g = this.gcd(n, d);
    return { n: n / g, d: d / g };
  }

  private fsub(a: Frac, b: Frac): Frac {
    return this.fr(a.n * b.d - b.n * a.d, a.d * b.d);
  }

  private fmul(a: Frac, b: Frac): Frac {
    return this.fr(a.n * b.n, a.d * b.d);
  }

  private fdiv(a: Frac, b: Frac): Frac {
    return this.fr(a.n * b.d, a.d * b.n);
  }

  private nullspaceIntegerVector(matrix: Frac[][], n: number): number[] | null {
    const M = matrix.map((row) => row.map((c) => ({ ...c })));
    const m = M.length;
    const pivotCols: number[] = [];
    let row = 0;
    for (let col = 0; col < n && row < m; col++) {
      let sel = -1;
      for (let r = row; r < m; r++) {
        if (M[r][col].n !== 0) {
          sel = r;
          break;
        }
      }
      if (sel === -1) {
        continue;
      }
      [M[row], M[sel]] = [M[sel], M[row]];
      const piv = M[row][col];
      for (let c = 0; c < n; c++) {
        M[row][c] = this.fdiv(M[row][c], piv);
      }
      for (let r = 0; r < m; r++) {
        if (r === row) {
          continue;
        }
        const factor = M[r][col];
        if (factor.n === 0) {
          continue;
        }
        for (let c = 0; c < n; c++) {
          M[r][c] = this.fsub(M[r][c], this.fmul(factor, M[row][c]));
        }
      }
      pivotCols.push(col);
      row++;
    }

    const freeCols: number[] = [];
    for (let c = 0; c < n; c++) {
      if (!pivotCols.includes(c)) {
        freeCols.push(c);
      }
    }
    if (freeCols.length !== 1) {
      return null;
    }
    const free = freeCols[0];
    const sol: Frac[] = Array.from({ length: n }, () => this.fr(0));
    sol[free] = this.fr(1);
    for (let r = 0; r < pivotCols.length; r++) {
      sol[pivotCols[r]] = this.fr(-M[r][free].n, M[r][free].d);
    }

    let lcm = 1;
    for (const s of sol) {
      lcm = (lcm / this.gcd(lcm, s.d)) * s.d;
    }
    let ints = sol.map((s) => s.n * (lcm / s.d));

    if (ints.every((v) => v <= 0)) {
      ints = ints.map((v) => -v);
    }
    if (ints.some((v) => v < 0)) {
      return null;
    }
    let g = 0;
    for (const v of ints) {
      g = this.gcd(g, v);
    }
    if (g > 1) {
      ints = ints.map((v) => v / g);
    }
    if (ints.some((v) => v <= 0)) {
      return null;
    }
    return ints;
  }

  // --- template helpers ---

  atomColor(symbol: string): string {
    return cpkHex(symbol);
  }

  atomTextColor(symbol: string): string {
    return cpkTextColor(symbol);
  }
}

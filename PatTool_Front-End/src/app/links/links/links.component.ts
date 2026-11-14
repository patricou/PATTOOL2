import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit
} from '@angular/core';
import { debounceTime, take } from 'rxjs/operators';
import { Subject, Subscription } from 'rxjs';
import { IotProxyTarget } from '../../model/iot-proxy-target';
import { IotProxyService } from '../../services/iot-proxy.service';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Category } from '../../model/Category';
import { Member } from '../../model/member';
import { urllink } from '../../model/urllink';
import { KeycloakService } from '../../keycloak/keycloak.service';
import { MembersService } from '../../services/members.service';
import { UrllinkService } from '../../services/urllink.service';
import { NavigationButtonsModule } from '../../shared/navigation-buttons/navigation-buttons.module';

@Component({
  selector: 'app-links',
  templateUrl: './links.component.html',
  styleUrls: ['./links.component.css'],
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    TranslateModule,
    NavigationButtonsModule
  ]
})
export class LinksComponent implements OnInit, OnDestroy {

  public urllinks: urllink[] = [];
  public categories: Category[] = [];
  public user: Member = this._memberService.getUser();
  public expandedCategoryIndex: number | null = null;
  public searchFilter = '';
  public searchSuggestions: urllink[] = [];
  public showSuggestions = false;
  /** Dernières recherches, uniquement dans ce navigateur (localStorage). */
  public recentSearches: string[] = [];
  public searchFocused = false;
  public openUrlOnClick = true;
  public loading = true;
  public statsCategoriesText = '';
  public statsLinksText = '';
  /** Precomputed category header (no translate pipe per row / per CD). */
  public categoryUi: Record<string, { title: string; iconClass: string }> = {};
  /** Visibility button tooltips (no translate pipe per link row). */
  public visibilityTitlePublic = '';
  public visibilityTitlePrivate = '';
  public visibilityTitleFriends = '';

  private proxyTargets: IotProxyTarget[] = [];

  filteredLinksByCategoryId: Record<string, urllink[]> = {};
  categoryLinkCountById: Record<string, number> = {};
  linksByCategoryId: Record<string, urllink[]> = {};

  private langChangeSub?: Subscription;
  private searchInput$ = new Subject<void>();
  private searchDebounceSub?: Subscription;
  private recentBlurTimer: ReturnType<typeof setTimeout> | null = null;

  private static readonly RECENT_SEARCHES_KEY = 'pattool.links.recent-searches';
  private static readonly RECENT_SEARCHES_MAX = 8;

  private static readonly CATEGORY_TITLE_KEYS: Record<string, string> = {
    administratif: 'LINKS.CATEGORIES.ADMINISTRATIF'
  };

  private static readonly CATEGORY_ICONS: Record<string, string> = {
    administratif: 'fa-file-text-o',
    commerce: 'fa-shopping-cart',
    finance: 'fa-money',
    ia: 'fa-cogs',
    ai: 'fa-cogs',
    'intelligence artificielle': 'fa-cogs',
    'artificial intelligence': 'fa-cogs',
    it: 'fa-laptop',
    'it knowledge': 'fa-graduation-cap',
    iot: 'fa-microchip',
    'internet of things': 'fa-microchip',
    languages: 'fa-language',
    langues: 'fa-language',
    maison: 'fa-home',
    home: 'fa-home',
    media: 'fa-play-circle',
    méditation: 'fa-leaf',
    meditation: 'fa-leaf',
    photo: 'fa-camera',
    photography: 'fa-camera',
    privé: 'fa-lock',
    private: 'fa-lock',
    professional: 'fa-briefcase',
    professionnel: 'fa-briefcase',
    'social media': 'fa-share-alt',
    sport: 'fa-trophy',
    sports: 'fa-trophy'
  };

  constructor(
    private _memberService: MembersService,
    private _urlLinkService: UrllinkService,
    private _iotProxyService: IotProxyService,
    private _keycloak: KeycloakService,
    private translate: TranslateService,
    private cdr: ChangeDetectorRef
  ) { }

  ngOnInit(): void {
    this.langChangeSub = this.translate.onLangChange.subscribe(() => {
      this.refreshAllStaticLabels();
      this.cdr.markForCheck();
    });

    this.searchDebounceSub = this.searchInput$.pipe(debounceTime(120)).subscribe(() => {
      this.applySearchFromModel();
      this.cdr.markForCheck();
    });

    this.refreshVisibilityTitles();
    this.recentSearches = this.readRecentSearches();

    this.loading = true;
    const loadLinks = () => {
      this.user = this._memberService.getUser();
      this.loadProxyTargets();
      this._urlLinkService.getLinksView(this.user).subscribe({
        next: (res) => {
          this.categories = (res.categories ?? []).map((c) => this.normalizeCategoryAuthor(c));
          this.linksByCategoryId = this.normalizeLinksAuthors(res.linksByCategoryId ?? {});
          this.urllinks = Object.values(this.linksByCategoryId).flat();
          this.refreshFilteredLinks();
          this.refreshAllStaticLabels();
          this.loading = false;
          this.cdr.markForCheck();
        },
        error: (err) => {
          alert('Error loading links: ' + err);
          this.statsCategoriesText = '';
          this.statsLinksText = '';
          this.categoryUi = {};
          this.loading = false;
          this.cdr.markForCheck();
        }
      });
    };

    if (this._memberService.getUser().id) {
      loadLinks();
    } else {
      this._memberService.getUserId({ skipGeolocation: true }).pipe(take(1)).subscribe({
        next: () => loadLinks(),
        error: () => loadLinks()
      });
    }
  }

  ngOnDestroy(): void {
    this.rememberRecentSearch(this.searchFilter);
    this.langChangeSub?.unsubscribe();
    this.searchDebounceSub?.unsubscribe();
    if (this.recentBlurTimer) {
      clearTimeout(this.recentBlurTimer);
      this.recentBlurTimer = null;
    }
  }

  /** Debounced — fired after ngModel has updated (avoids stale reads vs raw input). */
  onSearchFilterChange(): void {
    const term = (this.searchFilter ?? '').trim();
    if (!term) {
      this.searchSuggestions = [];
      this.showSuggestions = false;
    }
    this.searchInput$.next();
  }

  onSearchFocus(): void {
    if (this.recentBlurTimer) {
      clearTimeout(this.recentBlurTimer);
      this.recentBlurTimer = null;
    }
    this.searchFocused = true;
    this.applySearchFromModel();
  }

  onSearchBlur(): void {
    this.rememberRecentSearch(this.searchFilter);
    this.searchFocused = false;
    if (this.recentBlurTimer) {
      clearTimeout(this.recentBlurTimer);
    }
    // Laisse le temps au clic sur une suggestion (le blur part avant le click).
    this.recentBlurTimer = setTimeout(() => {
      this.recentBlurTimer = null;
      this.showSuggestions = false;
      this.cdr.markForCheck();
    }, 200);
  }

  onSearchKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    this.rememberRecentSearch(this.searchFilter);
    this.showSuggestions = false;
    this.cdr.markForCheck();
  }

  /** Historique affiché au focus, tant que le champ est vide. */
  showRecentSearches(): boolean {
    const term = (this.searchFilter ?? '').trim();
    return this.searchFocused && !term && !this.showSuggestions && this.recentSearches.length > 0;
  }

  applyRecentSearch(term: string): void {
    const value = (term || '').trim();
    if (!value) {
      return;
    }
    this.searchFocused = true;
    this.searchFilter = value;
    this.rememberRecentSearch(value);
    this.applySearchFromModel();
    this.cdr.markForCheck();
  }

  removeRecentSearch(term: string, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    const lower = term.toLowerCase();
    this.recentSearches = this.recentSearches.filter((item) => item.toLowerCase() !== lower);
    this.writeRecentSearches(this.recentSearches);
    this.cdr.markForCheck();
  }

  /** Immediate — focus, clear, after picking a suggestion. */
  applySearchFromModel(): void {
    const term = this.searchFilter?.trim() ?? '';
    this.refreshFilteredLinks();

    if (term.length < 1) {
      this.searchSuggestions = [];
      this.showSuggestions = false;
      return;
    }

    const lower = term.toLowerCase();
    // Links list is already visibility-filtered by the API; do not require author here (avoids empty suggestions).
    this.searchSuggestions = this.urllinks
      .filter(u => LinksComponent.linkMatchesTerm(u, lower))
      .slice(0, 10);

    this.showSuggestions = this.searchSuggestions.length > 0;
  }

  clearSearch(): void {
    if (this.recentBlurTimer) {
      clearTimeout(this.recentBlurTimer);
      this.recentBlurTimer = null;
    }
    this.rememberRecentSearch(this.searchFilter);
    this.searchFilter = '';
    this.applySearchFromModel();
    this.cdr.markForCheck();
  }

  private rememberRecentSearch(term: string | null | undefined): void {
    const value = (term || '').trim().slice(0, 80);
    if (value.length < 2) {
      return;
    }
    const lower = value.toLowerCase();
    const next = [
      value,
      ...this.recentSearches.filter((item) => item.toLowerCase() !== lower)
    ].slice(0, LinksComponent.RECENT_SEARCHES_MAX);
    this.recentSearches = next;
    this.writeRecentSearches(next);
  }

  private readRecentSearches(): string[] {
    try {
      const raw = localStorage.getItem(LinksComponent.RECENT_SEARCHES_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      const seen = new Set<string>();
      const terms: string[] = [];
      for (const item of parsed) {
        if (typeof item !== 'string') {
          continue;
        }
        const value = item.trim().slice(0, 80);
        const lower = value.toLowerCase();
        if (value.length < 2 || seen.has(lower)) {
          continue;
        }
        seen.add(lower);
        terms.push(value);
        if (terms.length >= LinksComponent.RECENT_SEARCHES_MAX) {
          break;
        }
      }
      return terms;
    } catch {
      return [];
    }
  }

  private writeRecentSearches(terms: string[]): void {
    try {
      localStorage.setItem(LinksComponent.RECENT_SEARCHES_KEY, JSON.stringify(terms));
    } catch {
      /* quota ou navigation privée */
    }
  }

  private refreshAllStaticLabels(): void {
    this.refreshStatsLabels();
    this.refreshCategoryUi();
    this.refreshVisibilityTitles();
  }

  private refreshStatsLabels(): void {
    this.statsCategoriesText = this.translate.instant('LINKS.N_CATEGORIES', { count: this.categories.length });
    this.statsLinksText = this.translate.instant('LINKS.N_LINKS', { count: this.urllinks.length });
  }

  private refreshVisibilityTitles(): void {
    this.visibilityTitlePublic = this.translate.instant('LINKSADMIN.PUBLIC');
    this.visibilityTitlePrivate = this.translate.instant('LINKSADMIN.PRIVATE');
    this.visibilityTitleFriends = this.translate.instant('LINKSADMIN.FRIENDS');
  }

  private refreshCategoryUi(): void {
    const ui: Record<string, { title: string; iconClass: string }> = {};
    for (const c of this.categories) {
      const id = c.categoryLinkID;
      const norm = (c.categoryName || '').trim().toLowerCase();
      const key = LinksComponent.CATEGORY_TITLE_KEYS[norm];
      const title = key ? this.translate.instant(key) : (c.categoryName || '');
      const iconClass = LinksComponent.CATEGORY_ICONS[norm] ?? 'fa-folder';
      ui[id] = { title, iconClass };
    }
    this.categoryUi = ui;
  }

  /**
   * API may omit camelCase consistency; map authorId / Author into author for display.
   */
  private normalizeLinksAuthors(src: Record<string, urllink[]>): Record<string, urllink[]> {
    const out: Record<string, urllink[]> = {};
    for (const key of Object.keys(src)) {
      const list = src[key] ?? [];
      out[key] = list.map((u) => this.normalizeLinkAuthor(u));
    }
    return out;
  }

  private normalizeLinkAuthor(link: urllink): urllink {
    const raw = link as unknown as Record<string, unknown>;
    const authorRaw = raw['author'] ?? raw['Author'];
    const authorId = raw['authorId'] ?? raw['author_id'];
    if (authorRaw && typeof authorRaw === 'object' && !Array.isArray(authorRaw)) {
      const a = authorRaw as Record<string, unknown>;
      const hasIdentity =
        a['id'] ||
        a['_id'] ||
        LinksComponent.firstNonBlank(
          a['userName'],
          a['user_name'],
          a['username'],
          a['Username'],
          a['login'],
          a['Login']
        ) ||
        a['firstName'] ||
        a['first_name'] ||
        a['lastName'] ||
        a['last_name'] ||
        a['addressEmail'] ||
        a['email'];
      if (hasIdentity) {
        return { ...link, author: LinksComponent.normalizeMemberLike(a) };
      }
    }
    if (authorId != null && String(authorId).trim()) {
      const sid = String(authorId).trim();
      return { ...link, author: { id: sid } as Member };
    }
    return link;
  }

  /**
   * Libellé affiché pour la ligne « propriétaire » : auteur du lien, sinon auteur de la catégorie
   * (liens anciens sans {@code author} en base).
   */
  linkRowAuthorLabel(u: urllink, category: Category): string | null {
    return this.linkAuthorLabel(u.author) ?? this.linkAuthorLabel(category?.author);
  }

  private normalizeCategoryAuthor(category: Category): Category {
    const raw = category as unknown as Record<string, unknown>;
    const authorRaw = raw['author'] ?? raw['Author'];
    if (authorRaw && typeof authorRaw === 'object' && !Array.isArray(authorRaw)) {
      const a = authorRaw as Record<string, unknown>;
      const hasIdentity =
        a['id'] ||
        a['_id'] ||
        LinksComponent.firstNonBlank(
          a['userName'],
          a['user_name'],
          a['username'],
          a['Username'],
          a['login'],
          a['Login']
        ) ||
        a['firstName'] ||
        a['first_name'] ||
        a['lastName'] ||
        a['last_name'] ||
        a['addressEmail'] ||
        a['email'];
      if (hasIdentity) {
        return { ...category, author: LinksComponent.normalizeMemberLike(a) };
      }
    }
    return category;
  }

  /** userName + prénom/nom (toutes variantes de clés JSON / Mongo). */
  linkAuthorLabel(m: Member | undefined | null): string | null {
    if (!m) {
      return null;
    }
    const raw = m as unknown as Record<string, unknown>;
    const userName = LinksComponent.firstNonBlank(
      m.userName,
      raw['userName'],
      raw['user_name'],
      raw['username'],
      raw['Username'],
      raw['login'],
      raw['Login']
    );
    const firstName = LinksComponent.firstNonBlank(m.firstName, raw['firstName'], raw['first_name']);
    const lastName = LinksComponent.firstNonBlank(m.lastName, raw['lastName'], raw['last_name']);
    const full = `${firstName} ${lastName}`.trim();
    const email = LinksComponent.firstNonBlank(
      m.addressEmail,
      raw['addressEmail'],
      raw['address_email'],
      raw['email']
    );
    if (userName && full) {
      return `${userName} — ${full}`;
    }
    if (userName) {
      return userName;
    }
    if (full) {
      return full;
    }
    if (email) {
      return email;
    }
    return null;
  }

  private static firstNonBlank(...candidates: unknown[]): string {
    for (const c of candidates) {
      if (c == null) {
        continue;
      }
      const s = String(c).trim();
      if (s) {
        return s;
      }
    }
    return '';
  }

  /** Plain Member-like object (id + champs d’affichage). */
  private static normalizeMemberLike(a: Record<string, unknown>): Member {
    const idRaw = LinksComponent.firstNonBlank(a['id'], a['_id']);
    const id = LinksComponent.extractHexMemberId(idRaw);
    const userName = LinksComponent.firstNonBlank(
      a['userName'],
      a['user_name'],
      a['username'],
      a['Username'],
      a['login'],
      a['Login']
    );
    const firstName = LinksComponent.firstNonBlank(a['firstName'], a['first_name']);
    const lastName = LinksComponent.firstNonBlank(a['lastName'], a['last_name']);
    const addressEmail = LinksComponent.firstNonBlank(
      a['addressEmail'],
      a['address_email'],
      a['email']
    );
    return {
      id,
      userName,
      firstName,
      lastName,
      addressEmail,
      roles: [],
      keycloakId: ''
    } as Member;
  }

  /** Id membre : hex 24 ou chaîne DBRef Java / Mongo {@code "$id" : "..."}. */
  private static extractHexMemberId(raw: string): string {
    const t = (raw || '').trim();
    if (!t) {
      return '';
    }
    if (/^[a-fA-F0-9]{24}$/.test(t)) {
      return t.toLowerCase();
    }
    const m = t.match(/"\$id"\s*:\s*"([a-fA-F0-9]{24})"/i);
    if (m?.[1]) {
      return m[1].toLowerCase();
    }
    const o = t.match(/"\$oid"\s*:\s*"([a-fA-F0-9]{24})"/i);
    if (o?.[1]) {
      return o[1].toLowerCase();
    }
    return t;
  }

  refreshFilteredLinks(): void {
    const countById: Record<string, number> = {};
    const linksById: Record<string, urllink[]> = {};
    const term = this.searchFilter?.trim();

    for (const c of this.categories) {
      const id = c.categoryLinkID;
      const visibleLinks = this.linksByCategoryId[id] ?? [];
      if (term) {
        const lower = term.toLowerCase();
        const matched = visibleLinks.filter(u => LinksComponent.linkMatchesTerm(u, lower));
        linksById[id] = matched;
        countById[id] = matched.length;
      } else {
        linksById[id] = visibleLinks;
        countById[id] = visibleLinks.length;
      }
    }
    this.categoryLinkCountById = countById;
    this.filteredLinksByCategoryId = linksById;
  }

  private static linkMatchesTerm(u: urllink, lower: string): boolean {
    const linkName = (u.linkName || '').toLowerCase();
    const linkDescription = (u.linkDescription || '').toLowerCase();
    const url = (u.url || '').toLowerCase();
    return linkName.includes(lower) || linkDescription.includes(lower) || url.includes(lower);
  }

  /**
   * While the search box has text, hide categories with no matching links (0 after filter).
   * Without a search term, all categories stay visible (including empty ones).
   */
  isCategoryVisible(category: Category): boolean {
    const term = (this.searchFilter ?? '').trim();
    if (!term) {
      return true;
    }
    return (this.categoryLinkCountById[category.categoryLinkID] ?? 0) > 0;
  }

  /** False only when user is searching and every category has 0 matches — show global empty state. */
  hasSearchMatchInCategories(): boolean {
    const term = (this.searchFilter ?? '').trim();
    if (!term) {
      return true;
    }
    return this.categories.some(c => (this.categoryLinkCountById[c.categoryLinkID] ?? 0) > 0);
  }

  selectSuggestion(suggestion: urllink): void {
    if (this.openUrlOnClick) {
      this.openLinkInBrowser(suggestion);
    }

    const categoryIndex = this.categories.findIndex(c => c.categoryLinkID === suggestion.categoryLinkID);

    if (categoryIndex !== -1) {
      this.expandedCategoryIndex = categoryIndex;
      this.searchFilter = '';
      this.searchFocused = false;
      this.showSuggestions = false;
      this.searchSuggestions = [];
      this.refreshFilteredLinks();
    }
    this.cdr.markForCheck();
  }

  getCategoryName(categoryLinkID: string): string {
    const category = this.categories.find(c => c.categoryLinkID === categoryLinkID);
    return category ? String(category.categoryName) : '';
  }

  toggleCategory(categoryIndex: number, _category: Category): void {
    const term = (this.searchFilter ?? '').trim();
    if (term.length > 0) {
      this.searchFilter = '';
      this.searchSuggestions = [];
      this.showSuggestions = false;
      this.refreshFilteredLinks();
      this.expandedCategoryIndex = categoryIndex;
      this.cdr.markForCheck();
      return;
    }
    if (this.expandedCategoryIndex === categoryIndex) {
      this.expandedCategoryIndex = null;
    } else {
      this.expandedCategoryIndex = categoryIndex;
    }
    this.cdr.markForCheck();
  }

  /**
   * While searching, expand every category that has at least one match so results are visible
   * without clicking each section (single expandedCategoryIndex is not enough).
   */
  isCategoryExpanded(categoryIndex: number, category: Category): boolean {
    const term = (this.searchFilter ?? '').trim();
    if (term.length > 0) {
      const n = this.filteredLinksByCategoryId[category.categoryLinkID]?.length ?? 0;
      return n > 0;
    }
    return this.expandedCategoryIndex === categoryIndex;
  }

  trackByCategoryId(_index: number, c: Category): string {
    return c.categoryLinkID;
  }

  trackByLinkId(_index: number, u: urllink): string {
    return u.id ?? `${u.url}-${u.linkName}`;
  }

  /** Arrow: Angular calls trackBy without component `this`; must not delegate via `this.method`. */
  readonly trackBySuggestion = (_index: number, u: urllink): string =>
    this.trackByLinkId(_index, u);

  /**
   * Classe CSS pour le badge de visibilité (fond différent public / privé / amis).
   */
  linkVisibilityBadgeClass(u: urllink): string {
    const v = (u.visibility || 'public').toLowerCase();
    if (v === 'private') {
      return 'link-visibility--private';
    }
    if (v === 'friends') {
      return 'link-visibility--friends';
    }
    return 'link-visibility--public';
  }

  visibilityTitle(u: urllink): string {
    const v = u.visibility || 'public';
    if (v === 'public') {
      return this.visibilityTitlePublic;
    }
    if (v === 'private') {
      return this.visibilityTitlePrivate;
    }
    return this.visibilityTitleFriends;
  }

  onLinkAnchorClick(u: urllink, event: MouseEvent): void {
    if (!u.openByProxyLan || !this._keycloak.hasIotRole()) {
      return;
    }
    event.preventDefault();
    this.openLinkInBrowser(u);
  }

  openLinkInBrowser(u: urllink): void {
    const raw = String(u.url || '');
    if (!u.openByProxyLan || !this._keycloak.hasIotRole()) {
      window.open(raw, '_blank', 'noopener,noreferrer');
      return;
    }
    const row = this._iotProxyService.findMatchingProxyForLinkUrl(raw, this.proxyTargets);
    if (!row?.publicSlug) {
      alert(this.translate.instant('LINKS.PROXY_NO_MATCH'));
      return;
    }
    const parts = this._iotProxyService.buildProxyOpenPathParts(raw, row.upstreamBaseUrl || '');
    if (!parts) {
      alert(this.translate.instant('LINKS.PROXY_PATH_MISMATCH'));
      return;
    }
    this._iotProxyService
      .mintBrowserOpenUrl(row.publicSlug, parts.path, this.user?.id, parts.forwardQuery)
      .pipe(take(1))
      .subscribe({
        next: (res) => {
          const abs = this._iotProxyService.resolveBackendAbsoluteUrl(res.relativeUrlWithQuery);
          window.open(abs, '_blank', 'noopener,noreferrer');
        },
        error: () => alert(this.translate.instant('LINKS.PROXY_OPEN_FAILED'))
      });
  }

  private loadProxyTargets(): void {
    // GET /api/iot-proxies requires the Iot role. Calling it for other users
    // returns 401/403 and the Keycloak interceptor redirects to login → reload loop.
    if (!this._keycloak.hasIotRole()) {
      this.proxyTargets = [];
      return;
    }
    this._iotProxyService.list(this.user?.id).subscribe({
      next: (rows) => {
        this.proxyTargets = rows || [];
        this.cdr.markForCheck();
      },
      error: () => {
        this.proxyTargets = [];
        this.cdr.markForCheck();
      }
    });
  }

}

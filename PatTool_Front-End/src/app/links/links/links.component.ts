import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit
} from '@angular/core';
import { debounceTime, take } from 'rxjs/operators';
import { Subject, Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Category } from '../../model/Category';
import { Member } from '../../model/member';
import { urllink } from '../../model/urllink';
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

  filteredLinksByCategoryId: Record<string, urllink[]> = {};
  categoryLinkCountById: Record<string, number> = {};
  linksByCategoryId: Record<string, urllink[]> = {};

  private langChangeSub?: Subscription;
  private searchInput$ = new Subject<void>();
  private searchDebounceSub?: Subscription;

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

    this.loading = true;
    const loadLinks = () => {
      this.user = this._memberService.getUser();
      this._urlLinkService.getLinksView(this.user).subscribe({
        next: (res) => {
          this.categories = res.categories ?? [];
          this.linksByCategoryId = res.linksByCategoryId ?? {};
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
    this.langChangeSub?.unsubscribe();
    this.searchDebounceSub?.unsubscribe();
  }

  /** Debounced — bind to search (input). */
  onSearchInput(): void {
    this.searchInput$.next();
  }

  /** Immediate — focus, clear, after picking a suggestion. */
  applySearchFromModel(): void {
    const term = this.searchFilter?.trim() ?? '';
    this.refreshFilteredLinks();

    if (term.length < 2) {
      this.searchSuggestions = [];
      this.showSuggestions = false;
      return;
    }

    const lower = term.toLowerCase();
    this.searchSuggestions = this.urllinks.filter(u => {
      if (!this.isVisible(u)) {
        return false;
      }
      const linkName = (u.linkName || '').toLowerCase();
      const linkDescription = (u.linkDescription || '').toLowerCase();
      return linkName.includes(lower) || linkDescription.includes(lower);
    }).slice(0, 10);

    this.showSuggestions = this.searchSuggestions.length > 0;
  }

  clearSearch(): void {
    this.searchFilter = '';
    this.applySearchFromModel();
    this.cdr.markForCheck();
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

  submitVisibilityChange(urllinkItem: urllink, event?: Event): void {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    const currentVisibility = urllinkItem.visibility || 'public';

    if (currentVisibility === 'public') {
      urllinkItem.visibility = 'private';
    } else if (currentVisibility === 'private') {
      urllinkItem.visibility = 'friends';
    } else {
      urllinkItem.visibility = 'public';
    }

    this._urlLinkService.updateVisibility(urllinkItem).subscribe({
      next: () => {
        this.refreshFilteredLinks();
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('An error occurred while updating visibility', err);
        urllinkItem.visibility = currentVisibility;
        this.cdr.markForCheck();
      }
    });
  }

  canEdit(u: urllink): boolean {
    return u.author?.id === this.user.id;
  }

  isVisible(u: urllink): boolean {
    if (!u?.author) {
      return false;
    }
    return u.author.id === this.user.id || u.visibility === 'public' || u.visibility === 'friends';
  }

  refreshFilteredLinks(): void {
    const countById: Record<string, number> = {};
    const linksById: Record<string, urllink[]> = {};
    const term = this.searchFilter?.trim();

    for (const c of this.categories) {
      const id = c.categoryLinkID;
      const visibleLinks = this.linksByCategoryId[id] ?? [];
      countById[id] = visibleLinks.length;
      if (term) {
        const lower = term.toLowerCase();
        linksById[id] = visibleLinks.filter(u => {
          const linkName = (u.linkName || '').toLowerCase();
          const linkDescription = (u.linkDescription || '').toLowerCase();
          return linkName.includes(lower) || linkDescription.includes(lower);
        });
      } else {
        linksById[id] = visibleLinks;
      }
    }
    this.categoryLinkCountById = countById;
    this.filteredLinksByCategoryId = linksById;
  }

  isCategoryVisible(_category: Category): boolean {
    return true;
  }

  selectSuggestion(suggestion: urllink): void {
    if (this.openUrlOnClick) {
      window.open(String(suggestion.url), '_blank');
    }

    const categoryIndex = this.categories.findIndex(c => c.categoryLinkID === suggestion.categoryLinkID);

    if (categoryIndex !== -1) {
      this.expandedCategoryIndex = categoryIndex;
      this.searchFilter = '';
      this.showSuggestions = false;
      this.searchSuggestions = [];
      this.refreshFilteredLinks();
    }
    this.cdr.markForCheck();
  }

  hideSuggestions(): void {
    setTimeout(() => {
      this.showSuggestions = false;
      this.cdr.markForCheck();
    }, 200);
  }

  getCategoryName(categoryLinkID: string): string {
    const category = this.categories.find(c => c.categoryLinkID === categoryLinkID);
    return category ? String(category.categoryName) : '';
  }

  toggleCategory(categoryIndex: number): void {
    if (this.expandedCategoryIndex === categoryIndex) {
      this.expandedCategoryIndex = null;
    } else {
      this.expandedCategoryIndex = categoryIndex;
    }
    this.cdr.markForCheck();
  }

  isCategoryExpanded(categoryIndex: number): boolean {
    return this.expandedCategoryIndex === categoryIndex;
  }

  trackByCategoryId(_index: number, c: Category): string {
    return c.categoryLinkID;
  }

  trackByLinkId(_index: number, u: urllink): string {
    return u.id ?? `${u.url}-${u.linkName}`;
  }

  trackBySuggestion(_index: number, u: urllink): string {
    return this.trackByLinkId(_index, u);
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

}

import { Component, OnInit } from '@angular/core';
import { take } from 'rxjs/operators';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Category } from '../../model/Category';
import { Member } from '../../model/member';
import { urllink } from '../../model/urllink';
import { CommonvaluesService } from '../../services/commonvalues.service';
import { MembersService } from '../../services/members.service';
import { UrllinkService } from '../../services/urllink.service';
import { NavigationButtonsModule } from '../../shared/navigation-buttons/navigation-buttons.module';

@Component({
  selector: 'app-links',
  templateUrl: './links.component.html',
  styleUrls: ['./links.component.css'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    TranslateModule,
    NavigationButtonsModule
  ]
})
export class LinksComponent implements OnInit {

  public urllinks: urllink[] = [];
  public categories: Category[] = [];
  public user: Member = this._memberService.getUser();
  public expandedCategoryIndex: number | null = null;
  public searchFilter: string = '';
  public searchSuggestions: urllink[] = [];
  public showSuggestions: boolean = false;
  public openUrlOnClick: boolean = true;
  public loading: boolean = true;

  /** Pre-computed for template: categoryLinkID -> list of filtered links (category + visible + search). */
  filteredLinksByCategoryId: Record<string, urllink[]> = {};
  /** Pre-computed for template: categoryLinkID -> count of visible links (category + visible, no search). */
  categoryLinkCountById: Record<string, number> = {};
  /** Links grouped by category from backend (single GET). Used by refreshFilteredLinks. */
  linksByCategoryId: Record<string, urllink[]> = {};

  constructor(private _memberService: MembersService, private _urlLinkService: UrllinkService, private _commonValuesService: CommonvaluesService, private router: Router) { }

  ngOnInit() {
    this.loading = true;
    const loadLinks = () => {
      this.user = this._memberService.getUser();
      this._urlLinkService.getLinksView(this.user).subscribe({
        next: (res) => {
          this.categories = res.categories ?? [];
          this.linksByCategoryId = res.linksByCategoryId ?? {};
          this.urllinks = Object.values(this.linksByCategoryId).flat();
          this.refreshFilteredLinks();
          this.loading = false;
        },
        error: (err) => {
          alert('Error loading links: ' + err);
          this.loading = false;
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

  submitVisibilityChange(urllink: any, event?: Event) {
    // Prevent any default behavior and stop propagation
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    
    // Cycle through visibility: public -> private -> friends -> public
    // Handle null/undefined as public (default)
    const currentVisibility = urllink.visibility || 'public';
    
    if (currentVisibility === 'public') {
      urllink.visibility = 'private';
    } else if (currentVisibility === 'private') {
      urllink.visibility = 'friends';
    } else {
      // friends or any other value -> public
      urllink.visibility = 'public';
    }

    // Call your service to update the visibility in the database
    this._urlLinkService.updateVisibility(urllink).subscribe(
      response => {
        this.refreshFilteredLinks();
        console.log('Visibility updated to:', urllink.visibility);
      },
      error => {
        console.error('An error occurred while updating visibility', error);
        // Revert on error
        urllink.visibility = currentVisibility;
        // Don't navigate on error - just show error in console
      }
    );
    
    // Explicitly return false to prevent any navigation
    return false;
  }

  canEdit(u: urllink): boolean {
    return u.author.id === this.user.id;
  }

  isVisible(u: urllink): boolean {
    if (!u || !u.author) {
      return false;
    }
    // Backend already filters links, so if a link is in the list, it's visible
    // This is just a safety check - links with friends visibility are already filtered by backend
    return u.author.id === this.user.id || u.visibility === 'public' || u.visibility === 'friends';
  }

  getCategoryLinks(category: Category): urllink[] {
    const filtered = this.urllinks.filter(u => {
      const categoryMatch = u.categoryLinkID === category.categoryLinkID;
      const visible = this.isVisible(u);
      const matchesSearch = this.matchesSearchFilter(u);
      return categoryMatch && visible && matchesSearch;
    });
    return filtered;
  }

  getCategoryLinksCount(category: Category): number {
    // Count all visible links in this category (not filtered by search)
    return this.urllinks.filter(u => {
      const categoryMatch = u.categoryLinkID === category.categoryLinkID;
      const visible = this.isVisible(u);
      return categoryMatch && visible;
    }).length;
  }

  /** Recompute filtered links and counts; call when linksByCategoryId, categories, or searchFilter change. */
  refreshFilteredLinks(): void {
    const countById: Record<string, number> = {};
    const linksById: Record<string, urllink[]> = {};
    for (const c of this.categories) {
      const id = c.categoryLinkID;
      const visibleLinks = this.linksByCategoryId[id] ?? [];
      countById[id] = visibleLinks.length;
      linksById[id] = this.searchFilter?.trim()
        ? visibleLinks.filter(u => this.matchesSearchFilter(u))
        : visibleLinks;
    }
    this.categoryLinkCountById = countById;
    this.filteredLinksByCategoryId = linksById;
  }

  isCategoryVisible(category: Category): boolean {
    // Categories are already filtered by the backend
    // Just return true for all categories received
    return true;
  }

  matchesSearchFilter(link: urllink): boolean {
    if (!this.searchFilter || !this.searchFilter.trim()) {
      return true;
    }
    
    const searchTerm = this.searchFilter.toLowerCase().trim();
    const linkName = (link.linkName || '').toLowerCase();
    const linkDescription = (link.linkDescription || '').toLowerCase();
    
    // Recherche sur le nom ET la description
    return linkName.includes(searchTerm) || linkDescription.includes(searchTerm);
  }

  onSearchChange(): void {
    // This method will be called when the search input changes
    this.refreshFilteredLinks();

    if (!this.searchFilter || this.searchFilter.trim().length < 2) {
      this.searchSuggestions = [];
      this.showSuggestions = false;
      return;
    }
    
    // Generate suggestions
    this.searchSuggestions = this.urllinks.filter(u => {
      const isVisible = this.isVisible(u);
      const matchesFilter = this.matchesSearchFilter(u);
      return isVisible && matchesFilter;
    }).slice(0, 10); // Limit to 10 suggestions
    
    this.showSuggestions = this.searchSuggestions.length > 0;
  }

  selectSuggestion(suggestion: urllink): void {
    // Open the URL in a new tab only if checkbox is checked
    if (this.openUrlOnClick) {
      window.open(String(suggestion.url), '_blank');
    }
    
    // Find the category index for this link
    const categoryIndex = this.categories.findIndex(c => c.categoryLinkID === suggestion.categoryLinkID);
    
    if (categoryIndex !== -1) {
      // Open the corresponding card
      this.expandedCategoryIndex = categoryIndex;
      // Clear search
      this.searchFilter = '';
      this.showSuggestions = false;
      this.searchSuggestions = [];
    }
  }

  hideSuggestions(): void {
    // Delay hiding to allow click events to fire
    setTimeout(() => {
      this.showSuggestions = false;
    }, 200);
  }

  getCategoryName(categoryLinkID: string): string {
    const category = this.categories.find(c => c.categoryLinkID === categoryLinkID);
    return category ? String(category.categoryName) : '';
  }

  toggleCategory(categoryIndex: number): void {
    if (this.expandedCategoryIndex === categoryIndex) {
      // Si la catégorie est déjà ouverte, la fermer
      this.expandedCategoryIndex = null;
    } else {
      // Ouvrir cette catégorie et fermer toutes les autres
      this.expandedCategoryIndex = categoryIndex;
    }
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

  /** Returns translation key for category name if one exists, otherwise the raw name (displayed as-is). */
  getCategoryTranslationKey(categoryName: string): string {
    const normalizedName = (categoryName || '').trim().toLowerCase();
    const keyMap: { [key: string]: string } = {
      'administratif': 'LINKS.CATEGORIES.ADMINISTRATIF'
    };
    return keyMap[normalizedName] || categoryName || '';
  }

  getCategoryIcon(categoryName: string): string {
    // Normalize the category name (trim whitespace and convert to lowercase for comparison)
    const normalizedName = categoryName ? categoryName.trim().toLowerCase() : '';
    
    const iconMap: { [key: string]: string } = {
      'administratif': 'fa-file-text-o',
      'commerce': 'fa-shopping-cart',
      'finance': 'fa-money',
      'ia': 'fa-cogs',
      'ai': 'fa-cogs',
      'intelligence artificielle': 'fa-cogs',
      'artificial intelligence': 'fa-cogs',
      'it': 'fa-laptop',
      'it knowledge': 'fa-graduation-cap',
      'iot': 'fa-microchip',
      'internet of things': 'fa-microchip',
      'languages': 'fa-language',
      'langues': 'fa-language',
      'maison': 'fa-home',
      'home': 'fa-home',
      'media': 'fa-play-circle',
      'méditation': 'fa-leaf',
      'meditation': 'fa-leaf',
      'photo': 'fa-camera',
      'photography': 'fa-camera',
      'privé': 'fa-lock',
      'private': 'fa-lock',
      'professional': 'fa-briefcase',
      'professionnel': 'fa-briefcase',
      'social media': 'fa-share-alt',
      'sport': 'fa-trophy',
      'sports': 'fa-trophy'
    };
    
    const icon = iconMap[normalizedName] || 'fa-folder';
    
    return icon;
  }

  navigateToLinksAdmin(): void {
    this.router.navigate(['links-admin']);
  }

}

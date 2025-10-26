import { Component, OnInit } from '@angular/core';
import { Category } from '../../model/Category';
import { Member } from '../../model/member';
import { urllink } from '../../model/urllink';
import { CommonvaluesService } from '../../services/commonvalues.service';
import { MembersService } from '../../services/members.service';
import { UrllinkService } from '../../services/urllink.service';

@Component({
  selector: 'app-links',
  templateUrl: './links.component.html',
  styleUrls: ['./links.component.css']
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

  constructor(private _memberService: MembersService, private _urlLinkService: UrllinkService, private _commonValuesService: CommonvaluesService) { }

  ngOnInit() {
    // to get urls when user.id is not empty
    this.waitForNonEmptyValue().then(() => {
      let now = new Date();

      this._urlLinkService
        .getLinks(this.user)
        .subscribe(ulks => {
          //alert(JSON.stringify(ulks));
          this.urllinks = ulks;
        }
          , err => alert("Error getting urllink" + err));

      // to get Categories - INSIDE waitForNonEmptyValue so user.id is set
      this._urlLinkService
        .getCategories(this.user)
        .subscribe(categ => {
          this.categories = categ;
        }
          , err => alert("Error getting Category" + err));
    });
  }

  private waitForNonEmptyValue(): Promise<void> {
    return new Promise<void>((resolve) => {
      const checkValue = () => {
        if (this.user.id !== "") {
          resolve();
        } else {
          let now = new Date();
          setTimeout(checkValue, 100); // Appeler checkValue de manière récursive après 100ms
        }
      };
      checkValue(); // Déclencher la première vérification
    });
  }

  submitVisibilityChange(urllink: any) {
    // Convert the visibility to 'public' or 'private'
    urllink.visibility = urllink.visibility === 'public' ? 'private' : 'public';

    // Call your service to update the visibility in the database
    this._urlLinkService.updateVisibility(urllink).subscribe(
      response => {
      },
      error => {
        console.error('An error occurred while updating visibility', error);
      }
    );
  }

  canEdit(u: urllink): boolean {
    return u.author.id === this.user.id;
  }

  isVisible(u: urllink): boolean {
    let v = u.author.id === this.user.id || u.visibility === 'public';
    return v;
  }

  getCategoryLinks(category: Category): urllink[] {
    return this.urllinks.filter(u => u.categoryLinkID === category.categoryLinkID && this.isVisible(u) && this.matchesSearchFilter(u));
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
    
    // Recherche simple et efficace
    return linkName.includes(searchTerm);
  }

  onSearchChange(): void {
    // This method will be called when the search input changes
    
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

}

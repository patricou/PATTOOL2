import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { take } from 'rxjs/operators';
import { Category } from '../../model/Category';
import { urllink } from '../../model/urllink';
import { Member } from '../../model/member';
import { UrllinkService } from '../../services/urllink.service';
import { MembersService } from '../../services/members.service';
import { NavigationButtonsModule } from '../../shared/navigation-buttons/navigation-buttons.module';

@Component({
  selector: 'app-links-admin',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, TranslateModule, NavigationButtonsModule],
  providers: [UrllinkService],
  templateUrl: './links-admin.component.html',
  styleUrls: ['./links-admin.component.css']
})
export class LinksAdminComponent implements OnInit {

  // Categories
  public categories: Category[] = [];
  public selectedCategory: Category | null = null;
  public newCategory: Category = new Category('', '', '', '', new Member("", "", "", "", "", [], ""), 'public');
  public isEditingCategory: boolean = false;

  private createNewCategory(): Category {
    return new Category('', '', '', '', this.getPatricouMember(), 'public');
  }

  // UrlLinks
  public urllinks: urllink[] = [];
  public selectedUrllink: urllink | null = null;
  public newUrllink: urllink = new urllink('', '', '', '', '', '', 'public', new Member("", "", "", "", "", [], ""));
  public isEditingUrllink: boolean = false;

  public user: Member = this._memberService.getUser();
  public activeTab: 'categories' | 'links' = 'links';

  // Sorting state
  public categorySortColumn: string | null = null;
  public categorySortDirection: 'asc' | 'desc' = 'asc';
  public linkSortColumn: string | null = null;
  public linkSortDirection: 'asc' | 'desc' = 'asc';

  // Filter state
  public categoryFilter: string = '';
  public linkFilter: string = '';

  // JSON display state
  public showJSONModal: boolean = false;
  public categoriesJSON: string = '';
  public urllinksJSON: string = '';
  public loading: boolean = true;

  /** O(1) category labels for table cells (avoid repeated find() per row per CD cycle). */
  private categoryNameByLinkId: Record<string, string> = {};

  /** Precomputed table rows — do not call filter/sort getters from the template. */
  public visibleLinks: urllink[] = [];
  public displayCategories: Category[] = [];

  constructor(
    private _urlLinkService: UrllinkService,
    private _memberService: MembersService
  ) { }

  ngOnInit(): void {
    this.loading = true;
    const load = (): void => {
      this.user = this._memberService.getUser();
      this._urlLinkService.getLinksView(this.user).subscribe({
        next: (res) => {
          this.applyLinksViewPayload(res);
          this.newCategory = this.createNewCategory();
          this.loading = false;
        },
        error: (err) => {
          alert('Error loading links administration: ' + err);
          this.loading = false;
        }
      });
    };

    if (this._memberService.getUser().id) {
      load();
    } else {
      this._memberService.getUserId({ skipGeolocation: true }).pipe(take(1)).subscribe({
        next: () => load(),
        error: () => load()
      });
    }
  }

  private applyLinksViewPayload(res: {
    categories: Category[];
    linksByCategoryId: Record<string, urllink[]>;
  }): void {
    this.categories = res.categories ?? [];
    this.urllinks = Object.values(res.linksByCategoryId ?? {}).flat();
    this.rebuildCategoryNameMap();
    this.rebuildDisplayCategories();
    this.rebuildVisibleLinks();
  }

  private refreshFromLinksView(): void {
    this.user = this._memberService.getUser();
    this._urlLinkService.getLinksView(this.user).subscribe({
      next: (res) => this.applyLinksViewPayload(res),
      error: (err) => alert('Error loading data: ' + err)
    });
  }

  private rebuildCategoryNameMap(): void {
    const m: Record<string, string> = {};
    for (const c of this.categories) {
      if (c.categoryLinkID) {
        m[c.categoryLinkID] = c.categoryName || '';
      }
    }
    this.categoryNameByLinkId = m;
  }

  onLinkFilterChange(): void {
    this.rebuildVisibleLinks();
  }

  onCategoryFilterChange(): void {
    this.rebuildDisplayCategories();
  }

  // ==================== CATEGORIES ====================

  loadCategories() {
    this.refreshFromLinksView();
  }

  createCategory() {
    if (!this.newCategory.categoryName) {
      alert("Veuillez remplir le nom de la catégorie");
      return;
    }

    // Set author to patricou
    this.newCategory.author = this.getPatricouMember();

    this._urlLinkService.createCategory(this.newCategory).subscribe(
      response => {
        alert("Catégorie créée avec succès");
        this.loadCategories();
        this.newCategory = this.createNewCategory();
      },
      error => alert("Erreur lors de la création de la catégorie: " + error)
    );
  }

  editCategory(category: Category) {
    this.selectedCategory = { ...category };
    this.isEditingCategory = true;
  }

  updateCategory() {
    if (!this.selectedCategory) return;

    this._urlLinkService.updateCategory(this.selectedCategory.id, this.selectedCategory).subscribe(
      response => {
        alert("Catégorie mise à jour avec succès");
        this.loadCategories();
        this.cancelEditCategory();
      },
      error => alert("Erreur lors de la mise à jour de la catégorie: " + error)
    );
  }

  deleteCategory(category: Category) {
    if (confirm(`Êtes-vous sûr de vouloir supprimer la catégorie "${category.categoryName}" ?`)) {
      this._urlLinkService.deleteCategory(category.id).subscribe(
        response => {
          alert("Catégorie supprimée avec succès");
          this.loadCategories();
        },
        error => {
          let errorMessage = "Erreur lors de la suppression de la catégorie";
          if (error.error) {
            // The backend returns the error message in error.error
            errorMessage = error.error;
          } else if (error.message) {
            errorMessage = error.message;
          }
          alert(errorMessage);
        }
      );
    }
  }

  cancelEditCategory() {
    this.selectedCategory = null;
    this.isEditingCategory = false;
  }

  // ==================== URLLINKS ====================

  loadLinks() {
    this.refreshFromLinksView();
  }

  createUrllink() {
    if (!this.newUrllink.linkName || !this.newUrllink.url) {
      alert("Veuillez remplir tous les champs obligatoires");
      return;
    }

    // Set author
    this.newUrllink.author = this.user;

    this._urlLinkService.createUrlLink(this.newUrllink).subscribe(
      response => {
        alert("Lien créé avec succès");
        this.loadLinks();
        this.newUrllink = new urllink('', '', '', '', '', '', 'public', this.user);
      },
      error => alert("Erreur lors de la création du lien: " + error)
    );
  }

  editUrllink(link: urllink) {
    this.selectedUrllink = { ...link, openByProxyLan: link.openByProxyLan === true };
    this.isEditingUrllink = true;
  }

  updateUrllink() {
    if (!this.selectedUrllink) return;

    this._urlLinkService.updateUrlLink(this.selectedUrllink.id, this.selectedUrllink).subscribe(
      response => {
        alert("Lien mis à jour avec succès");
        this.loadLinks();
        this.cancelEditUrllink();
      },
      error => alert("Erreur lors de la mise à jour du lien: " + error)
    );
  }

  deleteUrllink(link: urllink) {
    if (confirm(`Êtes-vous sûr de vouloir supprimer le lien "${link.linkName}" ?`)) {
      this._urlLinkService.deleteUrlLink(link.id).subscribe(
        response => {
          alert("Lien supprimé avec succès");
          this.loadLinks();
        },
        error => alert("Erreur lors de la suppression du lien: " + error)
      );
    }
  }

  cancelEditUrllink() {
    this.selectedUrllink = null;
    this.isEditingUrllink = false;
  }

  // ==================== UI HELPERS ====================

  getCategoryName(categoryLinkID: string): string {
    if (!categoryLinkID) {
      return '';
    }
    return this.categoryNameByLinkId[categoryLinkID] ?? '';
  }

  trackByLinkRow(_index: number, link: urllink): string {
    return link.id || link.urlLinkID || String(_index);
  }

  trackByCategoryRow(_index: number, category: Category): string {
    return category.id || category.categoryLinkID || String(_index);
  }

  setActiveTab(tab: 'categories' | 'links') {
    this.activeTab = tab;
  }

  // Check if a link is visible to the current user
  isLinkVisible(link: urllink): boolean {
    // Backend already filters links, so if a link is in the list, it's visible
    // This is just for display purposes in admin - show all links user can see
    return link.author?.id === this.user.id || link.visibility === 'public' || link.visibility === 'friends';
  }

  private rebuildVisibleLinks(): void {
    let list = this.urllinks.filter(link => this.isLinkVisible(link));

    if (this.linkFilter) {
      const filterLower = this.linkFilter.toLowerCase();
      list = list.filter(link =>
        (link.linkName && link.linkName.toLowerCase().includes(filterLower)) ||
        (link.linkDescription && link.linkDescription.toLowerCase().includes(filterLower)) ||
        (link.url && link.url.toLowerCase().includes(filterLower)) ||
        (this.categoryNameByLinkId[link.categoryLinkID || ''] || '').toLowerCase().includes(filterLower)
      );
    }

    if (this.linkSortColumn) {
      list = [...list].sort((a, b) => {
        let aValue: any;
        let bValue: any;

        switch (this.linkSortColumn) {
          case 'id':
            aValue = a.urlLinkID || '';
            bValue = b.urlLinkID || '';
            const aNum = Number(aValue);
            const bNum = Number(bValue);
            if (!isNaN(aNum) && !isNaN(bNum)) {
              aValue = aNum;
              bValue = bNum;
            }
            break;
          case 'name':
            aValue = a.linkName || '';
            bValue = b.linkName || '';
            break;
          case 'description':
            aValue = a.linkDescription || '';
            bValue = b.linkDescription || '';
            break;
          case 'url':
            aValue = a.url || '';
            bValue = b.url || '';
            break;
          case 'category':
            aValue = this.categoryNameByLinkId[a.categoryLinkID || ''] || '';
            bValue = this.categoryNameByLinkId[b.categoryLinkID || ''] || '';
            break;
          case 'visibility':
            aValue = a.visibility || '';
            bValue = b.visibility || '';
            break;
          case 'openByProxyLan':
            aValue = a.openByProxyLan === true ? 1 : 0;
            bValue = b.openByProxyLan === true ? 1 : 0;
            break;
          case 'author':
            aValue = a.author?.userName || '';
            bValue = b.author?.userName || '';
            break;
          default:
            return 0;
        }

        if (aValue < bValue) return this.linkSortDirection === 'asc' ? -1 : 1;
        if (aValue > bValue) return this.linkSortDirection === 'asc' ? 1 : -1;
        return 0;
      });
    }

    this.visibleLinks = list;
  }

  private rebuildDisplayCategories(): void {
    let list = this.categories;

    if (this.categoryFilter) {
      const filterLower = this.categoryFilter.toLowerCase();
      list = this.categories.filter(category =>
        (category.categoryName && category.categoryName.toLowerCase().includes(filterLower)) ||
        (category.categoryDescription && category.categoryDescription.toLowerCase().includes(filterLower))
      );
    }

    if (this.categorySortColumn) {
      list = [...list].sort((a, b) => {
        let aValue: any;
        let bValue: any;

        switch (this.categorySortColumn) {
          case 'id':
            aValue = a.categoryLinkID || '';
            bValue = b.categoryLinkID || '';
            const aNum = Number(aValue);
            const bNum = Number(bValue);
            if (!isNaN(aNum) && !isNaN(bNum)) {
              aValue = aNum;
              bValue = bNum;
            }
            break;
          case 'name':
            aValue = a.categoryName || '';
            bValue = b.categoryName || '';
            break;
          case 'description':
            aValue = a.categoryDescription || '';
            bValue = b.categoryDescription || '';
            break;
          default:
            return 0;
        }

        if (aValue < bValue) return this.categorySortDirection === 'asc' ? -1 : 1;
        if (aValue > bValue) return this.categorySortDirection === 'asc' ? 1 : -1;
        return 0;
      });
    }

    this.displayCategories = list;
  }

  // ==================== SORTING ====================

  sortCategories(column: string) {
    if (this.categorySortColumn === column) {
      this.categorySortDirection = this.categorySortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.categorySortColumn = column;
      this.categorySortDirection = 'asc';
    }
    this.rebuildDisplayCategories();
  }

  sortLinks(column: string) {
    if (this.linkSortColumn === column) {
      this.linkSortDirection = this.linkSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.linkSortColumn = column;
      this.linkSortDirection = 'asc';
    }
    this.rebuildVisibleLinks();
  }

  getSortIcon(table: 'categories' | 'links', column: string): string {
    const sortColumn = table === 'categories' ? this.categorySortColumn : this.linkSortColumn;
    const sortDirection = table === 'categories' ? this.categorySortDirection : this.linkSortDirection;

    if (sortColumn === column) {
      return sortDirection === 'asc' ? 'fa-sort-up' : 'fa-sort-down';
    }
    return 'fa-sort';
  }

  isSortedColumn(table: 'categories' | 'links', column: string): boolean {
    const sortColumn = table === 'categories' ? this.categorySortColumn : this.linkSortColumn;
    return sortColumn === column;
  }

  // Get patricou member for author field
  getPatricouMember(): Member {
    return new Member(
      this.user.id || "patricou-id",
      "patricou@example.com",
      "Patricou",
      "Author",
      "patricou",
      [],
      "patricou-keycloak-id"
    );
  }

  // Check if current user can edit a category
  canEditCategory(category: Category): boolean {
    // If category has no author (old categories), allow editing
    if (!category.author) {
      return true;
    }
    // Only the author can edit their own category
    return category.author.id === this.user.id;
  }

  // Display categories as JSON
  showCategoriesJSON(): void {
    this.categoriesJSON = JSON.stringify(this.categories, null, 2);
    this.showJSONModal = true;
    // Prevent body scrolling when modal is open
    document.body.style.overflow = 'hidden';
    console.log('Categories JSON:', this.categories);
  }

  closeJSONModal(): void {
    this.showJSONModal = false;
    this.categoriesJSON = '';
    this.urllinksJSON = '';
    // Restore body scrolling
    document.body.style.overflow = 'auto';
  }

  copyToClipboard(): void {
    // Determine which JSON to copy based on which modal is open
    const jsonToCopy = this.categoriesJSON || this.urllinksJSON;
    
    // Create a temporary textarea element
    const textarea = document.createElement('textarea');
    textarea.value = jsonToCopy;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    
    // Select and copy the text
    textarea.select();
    textarea.setSelectionRange(0, 99999); // For mobile devices
    
    try {
      const successful = document.execCommand('copy');
      if (successful) {
        alert('JSON copied to clipboard!');
      } else {
        alert('Failed to copy to clipboard');
      }
    } catch (err) {
      console.error('Failed to copy:', err);
      alert('Failed to copy to clipboard');
    }
    
    // Clean up
    document.body.removeChild(textarea);
  }

  // Display urllinks as JSON
  showUrllinksJSON(): void {
    this.urllinksJSON = JSON.stringify(this.urllinks, null, 2);
    this.showJSONModal = true;
    // Prevent body scrolling when modal is open
    document.body.style.overflow = 'hidden';
    console.log('Urllinks JSON:', this.urllinks);
  }
}

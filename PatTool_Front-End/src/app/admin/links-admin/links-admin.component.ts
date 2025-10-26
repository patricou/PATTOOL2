import { Component, OnInit } from '@angular/core';
import { Category } from '../../model/Category';
import { urllink } from '../../model/urllink';
import { Member } from '../../model/member';
import { UrllinkService } from '../../services/urllink.service';
import { MembersService } from '../../services/members.service';

@Component({
  selector: 'app-links-admin',
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

  constructor(
    private _urlLinkService: UrllinkService,
    private _memberService: MembersService
  ) { }

  ngOnInit() {
    this.waitForNonEmptyValue().then(() => {
      this.loadCategories();
      this.loadLinks();
      // Initialize newCategory with patricou author
      this.newCategory = this.createNewCategory();
    });
  }

  private waitForNonEmptyValue(): Promise<void> {
    return new Promise<void>((resolve) => {
      const checkValue = () => {
        if (this.user.id !== "") {
          resolve();
        } else {
          setTimeout(checkValue, 100);
        }
      };
      checkValue();
    });
  }

  // ==================== CATEGORIES ====================

  loadCategories() {
    this._urlLinkService.getCategories(this.user).subscribe(
      categories => {
        this.categories = categories;
      },
      error => alert("Error getting categories: " + error)
    );
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
    this._urlLinkService.getLinks(this.user).subscribe(
      links => {
        this.urllinks = links;
      },
      error => alert("Error getting links: " + error)
    );
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
    this.selectedUrllink = { ...link };
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
    const category = this.categories.find(c => c.categoryLinkID === categoryLinkID);
    return category ? category.categoryName : '';
  }

  setActiveTab(tab: 'categories' | 'links') {
    this.activeTab = tab;
  }

  // Check if a link is visible to the current user
  isLinkVisible(link: urllink): boolean {
    return link.author.id === this.user.id || link.visibility === 'public';
  }

  // Get all visible links
  getVisibleLinks(): urllink[] {
    let visibleLinks = this.urllinks.filter(link => this.isLinkVisible(link));
    
    // Apply filter if set
    if (this.linkFilter) {
      const filterLower = this.linkFilter.toLowerCase();
      visibleLinks = visibleLinks.filter(link => 
        (link.linkName && link.linkName.toLowerCase().includes(filterLower)) ||
        (link.linkDescription && link.linkDescription.toLowerCase().includes(filterLower)) ||
        (link.url && link.url.toLowerCase().includes(filterLower)) ||
        (this.getCategoryName(link.categoryLinkID) && this.getCategoryName(link.categoryLinkID).toLowerCase().includes(filterLower))
      );
    }
    
    // Apply sorting if a sort column is set
    if (this.linkSortColumn) {
      return [...visibleLinks].sort((a, b) => {
        let aValue: any;
        let bValue: any;
        let isNumeric = false;

        switch(this.linkSortColumn) {
          case 'id':
            aValue = a.urlLinkID || '';
            bValue = b.urlLinkID || '';
            // Check if values are numeric
            const aNum = Number(aValue);
            const bNum = Number(bValue);
            isNumeric = !isNaN(aNum) && !isNaN(bNum);
            if (isNumeric) {
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
            aValue = this.getCategoryName(a.categoryLinkID) || '';
            bValue = this.getCategoryName(b.categoryLinkID) || '';
            break;
          case 'visibility':
            aValue = a.visibility || '';
            bValue = b.visibility || '';
            break;
          case 'author':
            aValue = a.author.userName || '';
            bValue = b.author.userName || '';
            break;
          default:
            return 0;
        }

        if (aValue < bValue) return this.linkSortDirection === 'asc' ? -1 : 1;
        if (aValue > bValue) return this.linkSortDirection === 'asc' ? 1 : -1;
        return 0;
      });
    }
    
    return visibleLinks;
  }

  // Get filtered categories
  getFilteredCategories(): Category[] {
    let filteredCategories = this.categories;
    
    // Apply filter if set
    if (this.categoryFilter) {
      const filterLower = this.categoryFilter.toLowerCase();
      filteredCategories = this.categories.filter(category => 
        (category.categoryName && category.categoryName.toLowerCase().includes(filterLower)) ||
        (category.categoryDescription && category.categoryDescription.toLowerCase().includes(filterLower))
      );
    }
    
    // Apply sorting if a sort column is set
    if (this.categorySortColumn) {
      return [...filteredCategories].sort((a, b) => {
        let aValue: any;
        let bValue: any;
        let isNumeric = false;

        switch(this.categorySortColumn) {
          case 'id':
            aValue = a.categoryLinkID || '';
            bValue = b.categoryLinkID || '';
            // Check if values are numeric
            const aNum = Number(aValue);
            const bNum = Number(bValue);
            isNumeric = !isNaN(aNum) && !isNaN(bNum);
            if (isNumeric) {
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
    
    return filteredCategories;
  }

  // ==================== SORTING ====================

  sortCategories(column: string) {
    if (this.categorySortColumn === column) {
      this.categorySortDirection = this.categorySortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.categorySortColumn = column;
      this.categorySortDirection = 'asc';
    }
    // The actual sorting is handled in getFilteredCategories()
  }

  sortLinks(column: string) {
    if (this.linkSortColumn === column) {
      this.linkSortDirection = this.linkSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.linkSortColumn = column;
      this.linkSortDirection = 'asc';
    }
    // The actual sorting is handled in getVisibleLinks()
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

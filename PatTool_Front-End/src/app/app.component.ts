import { Component, ElementRef, OnInit, ViewChild, HostListener } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateService, LangChangeEvent } from '@ngx-translate/core';
import { KeycloakService } from './keycloak/keycloak.service';
import { NgbModal, ModalDismissReasons } from '@ng-bootstrap/ng-bootstrap';
import { Member } from './model/member';
import { MembersService } from './services/members.service';
import { CommonvaluesService } from './services/commonvalues.service';
import { environment } from '../environments/environment';
import { FileService } from './services/file.service';

@Component({
    selector: 'app-root',
    templateUrl: './app.component.html',
    styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit {

    public user: Member = new Member("", "", "", "", "", [], "");
    public selectedFiles: File[] = [];
    public resultSaveOndisk: string = "";
    public isMenuCollapsed = true;
    public isLoading: boolean = false;
    public showEventsDropdown: boolean = false;
    public showIADropdown: boolean = false;
    public showToolsDropdown: boolean = false;
    public showLinksDropdown: boolean = false;
    public showLanguageSubmenu: boolean = false;
    public isDragOver: boolean = false;
    
    // Drag functionality for language selector
    public isDragging: boolean = false;
    public dragStartX: number = 0;
    public dragStartY: number = 0;
    public langSelectorRight: number = 0; // 0% du bord droit (collé au bord)
    public langSelectorTop: number = 50; // 50% de la hauteur de l'écran

    constructor(public _translate: TranslateService,
        public _kc: KeycloakService,
        public _membersService: MembersService,
        public _commonValuesServices: CommonvaluesService,
        public modalService: NgbModal,
        public _fileService: FileService,
        private router: Router) {
        this.selectedFiles = [];
    }

    ngOnInit() {
        this.getUserInfo();
        // init translator
        this._translate.addLangs(environment.langs);
        this._translate.setDefaultLang('fr');
        // set the lang stored in the commnValue service
        this._translate.use(this._commonValuesServices.getLang());
        // catch in all modules when lang is changed

        this._translate.onLangChange.subscribe((event: LangChangeEvent) => {
            this._commonValuesServices.setLang(event.lang);
            //console.log("Change language : " + event.lang + " / c.v.s. getLang : " + this._commonValuesServices.getLang());
        });
    }

    logout() {
        // this.member = undefined;
        this._kc.logout();
    }

    navigateToHome(event: Event): void {
        // Only navigate if no dropdowns are open and it's not a dropdown trigger
        if (!this.showEventsDropdown && !this.showIADropdown && !this.showToolsDropdown) {
            event.preventDefault();
            event.stopPropagation();
            this.router.navigate(['']);
        }
    }

    isAuthenticated(): boolean {
        return this._kc.getAuth().authenticated;
    }

    getUserInfo() {
        //Retrieve user info from Keycloak
        this.user = this._kc.getUserAsMember();
        // Retrive the MLAB user (member) id from MLAB
        this._membersService.setUser(this.user);
        //this.user = this._membersService.getUser();
        // the folowing add the user.id and return it through an Observanle
        let now = new Date();
        // console.log("0/1|------------------> UserId from AppComponent : " + now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds() + '.' + now.getMilliseconds());
        this._membersService.getUserId().subscribe(member => {
            // console.log("1/1|------------------> UserId from AppComponent ok : user.is :  " + member.id + " / " + now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds() + '.' + now.getMilliseconds());
            this.user.id = member.id;
            // reset the user in the service ( with id ) otherwyse it is not present ( which is strange )
            this._membersService.setUser(this.user);
        },
            err => alert("Error when retieving MLB user id " + err)
        );
    }
    // for modal chat
    public closeResult: string = "";

    public open(content: any) {
        this.resultSaveOndisk = "";

        this.modalService.open(content, { backdrop: 'static', keyboard: false }).result.then((result) => {
            this.closeResult = `Closed with: ${result}`;
        }, (reason) => {
            this.closeResult = `Dismissed ${this.getDismissReason(reason)}`;
        });
    }

    public getDismissReason(reason: any): string {
        if (reason === ModalDismissReasons.ESC) {
            return 'by pressing ESC';
        } else if (reason === ModalDismissReasons.BACKDROP_CLICK) {
            return 'by clicking on a backdrop';
        } else {
            return `with: ${reason}`;
        }
    }

    public sendEmail(email: string): void {
        window.open(`mailto:${email}`, '_blank');
    }

    onFilesSelected(event: any) {
        this.resultSaveOndisk = "";
        this.selectedFiles = Array.from(event.target.files);
    }

    formatFileSize(bytes: number): string {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    removeFile(index: number): void {
        if (this.selectedFiles && this.selectedFiles.length > index) {
            const newFiles = Array.from(this.selectedFiles);
            newFiles.splice(index, 1);
            this.selectedFiles = newFiles;
        }
    }

    clearFiles(): void {
        this.selectedFiles = [];
        this.resultSaveOndisk = "";
    }

    // Drag and Drop functionality
    onDragOver(event: DragEvent): void {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer!.dropEffect = 'copy';
        this.isDragOver = true;
    }

    onDragLeave(event: DragEvent): void {
        event.preventDefault();
        event.stopPropagation();
        this.isDragOver = false;
    }

    onFileDrop(event: DragEvent): void {
        event.preventDefault();
        event.stopPropagation();
        this.isDragOver = false;

        const files = event.dataTransfer?.files;
        if (files && files.length > 0) {
            this.selectedFiles = Array.from(files);
            this.resultSaveOndisk = "";
            // Clear the data transfer to prevent any further processing
            event.dataTransfer!.clearData();
        }
    }

    onFileSelectClick(event: Event): void {
        // Only trigger file input when clicking the button, not the entire drop zone
        event.preventDefault();
        event.stopPropagation();
        const fileInput = document.getElementById('fileInput') as HTMLInputElement;
        if (fileInput) {
            fileInput.click();
        }
    }

    onSubmit() {

        this.isLoading = true;
        this.resultSaveOndisk = ""


        if (this.selectedFiles.length === 0) {
            console.log('Aucun fichier sélectionné.');
            return;
        };

        const formData = new FormData();
        for (let file of this.selectedFiles) {
            console.log("File to upload:", file.name, "Size:", file.size, "Type:", file.type);
            formData.append('files', file, file.name);
        }
        
        // Debug: Log FormData contents
        console.log("FormData entries:");
        for (let pair of (formData as any).entries()) {
            console.log(pair[0] + ': ' + pair[1]);
        }


        this._fileService.postFileOnDisk(formData, this.user)
            .subscribe({
                next: (response: any) => {
                    console.log('|--> Upload successful : ', response);
                    this.isLoading = false;
                    this.resultSaveOndisk = response || "Upload OK.";
                },
                error: (error: any) => {
                    console.error('|--> Upload error details:');
                    console.error('Full error object:', error);
                    console.error('Error status:', error.status);
                    console.error('Error statusText:', error.statusText);
                    console.error('Error message:', error.message);
                    console.error('Error error:', error.error);
                    
                    this.isLoading = false;
                    
                    // Extract meaningful error message
                    let errorMessage = "Issue to Upload File(s).";
                    
                    if (error.status === 0) {
                        errorMessage = "Cannot connect to server. Please check if the backend service is running on localhost:8000";
                    } else if (error.status === 401) {
                        errorMessage = "Authentication failed. Please log in again.";
                    } else if (error.status === 403) {
                        errorMessage = "Access forbidden. You don't have permission to upload files.";
                    } else if (error.status === 404) {
                        errorMessage = "Upload endpoint not found. Please check the server configuration.";
                    } else if (error.status >= 500) {
                        errorMessage = "Server error. Please try again later.";
                    } else if (error.error && error.error.message) {
                        errorMessage = error.error.message;
                    } else if (error.message) {
                        errorMessage = error.message;
                    } else if (error.status) {
                        errorMessage = `HTTP Error ${error.status}: ${error.statusText || 'Unknown error'}`;
                    }
                    
                    this.resultSaveOndisk = errorMessage;
                }
            });
    }

    toggleEventsDropdown(event: Event): void {
        event.preventDefault();
        event.stopPropagation();
        this.showEventsDropdown = !this.showEventsDropdown;
        this.showIADropdown = false; // Close other dropdown
        this.showToolsDropdown = false; // Close other dropdown
        this.showLinksDropdown = false; // Close other dropdown
    }

    toggleIADropdown(event: Event): void {
        event.preventDefault();
        event.stopPropagation();
        this.showIADropdown = !this.showIADropdown;
        this.showEventsDropdown = false; // Close other dropdown
        this.showToolsDropdown = false; // Close other dropdown
        this.showLinksDropdown = false; // Close other dropdown
    }

    toggleLinksDropdown(event: Event): void {
        event.preventDefault();
        event.stopPropagation();
        this.showLinksDropdown = !this.showLinksDropdown;
        this.showEventsDropdown = false; // Close other dropdown
        this.showIADropdown = false; // Close other dropdown
        this.showToolsDropdown = false; // Close other dropdown
    }

    toggleToolsDropdown(event: Event): void {
        event.preventDefault();
        event.stopPropagation();
        this.showToolsDropdown = !this.showToolsDropdown;
        this.showEventsDropdown = false; // Close other dropdown
        this.showIADropdown = false; // Close other dropdown
        this.showLinksDropdown = false; // Close other dropdown
        if (!this.showToolsDropdown) {
            this.showLanguageSubmenu = false; // Close language submenu when tools dropdown closes
        }
    }

    onToolsMenuLeave(event: MouseEvent): void {
        const relatedTarget = event.relatedTarget as HTMLElement;
        const isOverLanguageSubmenu = relatedTarget?.closest('.language-submenu-list') || 
                                      relatedTarget?.closest('.dropdown-submenu');
        if (!isOverLanguageSubmenu) {
            this.showToolsDropdown = false;
            this.showLanguageSubmenu = false;
        }
    }

    toggleLanguageSubmenuOnClick(event: Event): void {
        event.preventDefault();
        event.stopPropagation();
        this.showToolsDropdown = true;
        this.showLanguageSubmenu = !this.showLanguageSubmenu;
        if (this.showLanguageSubmenu) {
            this.positionLanguageSubmenu();
        }
    }

    checkCloseLanguageSubmenu(event: MouseEvent): void {
        setTimeout(() => {
            const relatedTarget = event.relatedTarget as HTMLElement;
            const isOverLanguage = relatedTarget?.closest('.language-submenu-list') || 
                                  relatedTarget?.closest('.dropdown-submenu') ||
                                  relatedTarget?.id === 'languageSubmenu';
            const isOverTools = relatedTarget?.closest('#toolsDropdown') ||
                               relatedTarget?.closest('[aria-labelledby="toolsDropdown"]');
            if (!isOverLanguage && !isOverTools) {
                this.showLanguageSubmenu = false;
            }
        }, 100);
    }

    positionLanguageSubmenu(): void {
        setTimeout(() => {
            const submenuElement = document.querySelector('.language-submenu-list') as HTMLElement;
            const parentItem = document.querySelector('#languageSubmenu')?.closest('.dropdown-submenu') as HTMLElement;
            
            if (submenuElement && parentItem) {
                const parentRect = parentItem.getBoundingClientRect();
                
                // Check if parent is visible
                const parentComputed = window.getComputedStyle(parentItem);
                const toolsMenu = document.querySelector('[aria-labelledby="toolsDropdown"]') as HTMLElement;
                const toolsComputed = toolsMenu ? window.getComputedStyle(toolsMenu) : null;
                
                // Ensure Tools menu is visible
                if (toolsMenu && !toolsComputed?.display || toolsComputed?.display === 'none') {
                    toolsMenu.style.display = 'block';
                }
                
                // Move submenu to body to avoid parent overflow issues
                if (submenuElement.parentElement?.tagName !== 'BODY') {
                    document.body.appendChild(submenuElement);
                }
                
                // Calculate position relative to viewport
                const left = parentRect.right;
                const top = parentRect.top;
                
                // Apply all styles directly
                submenuElement.style.cssText = `
                    position: fixed !important;
                    left: ${left}px !important;
                    top: ${top}px !important;
                    z-index: 99999 !important;
                    display: block !important;
                    visibility: visible !important;
                    opacity: 1 !important;
                    pointer-events: auto !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    transform: none !important;
                    width: auto !important;
                    height: auto !important;
                `;
                
                // Force class
                submenuElement.classList.add('show');
                
                // Mark as visible
                submenuElement.setAttribute('data-visible', 'true');
            }
        }, 10);
    }

    getCountryCode(lang: string): string {
        const langToCountry: { [key: string]: string } = {
            'fr': 'fr',
            'en': 'gb',
            'es': 'es',
            'de': 'de',
            'it': 'it',
            'ar': 'sa',
            'cn': 'cn',
            'ru': 'ru',
            'jp': 'jp',
            'he': 'il',
            'el': 'gr',
            'in': 'in'
        };
        return langToCountry[lang.toLowerCase()] || lang.toLowerCase();
    }

    toggleMobileMenu(): void {
        this.isMenuCollapsed = !this.isMenuCollapsed;
        // Close dropdowns when toggling mobile menu
        this.showEventsDropdown = false;
        this.showIADropdown = false;
        this.showToolsDropdown = false;
        this.showLinksDropdown = false;
        this.showLanguageSubmenu = false;
    }

    closeDropdowns(): void {
        this.showEventsDropdown = false;
        this.showIADropdown = false;
        this.showToolsDropdown = false;
        this.showLinksDropdown = false;
        this.showLanguageSubmenu = false;
    }

    closeMenu(): void {
        this.isMenuCollapsed = true;
        this.closeDropdowns();
    }

    closeMenuOnly(): void {
        this.isMenuCollapsed = true;
        this.closeDropdowns();
    }

    @HostListener('document:click', ['$event'])
    onDocumentClick(event: Event): void {
        const target = event.target as HTMLElement;
        
        // Check if the click is inside any dropdown container or navbar
        const isEventsDropdown = target.closest('#eventsDropdown') || target.closest('[aria-labelledby="eventsDropdown"]');
        const isIADropdown = target.closest('#aiDropdown') || target.closest('[aria-labelledby="aiDropdown"]');
        const isLinksDropdown = target.closest('#linksDropdown') || target.closest('[aria-labelledby="linksDropdown"]');
        const isToolsDropdown = target.closest('#toolsDropdown') || target.closest('[aria-labelledby="toolsDropdown"]');
        const isAISubmenu = target.closest('.ai-submenu-list') || target.closest('[aria-labelledby="aiSubmenu"]');
        const isLanguageSubmenu = target.closest('.language-submenu-list') || target.closest('[aria-labelledby="languageSubmenu"]');
        const isNavbar = target.closest('.navbar');
        const isDropdownItem = target.closest('.dropdown-item');
        
        // If click is outside all dropdowns, navbar, and dropdown items, close them
        if (!isEventsDropdown && !isIADropdown && !isToolsDropdown && !isLinksDropdown && !isAISubmenu && !isLanguageSubmenu && !isNavbar && !isDropdownItem) {
            this.closeDropdowns();
        }
    }

    // Drag functionality for language selector
    onLangSelectorMouseDown(event: MouseEvent): void {
        this.isDragging = true;
        this.dragStartX = event.clientX - (window.innerWidth * (100 - this.langSelectorRight) / 100);
        this.dragStartY = event.clientY - (window.innerHeight * this.langSelectorTop / 100);
        event.preventDefault();
    }

    @HostListener('document:mousemove', ['$event'])
    onDocumentMouseMove(event: MouseEvent): void {
        if (this.isDragging) {
            this.langSelectorRight = ((window.innerWidth - (event.clientX - this.dragStartX)) / window.innerWidth) * 100;
            this.langSelectorTop = ((event.clientY - this.dragStartY) / window.innerHeight) * 100;
        }
    }

    @HostListener('document:mouseup', ['$event'])
    onDocumentMouseUp(event: MouseEvent): void {
        this.isDragging = false;
    }

}

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
        console.log("0/1|------------------> UserId from AppComponent : " + now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds() + '.' + now.getMilliseconds());
        this._membersService.getUserId().subscribe(member => {
            console.log("1/1|------------------> UserId from AppComponent ok : user.is :  " + member.id + " / " + now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds() + '.' + now.getMilliseconds());
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

        this.modalService.open(content).result.then((result) => {
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

    onFilesSelected(event: any) {
        this.resultSaveOndisk = "";
        this.selectedFiles = event.target.files;
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

        // Check if any of the selected files are images
        const imageFiles = this.selectedFiles.filter(file => this.isImageFile(file));
        
        if (imageFiles.length > 0) {
            // Ask user if they want to use the image as activity thumbnail
            const imageFile = imageFiles[0]; // Use first image file
            const useAsThumbnail = confirm(`Voulez-vous utiliser "${imageFile.name}" comme image de cette activité ?`);
            
            if (useAsThumbnail) {
                // Modify the filename to add "thumbnail" in the middle
                const modifiedFileName = this.addThumbnailToFileName(imageFile.name);
                console.log("Modified filename:", modifiedFileName);
                
                // Create a new File object with the modified name
                const modifiedFile = new File([imageFile], modifiedFileName, { type: imageFile.type });
                
                // Replace the original file in the array
                const fileIndex = this.selectedFiles.indexOf(imageFile);
                this.selectedFiles[fileIndex] = modifiedFile;
            }
        }

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
    }

    toggleIADropdown(event: Event): void {
        event.preventDefault();
        event.stopPropagation();
        this.showIADropdown = !this.showIADropdown;
        this.showEventsDropdown = false; // Close other dropdown
        this.showToolsDropdown = false; // Close other dropdown
    }

    toggleToolsDropdown(event: Event): void {
        event.preventDefault();
        event.stopPropagation();
        this.showToolsDropdown = !this.showToolsDropdown;
        this.showEventsDropdown = false; // Close other dropdown
        this.showIADropdown = false; // Close other dropdown
    }

    toggleMobileMenu(): void {
        this.isMenuCollapsed = !this.isMenuCollapsed;
        // Close dropdowns when toggling mobile menu
        this.showEventsDropdown = false;
        this.showIADropdown = false;
        this.showToolsDropdown = false;
    }

    closeDropdowns(): void {
        this.showEventsDropdown = false;
        this.showIADropdown = false;
        this.showToolsDropdown = false;
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
        const isToolsDropdown = target.closest('#toolsDropdown') || target.closest('[aria-labelledby="toolsDropdown"]');
        const isAISubmenu = target.closest('.ai-submenu-list') || target.closest('[aria-labelledby="aiSubmenu"]');
        const isNavbar = target.closest('.navbar');
        const isDropdownItem = target.closest('.dropdown-item');
        
        // If click is outside all dropdowns, navbar, and dropdown items, close them
        if (!isEventsDropdown && !isIADropdown && !isToolsDropdown && !isAISubmenu && !isNavbar && !isDropdownItem) {
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

    // Check if a file is an image
    private isImageFile(file: File): boolean {
        const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/bmp', 'image/webp', 'image/svg+xml'];
        return imageTypes.includes(file.type.toLowerCase());
    }

    // Add "thumbnail" to the middle of the filename
    private addThumbnailToFileName(originalName: string): string {
        const lastDotIndex = originalName.lastIndexOf('.');
        
        if (lastDotIndex === -1) {
            // No extension found, just add thumbnail at the end
            return originalName + '_thumbnail';
        }
        
        const nameWithoutExtension = originalName.substring(0, lastDotIndex);
        const extension = originalName.substring(lastDotIndex);
        
        // Add thumbnail in the middle of the name
        const middleIndex = Math.floor(nameWithoutExtension.length / 2);
        const modifiedName = nameWithoutExtension.substring(0, middleIndex) + 
                             'thumbnail' + 
                             nameWithoutExtension.substring(middleIndex) + 
                             extension;
        
        return modifiedName;
    }

}

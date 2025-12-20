import { Component, ElementRef, OnInit, ViewChild, HostListener, TemplateRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService, LangChangeEvent } from '@ngx-translate/core';
import { KeycloakService } from './keycloak/keycloak.service';
import { NgbModule, NgbModal, ModalDismissReasons } from '@ng-bootstrap/ng-bootstrap';
import { Member } from './model/member';
import { MembersService } from './services/members.service';
import { CommonvaluesService } from './services/commonvalues.service';
import { environment } from '../environments/environment';
import { FileService } from './services/file.service';
import * as piexif from 'piexifjs';

@Component({
    selector: 'app-root',
    templateUrl: './app.component.html',
    styleUrls: ['./app.component.css'],
    standalone: true,
    imports: [CommonModule, RouterModule, FormsModule, TranslateModule, NgbModule]
})
export class AppComponent implements OnInit {

    @ViewChild('usercontent') usercontent!: TemplateRef<any>;

    public user: Member = new Member("", "", "", "", "", [], "");
    public userRoles: string[] = []; // User roles from Keycloak
    public isLoadingRoles: boolean = false; // Loading state for roles
    public hasIotRole: boolean = false; // Check if user has Iot role for menu visibility
    public selectedFiles: File[] = [];
    public fileInfoMap: Map<string, { originalSize: number; compressedSize?: number; isCompressed: boolean }> = new Map();
    public resultSaveOndisk: string = "";
    public isMenuCollapsed = true;
    public isLoading: boolean = false;
    public showEventsDropdown: boolean = false;
    public showIADropdown: boolean = false;
    public showToolsDropdown: boolean = false;
    public showLinksDropdown: boolean = false;
    public showLanguageSubmenu: boolean = false;
    public showDocumentationSubmenu: boolean = false;
    public isDragOver: boolean = false;
    public compressImages: boolean = true; // Toggle for image compression (enabled by default)
    public isCompressing: boolean = false; // Track if compression is in progress
    public compressionStatus: string = ""; // Status message for compression
    public compressionProgress: { current: number; total: number; fileName: string } | null = null; // Compression progress
    public uploadProgress: { current: number; total: number; fileName: string } | null = null; // Upload progress
    public uploadResults: { success: number; failed: number; errors: string[] } = { success: 0, failed: 0, errors: [] }; // Upload results
    public filePreviewUrls: Map<string, string> = new Map(); // Store preview URLs for images
    
    // Share files properties
    public shareFiles: File[] = []; // Files to share
    public shareFilePreviewUrls: Map<string, string> = new Map(); // Store preview URLs for share images
    public shareFileInfoMap: Map<string, { originalSize: number; compressedSize?: number; isCompressed: boolean }> = new Map(); // Share file info
    public isSharing: boolean = false; // Track if sharing is in progress
    public shareStatus: string = ""; // Share status message
    public compressShareImages: boolean = true; // Toggle for image compression when sharing (enabled by default)
    public isCompressingShare: boolean = false; // Track if compression is in progress for sharing
    public shareCompressionProgress: { current: number; total: number; fileName: string } | null = null; // Share compression progress
    
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
        // Check Iot role for menu visibility
        this.checkIotRole();
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

    /**
     * Check if the current user has Iot role for menu visibility
     */
    checkIotRole(): void {
        // Check immediately
        this.hasIotRole = this._kc.hasIotRole();
        
        // Also check after a short delay in case Keycloak isn't fully initialized
        setTimeout(() => {
            this.hasIotRole = this._kc.hasIotRole();
        }, 500);
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
        // Check Iot role immediately from Keycloak
        this.hasIotRole = this._kc.hasIotRole();
        // Retrive the MLAB user (member) id from MLAB
        this._membersService.setUser(this.user);
        //this.user = this._membersService.getUser();
        // the folowing add the user.id and return it through an Observanle
        let now = new Date();
        // console.log("0/1|------------------> UserId from AppComponent : " + now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds() + '.' + now.getMilliseconds());
        this._membersService.getUserId().subscribe(member => {
            // console.log("1/1|------------------> UserId from AppComponent ok : user.is :  " + member.id + " / " + now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds() + '.' + now.getMilliseconds());
            this.user.id = member.id;
            // Update user object with member data (including roles)
            this.user = { ...this.user, ...member };
            // Parse roles from member if available (roles are stored as comma-separated string in backend)
            if ((member as any).roles) {
                const rolesStr = (member as any).roles;
                if (rolesStr && typeof rolesStr === 'string' && rolesStr.trim().length > 0) {
                    // Filter out UMA-related roles (uma_protection, uma_authorization)
                    this.userRoles = rolesStr.split(',').map((r: string) => r.trim()).filter((r: string) => 
                        r.length > 0 && r !== 'uma_protection' && r !== 'uma_authorization'
                    );
                } else if (Array.isArray(rolesStr)) {
                    // If roles is already an array, filter out UMA-related roles
                    this.userRoles = rolesStr.filter((r: string) => 
                        r && r !== 'uma_protection' && r !== 'uma_authorization'
                    );
                }
            }
            // Check Iot role again after user info is loaded (in case Keycloak wasn't ready)
            this.hasIotRole = this._kc.hasIotRole();
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
        
        // If opening user content modal, fetch roles
        if (content === this.usercontent) {
            this.loadUserRoles();
        }

        this.modalService.open(content, { backdrop: 'static', keyboard: false }).result.then((result) => {
            this.closeResult = `Closed with: ${result}`;
        }, (reason) => {
            this.closeResult = `Dismissed ${this.getDismissReason(reason)}`;
        });
    }

    /**
     * Load user roles from member object (which is updated on connection)
     */
    private loadUserRoles(): void {
        this.isLoadingRoles = false; // No loading needed, data is already available
        this.userRoles = [];
        
        // Get roles from member object (roles are stored as comma-separated string in backend)
        if (this.user && (this.user as any).roles) {
            const rolesStr = (this.user as any).roles;
            if (rolesStr && typeof rolesStr === 'string' && rolesStr.trim().length > 0) {
                // Parse comma-separated string into array and filter out UMA-related roles
                this.userRoles = rolesStr.split(',').map((r: string) => r.trim()).filter((r: string) => 
                    r.length > 0 && r !== 'uma_protection' && r !== 'uma_authorization'
                );
                console.log("Roles loaded from member:", this.userRoles);
            } else if (Array.isArray(rolesStr)) {
                // If it's already an array, filter out UMA-related roles
                this.userRoles = rolesStr.filter((r: string) => 
                    r && r !== 'uma_protection' && r !== 'uma_authorization'
                );
                console.log("Roles loaded from member (array):", this.userRoles);
            }
        }
        
        if (this.userRoles.length === 0) {
            console.warn("No roles found in member object");
        }
    }

    /**
     * Get filtered user roles for display (excludes UMA roles)
     * Filters out: uma_protection, uma_authorization
     * @returns Array of roles excluding UMA-related roles
     */
    getDisplayRoles(): string[] {
        if (!this.userRoles || this.userRoles.length === 0) {
            return [];
        }
        // Filter out UMA-related roles (uma_protection, uma_authorization)
        return this.userRoles.filter((role: string) => 
            role && 
            role !== 'uma_protection' && 
            role !== 'uma_authorization'
        );
    }

    /**
     * Get badge color class based on role
     * @param role The role name
     * @return Badge color class (bg-danger for admin, bg-success for user, bg-primary for others)
     */
    getRoleBadgeClass(role: string): string {
        if (!role) {
            return 'bg-primary';
        }
        
        const roleLower = role.toLowerCase().trim();
        
        // Admin role: red badge
        if (roleLower === 'admin' || roleLower === 'administrator') {
            return 'bg-danger';
        }
        
        // User role: green badge
        if (roleLower === 'user') {
            return 'bg-success';
        }
        
        // All other roles: blue badge
        return 'bg-primary';
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
        // Initialize file info map with original sizes
        this.fileInfoMap.clear();
        // Create preview URLs for images
        this.filePreviewUrls.clear();
        this.selectedFiles.forEach(file => {
            this.fileInfoMap.set(file.name, {
                originalSize: file.size,
                isCompressed: false
            });
            // Create preview URL for images
            if (this.isImageFile(file)) {
                const previewUrl = URL.createObjectURL(file);
                this.filePreviewUrls.set(file.name, previewUrl);
            }
        });
    }

    formatFileSize(bytes: number): string {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    removeFile(index: number): void {
        // Revoke preview URL if it exists
        const file = this.selectedFiles[index];
        if (file && this.filePreviewUrls.has(file.name)) {
            URL.revokeObjectURL(this.filePreviewUrls.get(file.name)!);
            this.filePreviewUrls.delete(file.name);
        }
        if (this.selectedFiles && this.selectedFiles.length > index) {
            const fileToRemove = this.selectedFiles[index];
            const newFiles = Array.from(this.selectedFiles);
            newFiles.splice(index, 1);
            this.selectedFiles = newFiles;
            // Remove from file info map
            this.fileInfoMap.delete(fileToRemove.name);
        }
    }
    
    getFileDisplaySize(file: File): string {
        const fileInfo = this.fileInfoMap.get(file.name);
        if (fileInfo && fileInfo.isCompressed && fileInfo.compressedSize !== undefined) {
            return this.formatFileSize(fileInfo.compressedSize);
        }
        return this.formatFileSize(file.size);
    }
    
    getFileOriginalSize(file: File): string | null {
        const fileInfo = this.fileInfoMap.get(file.name);
        if (fileInfo && fileInfo.isCompressed && fileInfo.compressedSize !== undefined) {
            return this.formatFileSize(fileInfo.originalSize);
        }
        return null;
    }
    
    isFileCompressed(file: File): boolean {
        const fileInfo = this.fileInfoMap.get(file.name);
        return fileInfo?.isCompressed === true;
    }

    clearFiles(): void {
        // Revoke preview URLs to free memory
        this.filePreviewUrls.forEach(url => URL.revokeObjectURL(url));
        this.filePreviewUrls.clear();
        this.selectedFiles = [];
        this.fileInfoMap.clear();
        this.resultSaveOndisk = "";
        this.isCompressing = false;
        this.compressionStatus = "";
        this.compressionProgress = null;
        this.uploadProgress = null;
    }
    
    getFilePreviewUrl(file: File): string | null {
        return this.filePreviewUrls.get(file.name) || null;
    }
    
    hideImagePreview(event: Event): void {
        const target = event.target as HTMLImageElement;
        if (target) {
            target.style.display = 'none';
        }
    }

    // Share files functionality
    onShareFilesSelected(event: any): void {
        this.shareFiles = Array.from(event.target.files);
        this.shareStatus = "";
        // Initialize file info map
        this.shareFileInfoMap.clear();
        // Create preview URLs for images
        this.shareFilePreviewUrls.clear();
        this.shareFiles.forEach(file => {
            this.shareFileInfoMap.set(file.name, {
                originalSize: file.size,
                isCompressed: false
            });
            // Create preview URL for images
            if (this.isImageFile(file)) {
                const previewUrl = URL.createObjectURL(file);
                this.shareFilePreviewUrls.set(file.name, previewUrl);
            }
        });
    }

    onShareFileSelectClick(event: Event): void {
        event.preventDefault();
        event.stopPropagation();
        const fileInput = document.getElementById('shareFileInput') as HTMLInputElement;
        if (fileInput) {
            fileInput.click();
        }
    }

    onShareDragOver(event: DragEvent): void {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer!.dropEffect = 'copy';
        this.isDragOver = true;
    }

    onShareDragLeave(event: DragEvent): void {
        event.preventDefault();
        event.stopPropagation();
        this.isDragOver = false;
    }

    onShareFileDrop(event: DragEvent): void {
        event.preventDefault();
        event.stopPropagation();
        this.isDragOver = false;

        const files = event.dataTransfer?.files;
        if (files && files.length > 0) {
            this.shareFiles = Array.from(files);
            this.shareStatus = "";
            // Initialize file info map
            this.shareFileInfoMap.clear();
            // Create preview URLs for images
            this.shareFilePreviewUrls.clear();
            this.shareFiles.forEach(file => {
                this.shareFileInfoMap.set(file.name, {
                    originalSize: file.size,
                    isCompressed: false
                });
                // Create preview URL for images
                if (this.isImageFile(file)) {
                    const previewUrl = URL.createObjectURL(file);
                    this.shareFilePreviewUrls.set(file.name, previewUrl);
                }
            });
            // Clear the data transfer to prevent any further processing
            event.dataTransfer!.clearData();
        }
    }

    removeShareFile(index: number): void {
        // Revoke preview URL if it exists
        const file = this.shareFiles[index];
        if (file && this.shareFilePreviewUrls.has(file.name)) {
            URL.revokeObjectURL(this.shareFilePreviewUrls.get(file.name)!);
            this.shareFilePreviewUrls.delete(file.name);
        }
        if (this.shareFiles && this.shareFiles.length > index) {
            const fileToRemove = this.shareFiles[index];
            const newFiles = Array.from(this.shareFiles);
            newFiles.splice(index, 1);
            this.shareFiles = newFiles;
            // Remove from file info map
            this.shareFileInfoMap.delete(fileToRemove.name);
        }
    }

    clearShareFiles(): void {
        // Revoke preview URLs to free memory
        this.shareFilePreviewUrls.forEach(url => URL.revokeObjectURL(url));
        this.shareFilePreviewUrls.clear();
        this.shareFiles = [];
        this.shareFileInfoMap.clear();
        this.shareStatus = "";
        this.isSharing = false;
        this.isCompressingShare = false;
        this.shareCompressionProgress = null;
    }
    
    getShareFileDisplaySize(file: File): string {
        const fileInfo = this.shareFileInfoMap.get(file.name);
        if (fileInfo && fileInfo.isCompressed && fileInfo.compressedSize) {
            return this.formatFileSize(fileInfo.compressedSize);
        }
        return this.formatFileSize(file.size);
    }
    
    getShareFileOriginalSize(file: File): string | null {
        const fileInfo = this.shareFileInfoMap.get(file.name);
        if (fileInfo && fileInfo.isCompressed && fileInfo.originalSize) {
            return this.formatFileSize(fileInfo.originalSize);
        }
        return null;
    }
    
    isShareFileCompressed(file: File): boolean {
        const fileInfo = this.shareFileInfoMap.get(file.name);
        return fileInfo?.isCompressed === true;
    }
    
    getShareFilePreviewUrl(file: File): string | null {
        return this.shareFilePreviewUrls.get(file.name) || null;
    }

    async onShareSubmit(): Promise<void> {
        this.isSharing = false;
        this.isCompressingShare = false;
        this.shareStatus = "";
        this.shareCompressionProgress = null;

        if (this.shareFiles.length === 0) {
            console.log('No files selected for sharing.');
            return;
        }

        const totalFiles = this.shareFiles.length;
        const BATCH_SIZE = 10; // Process 10 files in parallel
        let compressionCount = 0;
        let activeCompressions = 0;

        const updateShareCompressionProgress = () => {
            compressionCount++;
            activeCompressions--;
            if (activeCompressions > 0) {
                this.isCompressingShare = true;
                this.shareCompressionProgress = {
                    current: compressionCount,
                    total: totalFiles,
                    fileName: ''
                };
            } else {
                this.isCompressingShare = false;
                this.shareCompressionProgress = null;
            }
        };

        // Process files: compress images if needed
        const processShareFile = async (file: File, index: number): Promise<File> => {
            let fileToShare = file;
            
            // Compress if needed
            if (this.compressShareImages && this.isImageFile(file) && file.size > 300 * 1024) {
                activeCompressions++;
                this.isCompressingShare = true;
                this.shareCompressionProgress = {
                    current: compressionCount,
                    total: totalFiles,
                    fileName: ''
                };
                
                try {
                    fileToShare = await this.compressImageToTargetSize(file, 300 * 1024);
                    console.log("Share image compressed:", file.name, "Original:", this.formatFileSize(file.size), "Compressed:", this.formatFileSize(fileToShare.size));
                    
                    // Update file info map
                    const fileInfo = this.shareFileInfoMap.get(file.name);
                    if (fileInfo) {
                        fileInfo.compressedSize = fileToShare.size;
                        fileInfo.isCompressed = true;
                        // Update the file in shareFiles array
                        const fileIndex = this.shareFiles.findIndex(f => f.name === file.name);
                        if (fileIndex !== -1) {
                            this.shareFiles[fileIndex] = fileToShare;
                        }
                    }
                    
                    updateShareCompressionProgress();
                } catch (error) {
                    console.error("Error compressing share image:", file.name, error);
                    // Use original file if compression fails
                    fileToShare = file;
                    updateShareCompressionProgress();
                }
            }
            
            return fileToShare;
        };

        try {
            // Compress files in parallel batches
            for (let i = 0; i < this.shareFiles.length; i += BATCH_SIZE) {
                const batch = this.shareFiles.slice(i, i + BATCH_SIZE);
                const batchPromises = batch.map((file, batchIndex) => 
                    processShareFile(file, i + batchIndex)
                );
                await Promise.all(batchPromises);
            }

            // All compression done, now share
            this.isSharing = true;
            const filesToShare: File[] = Array.from(this.shareFiles);

            // Check if Web Share API is available
            if (navigator.share && navigator.canShare) {
                // Check if we can share files
                const shareData: any = {
                    title: this._translate.instant('SHAREFILE.SHARE_TITLE'),
                    text: this._translate.instant('SHAREFILE.SHARE_TEXT', { count: filesToShare.length }),
                    files: filesToShare
                };

                if (navigator.canShare(shareData)) {
                    // Share files using Web Share API
                    await navigator.share(shareData);
                    this.shareStatus = this._translate.instant('SHAREFILE.SHARE_SUCCESS', { count: filesToShare.length });
                    
                    // Clear files after successful share
                    setTimeout(() => {
                        this.clearShareFiles();
                    }, 100);
                } else {
                    // Fallback: share via email
                    await this.shareViaEmail(filesToShare);
                }
            } else {
                // Web Share API not available, use email fallback
                await this.shareViaEmail(filesToShare);
            }
        } catch (error: any) {
            console.error('Share error:', error);
            if (error.name === 'AbortError') {
                // User cancelled the share
                this.shareStatus = this._translate.instant('SHAREFILE.SHARE_CANCELLED');
            } else {
                // Try email fallback
                try {
                    await this.shareViaEmail(this.shareFiles);
                } catch (emailError) {
                    this.shareStatus = this._translate.instant('SHAREFILE.SHARE_ERROR');
                }
            }
        } finally {
            this.isSharing = false;
            this.isCompressingShare = false;
        }
    }

    private async shareViaEmail(files: File[]): Promise<void> {
        // Create mailto link with file information
        const fileNames = files.map(f => f.name).join(', ');
        const subject = encodeURIComponent(this._translate.instant('SHAREFILE.EMAIL_SUBJECT', { count: files.length }));
        const body = encodeURIComponent(this._translate.instant('SHAREFILE.EMAIL_BODY', { files: fileNames }));
        const mailtoLink = `mailto:?subject=${subject}&body=${body}`;
        
        window.open(mailtoLink, '_blank');
        this.shareStatus = this._translate.instant('SHAREFILE.EMAIL_OPENED');
        
        // Clear files after opening email
        setTimeout(() => {
            this.clearShareFiles();
        }, 100);
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
            // Initialize file info map with original sizes
            this.fileInfoMap.clear();
            // Create preview URLs for images
            this.filePreviewUrls.clear();
            this.selectedFiles.forEach(file => {
                this.fileInfoMap.set(file.name, {
                    originalSize: file.size,
                    isCompressed: false
                });
                // Create preview URL for images
                if (this.isImageFile(file)) {
                    const previewUrl = URL.createObjectURL(file);
                    this.filePreviewUrls.set(file.name, previewUrl);
                }
            });
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

    async onSubmit() {

        this.isLoading = true;
        this.resultSaveOndisk = "";
        this.isCompressing = false;
        this.compressionStatus = "";
        this.compressionProgress = null;
        this.uploadProgress = null;
        this.uploadResults = { success: 0, failed: 0, errors: [] };

        if (this.selectedFiles.length === 0) {
            console.log('No files selected.');
            this.isLoading = false;
            return;
        };

        const startTime = Date.now();
        const totalFiles = this.selectedFiles.length;
        const BATCH_SIZE = 10; // Process 10 files in parallel
        
        // Initialize upload progress
        this.uploadProgress = {
            current: 0,
            total: totalFiles,
            fileName: totalFiles > 0 ? this.selectedFiles[0].name : ''
        };

        // Track processing progress
        let compressionCount = 0;
        let uploadCount = 0;
        let activeCompressions = 0;
        let activeUploads = 0;
        
        const updateCompressionProgress = () => {
            compressionCount++;
            activeCompressions--;
            if (activeCompressions > 0) {
                this.isCompressing = true;
                this.compressionProgress = {
                    current: compressionCount,
                    total: totalFiles,
                    fileName: ''
                };
            } else {
                this.isCompressing = false;
                this.compressionProgress = null;
            }
        };
        
        const updateUploadProgress = () => {
            uploadCount++;
            activeUploads--;
            this.uploadProgress = {
                current: uploadCount,
                total: totalFiles,
                fileName: ''
            };
        };

        // Process files in parallel batches: compress then upload immediately
        const processFile = async (file: File, index: number): Promise<void> => {
            let fileToUpload = file;
            
            // Compress if needed
            if (this.compressImages && this.isImageFile(file) && file.size > 300 * 1024) {
                activeCompressions++;
                this.isCompressing = true;
                this.compressionProgress = {
                    current: compressionCount,
                    total: totalFiles,
                    fileName: ''
                };
                
                try {
                    fileToUpload = await this.compressImageToTargetSize(file, 300 * 1024);
                    const sizeReduction = ((1 - fileToUpload.size / file.size) * 100).toFixed(1);
                    console.log("Image compressed:", file.name, "Original:", this.formatFileSize(file.size), "Compressed:", this.formatFileSize(fileToUpload.size));
                    
                    // Update file info map
                    const fileInfo = this.fileInfoMap.get(file.name);
                    if (fileInfo) {
                        fileInfo.compressedSize = fileToUpload.size;
                        fileInfo.isCompressed = true;
                        const fileIndex = this.selectedFiles.findIndex(f => f.name === file.name);
                        if (fileIndex !== -1) {
                            this.selectedFiles[fileIndex] = fileToUpload;
                        }
                    }
                    
                    // Update compression progress after compression completes
                    updateCompressionProgress();
                } catch (error) {
                    console.error("Error compressing image:", file.name, error);
                    // Use original file if compression fails
                    fileToUpload = file;
                    updateCompressionProgress();
                }
            }
            
            // Upload immediately after compression (or directly if no compression needed)
            activeUploads++;
            this.uploadProgress = {
                current: uploadCount,
                total: totalFiles,
                fileName: ''
            };
            
            const uploadFormData = new FormData();
            uploadFormData.append('files', fileToUpload, fileToUpload.name);
            uploadFormData.append('allowOriginal', 'true');
            
            return new Promise<void>((resolve) => {
                this._fileService.postFileOnDisk(uploadFormData, this.user)
                    .subscribe({
                        next: (response: any) => {
                            console.log('|--> Upload successful for:', fileToUpload.name, response);
                            this.uploadResults.success++;
                            updateUploadProgress();
                            resolve();
                        },
                        error: (error: any) => {
                            console.error('|--> Upload error for:', fileToUpload.name, error);
                            this.uploadResults.failed++;
                            const errorMsg = error.error || error.message || "Upload failed";
                            this.uploadResults.errors.push(`${fileToUpload.name}: ${errorMsg}`);
                            updateUploadProgress();
                            resolve(); // Continue with other files even if one fails
                        }
                    });
            });
        };

        // Process files in batches of 10 - compression and upload happen in parallel
        try {
            for (let i = 0; i < this.selectedFiles.length; i += BATCH_SIZE) {
                const batch = this.selectedFiles.slice(i, i + BATCH_SIZE);
                // Start all files in the batch simultaneously
                // Each file will compress (if needed) then upload immediately
                // This allows compression and upload to overlap across different files
                const batchPromises = batch.map((file, batchIndex) => 
                    processFile(file, i + batchIndex)
                );
                
                // Wait for all files in batch to complete (both compression and upload)
                await Promise.all(batchPromises);
            }
            
            // All files processed
            const endTime = Date.now();
            const duration = ((endTime - startTime) / 1000).toFixed(2); // Duration in seconds
            const durationMinutes = Math.floor((endTime - startTime) / 60000);
            const durationSeconds = (((endTime - startTime) % 60000) / 1000).toFixed(1);
            
            this.isCompressing = false;
            this.isLoading = false;
            this.uploadProgress = null;
            
            // Set final result message
            let resultMessage = '';
            if (this.uploadResults.failed === 0) {
                resultMessage = this._translate.instant('UPLOADFILE.UPLOAD_SUCCESS_ALL', {
                    count: this.uploadResults.success
                });
            } else if (this.uploadResults.success > 0) {
                resultMessage = this._translate.instant('UPLOADFILE.UPLOAD_PARTIAL', {
                    success: this.uploadResults.success,
                    failed: this.uploadResults.failed
                });
            } else {
                resultMessage = this._translate.instant('UPLOADFILE.UPLOAD_FAILED_ALL', {
                    count: this.uploadResults.failed
                });
            }
            
            // Add duration
            if (durationMinutes > 0) {
                resultMessage += ' - ' + this._translate.instant('UPLOADFILE.DURATION_MIN_SEC', {
                    minutes: durationMinutes,
                    seconds: durationSeconds
                });
            } else {
                resultMessage += ' - ' + this._translate.instant('UPLOADFILE.DURATION_SEC', {
                    seconds: durationSeconds
                });
            }
            
            this.resultSaveOndisk = resultMessage;
            
            // Add error details if any
            if (this.uploadResults.errors.length > 0) {
                this.resultSaveOndisk += "\n" + this.uploadResults.errors.join("\n");
            }
            
            // Clear selected files when status appears
            setTimeout(() => {
                this.selectedFiles = [];
                this.fileInfoMap.clear();
            }, 100);
            
        } catch (error) {
            console.error('Error processing files:', error);
            this.isLoading = false;
            this.isCompressing = false;
            this.uploadProgress = null;
            this.resultSaveOndisk = "Error processing files: " + (error as Error).message;
            
            // Clear selected files when error status appears
            setTimeout(() => {
                this.selectedFiles = [];
                this.fileInfoMap.clear();
            }, 100);
        }
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
            this.showDocumentationSubmenu = false; // Close documentation submenu when tools dropdown closes
        }
    }

    onToolsMenuLeave(event: MouseEvent): void {
        const relatedTarget = event.relatedTarget as HTMLElement;
        const isOverLanguageSubmenu = relatedTarget?.closest('.language-submenu-list') || 
                                      relatedTarget?.closest('.dropdown-submenu');
        const isOverDocumentationSubmenu = relatedTarget?.closest('.documentation-submenu-list') || 
                                           relatedTarget?.closest('.dropdown-submenu');
        if (!isOverLanguageSubmenu && !isOverDocumentationSubmenu) {
            this.showToolsDropdown = false;
            this.showLanguageSubmenu = false;
            this.showDocumentationSubmenu = false;
        }
    }

    toggleLanguageSubmenuOnClick(event: Event): void {
        event.preventDefault();
        event.stopPropagation();
        this.showToolsDropdown = true;
        this.showLanguageSubmenu = !this.showLanguageSubmenu;
        // Close Documentation submenu when Language submenu opens
        if (this.showLanguageSubmenu) {
            this.showDocumentationSubmenu = false;
            this.positionLanguageSubmenu();
        }
    }

    checkCloseLanguageSubmenu(event: MouseEvent): void {
        setTimeout(() => {
            const relatedTarget = event.relatedTarget as HTMLElement;
            const isOverLanguage = relatedTarget?.closest('.language-submenu-list') || 
                                  relatedTarget?.id === 'languageSubmenu';
            const isOverLanguageSubmenu = relatedTarget?.closest('#languageSubmenu')?.closest('.dropdown-submenu');
            const isOverTools = relatedTarget?.closest('#toolsDropdown') ||
                               relatedTarget?.closest('[aria-labelledby="toolsDropdown"]');
            // Check if moving to Documentation submenu
            const isOverDocumentation = relatedTarget?.closest('.documentation-submenu-list') ||
                                       relatedTarget?.id === 'documentationSubmenu';
            if (!isOverLanguage && !isOverLanguageSubmenu && !isOverTools && !isOverDocumentation) {
                this.showLanguageSubmenu = false;
            }
        }, 100);
    }

    toggleDocumentationSubmenuOnClick(event: Event): void {
        event.preventDefault();
        event.stopPropagation();
        this.showToolsDropdown = true;
        this.showDocumentationSubmenu = !this.showDocumentationSubmenu;
        // Close Language submenu when Documentation submenu opens
        if (this.showDocumentationSubmenu) {
            this.showLanguageSubmenu = false;
            this.positionDocumentationSubmenu();
        }
    }

    checkCloseDocumentationSubmenu(event: MouseEvent): void {
        setTimeout(() => {
            const relatedTarget = event.relatedTarget as HTMLElement;
            const isOverDocumentation = relatedTarget?.closest('.documentation-submenu-list') || 
                                       relatedTarget?.id === 'documentationSubmenu';
            const isOverDocumentationSubmenu = relatedTarget?.closest('#documentationSubmenu')?.closest('.dropdown-submenu');
            const isOverTools = relatedTarget?.closest('#toolsDropdown') ||
                               relatedTarget?.closest('[aria-labelledby="toolsDropdown"]');
            // Check if moving to Language submenu
            const isOverLanguage = relatedTarget?.closest('.language-submenu-list') ||
                                  relatedTarget?.id === 'languageSubmenu';
            if (!isOverDocumentation && !isOverDocumentationSubmenu && !isOverTools && !isOverLanguage) {
                this.showDocumentationSubmenu = false;
            }
        }, 100);
    }

    positionDocumentationSubmenu(): void {
        setTimeout(() => {
            // Close Language submenu when positioning Documentation submenu
            this.showLanguageSubmenu = false;
            
            const submenuElement = document.querySelector('.documentation-submenu-list') as HTMLElement;
            const parentItem = document.querySelector('#documentationSubmenu')?.closest('.dropdown-submenu') as HTMLElement;
            
            if (submenuElement && parentItem) {
                // Check if we're in mobile mode (screen width <= 991.98px)
                const isMobile = window.innerWidth <= 991.98;
                
                if (isMobile) {
                    // In mobile mode, don't position with fixed, let CSS handle it
                    // Just ensure it's visible
                    submenuElement.classList.add('show');
                    submenuElement.setAttribute('data-visible', 'true');
                    return;
                }
                
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
                
                // Apply all styles directly with proper background
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
                    padding: 4px 0 !important;
                    transform: none !important;
                    width: auto !important;
                    height: auto !important;
                    background: rgba(30, 30, 46, 0.95) !important;
                    backdrop-filter: blur(10px);
                    border: 2px solid white !important;
                `;
                
                // Force class
                submenuElement.classList.add('show');
                
                // Mark as visible
                submenuElement.setAttribute('data-visible', 'true');
            }
        }, 10);
    }

    positionLanguageSubmenu(): void {
        setTimeout(() => {
            // Close Documentation submenu when positioning Language submenu
            this.showDocumentationSubmenu = false;
            
            const submenuElement = document.querySelector('.language-submenu-list') as HTMLElement;
            const parentItem = document.querySelector('#languageSubmenu')?.closest('.dropdown-submenu') as HTMLElement;
            
            if (submenuElement && parentItem) {
                // Check if we're in mobile mode (screen width <= 991.98px)
                const isMobile = window.innerWidth <= 991.98;
                
                if (isMobile) {
                    // In mobile mode, don't position with fixed, let CSS handle it
                    // Just ensure it's visible
                    submenuElement.classList.add('show');
                    submenuElement.setAttribute('data-visible', 'true');
                    return;
                }
                
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
                
                // Apply all styles directly with proper background
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
                    padding: 4px 0 !important;
                    transform: none !important;
                    width: auto !important;
                    height: auto !important;
                    background: rgba(30, 30, 46, 0.95) !important;
                    backdrop-filter: blur(10px);
                    border: 2px solid white !important;
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
        this.showDocumentationSubmenu = false;
    }

    closeDropdowns(): void {
        this.showEventsDropdown = false;
        this.showIADropdown = false;
        this.showToolsDropdown = false;
        this.showLinksDropdown = false;
        this.showLanguageSubmenu = false;
        this.showDocumentationSubmenu = false;
    }

    closeMenu(): void {
        this.isMenuCollapsed = true;
        this.closeDropdowns();
    }

    closeMenuOnly(): void {
        this.isMenuCollapsed = true;
        this.closeDropdowns();
    }

    openSlideshowDocumentation(): void {
        // Open the slideshow documentation HTML file in a new window
        const docUrl = '/assets/SLIDESHOW_DOCUMENTATION.html';
        window.open(docUrl, '_blank', 'width=1200,height=800,scrollbars=yes,resizable=yes,toolbar=yes,menubar=yes');
    }

    openRecentFeaturesDocumentation(): void {
        // Open the recent features documentation HTML file in a new window
        const docUrl = '/assets/RECENT_FEATURES_DOCUMENTATION.html';
        window.open(docUrl, '_blank', 'width=1200,height=800,scrollbars=yes,resizable=yes,toolbar=yes,menubar=yes');
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
        const isDocumentationSubmenu = target.closest('.documentation-submenu-list') || target.closest('[aria-labelledby="documentationSubmenu"]');
        const isNavbar = target.closest('.navbar');
        const isDropdownItem = target.closest('.dropdown-item');
        
        // If click is outside all dropdowns, navbar, and dropdown items, close them
        if (!isEventsDropdown && !isIADropdown && !isToolsDropdown && !isLinksDropdown && !isAISubmenu && !isLanguageSubmenu && !isDocumentationSubmenu && !isNavbar && !isDropdownItem) {
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

    // Check if file is an image
    isImageFile(file: File): boolean {
        return file.type.startsWith('image/');
    }

    // Compress image to target size (in bytes)
    async compressImageToTargetSize(file: File, targetSizeBytes: number): Promise<File> {
        return new Promise((resolve, reject) => {
            // Check if file is JPEG (EXIF is mainly in JPEG files)
            const isJPEG = file.type === 'image/jpeg' || file.type === 'image/jpg' || file.name.toLowerCase().endsWith('.jpg') || file.name.toLowerCase().endsWith('.jpeg');
            
            // Extract EXIF data if JPEG
            let exifData: any = null;
            if (isJPEG) {
                const exifReader = new FileReader();
                exifReader.onload = (exifEvent: any) => {
                    try {
                        const exifString = exifEvent.target.result;
                        exifData = piexif.load(exifString);
                        console.log('EXIF data extracted:', exifData ? 'Yes' : 'No');
                    } catch (exifError) {
                        console.log('No EXIF data found or error reading EXIF:', exifError);
                        exifData = null;
                    }
                    
                    // Now proceed with image compression
                    this.performImageCompression(file, targetSizeBytes, exifData, resolve, reject);
                };
                exifReader.onerror = () => {
                    console.log('Error reading file for EXIF, proceeding without EXIF');
                    this.performImageCompression(file, targetSizeBytes, null, resolve, reject);
                };
                exifReader.readAsBinaryString(file);
            } else {
                // Not a JPEG, proceed without EXIF
                this.performImageCompression(file, targetSizeBytes, null, resolve, reject);
            }
        });
    }
    
    private performImageCompression(
        file: File, 
        targetSizeBytes: number, 
        exifData: any, 
        resolve: (file: File) => void, 
        reject: (error: Error) => void
    ): void {
        const reader = new FileReader();
        
        reader.onload = (e: any) => {
            const img = new Image();
            
            img.onload = () => {
                // Start with high quality and reduce until we reach target size
                let quality = 0.9;
                let minQuality = 0.1;
                let maxQuality = 0.95;
                let bestBlob: Blob | null = null;
                let attempts = 0;
                const maxAttempts = 10;
                const isJPEG = file.type === 'image/jpeg' || file.type === 'image/jpg' || file.name.toLowerCase().endsWith('.jpg') || file.name.toLowerCase().endsWith('.jpeg');
                
                // Modern browsers automatically apply EXIF orientation when loading images into <img> elements
                // So img.width and img.height already reflect the correct orientation
                // We should always use these displayed dimensions and never apply manual transformations
                const displayedW = img.width;
                const displayedH = img.height;
                
                const processBlobWithEXIF = (blob: Blob, q: number, orientationToReset: number, callback: (finalBlob: Blob) => void): void => {
                    if (isJPEG && exifData) {
                        try {
                            // Convert blob to binary string
                            const blobReader = new FileReader();
                            blobReader.onload = (blobEvent: any) => {
                                try {
                                    const binaryString = blobEvent.target.result;
                                    
                                    // Create a copy of EXIF data and reset orientation to 1
                                    // (the browser has already applied the orientation when loading the image)
                                    const modifiedExifData = JSON.parse(JSON.stringify(exifData));
                                    if (modifiedExifData['0th'] && orientationToReset !== 1) {
                                        modifiedExifData['0th'][piexif.ImageIFD.Orientation] = 1;
                                    }
                                    
                                    // Insert EXIF data into compressed image
                                    const exifString = piexif.dump(modifiedExifData);
                                    const newBinaryString = piexif.insert(exifString, binaryString);
                                    
                                    // Convert binary string back to blob
                                    const byteArray = new Uint8Array(newBinaryString.length);
                                    for (let i = 0; i < newBinaryString.length; i++) {
                                        byteArray[i] = newBinaryString.charCodeAt(i);
                                    }
                                    const finalBlob = new Blob([byteArray], { type: file.type });
                                    
                                    console.log('EXIF data injected into compressed image (orientation reset to 1)');
                                    callback(finalBlob);
                                } catch (exifInsertError) {
                                    console.log('Error inserting EXIF data, using compressed image without EXIF:', exifInsertError);
                                    callback(blob);
                                }
                            };
                            blobReader.onerror = () => {
                                console.log('Error reading blob for EXIF injection, using compressed image without EXIF');
                                callback(blob);
                            };
                            blobReader.readAsBinaryString(blob);
                        } catch (exifError) {
                            console.log('Error processing EXIF, using compressed image without EXIF:', exifError);
                            callback(blob);
                        }
                    } else {
                        callback(blob);
                    }
                };
                
                const tryCompress = (q: number): void => {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    
                    if (!ctx) {
                        reject(new Error('Could not get canvas context'));
                        return;
                    }
                    
                    // Get EXIF orientation for metadata reset (default to 1 if not available)
                    let orientation = 1;
                    if (exifData && exifData['0th'] && exifData['0th'][piexif.ImageIFD.Orientation]) {
                        orientation = exifData['0th'][piexif.ImageIFD.Orientation];
                    }
                    
                    // Modern browsers automatically apply EXIF orientation when loading images
                    // So img.width and img.height already reflect the correct orientation
                    // We simply use these dimensions without any manual transformations
                    const sourceWidth = displayedW;
                    const sourceHeight = displayedH;
                    
                    const maxDimension = 1920; // Max width or height
                    
                    // Calculate resized dimensions maintaining aspect ratio
                    let finalWidth = sourceWidth;
                    let finalHeight = sourceHeight;
                    if (sourceWidth > maxDimension || sourceHeight > maxDimension) {
                        if (sourceWidth > sourceHeight) {
                            finalHeight = (sourceHeight / sourceWidth) * maxDimension;
                            finalWidth = maxDimension;
                        } else {
                            finalWidth = (sourceWidth / sourceHeight) * maxDimension;
                            finalHeight = maxDimension;
                        }
                    }
                    
                    // Set canvas dimensions to final output dimensions
                    canvas.width = finalWidth;
                    canvas.height = finalHeight;
                    
                    // Clear canvas and draw the image (already correctly oriented by the browser)
                    ctx.clearRect(0, 0, finalWidth, finalHeight);
                    ctx.drawImage(img, 0, 0, finalWidth, finalHeight);
                    
                    // Convert to blob
                    canvas.toBlob((blob) => {
                        if (!blob) {
                            reject(new Error('Failed to create blob'));
                            return;
                        }
                        
                        // Process blob with EXIF injection if needed
                        processBlobWithEXIF(blob, q, orientation, (finalBlob) => {
                            attempts++;
                            
                            // If we're close enough to target size or reached max attempts, use this
                            if (finalBlob.size <= targetSizeBytes * 1.1 || attempts >= maxAttempts) {
                                // Convert blob to File
                                const compressedFile = new File([finalBlob], file.name, {
                                    type: file.type,
                                    lastModified: Date.now()
                                });
                                resolve(compressedFile);
                                return;
                            }
                            
                            // If still too large, reduce quality
                            if (finalBlob.size > targetSizeBytes) {
                                bestBlob = finalBlob; // Keep track of best (smallest) blob that's still too large
                                maxQuality = q; // Current quality is too high, reduce max
                                const newQuality = (q + minQuality) / 2; // Try lower quality
                                if (Math.abs(newQuality - q) < 0.01 || newQuality <= minQuality) {
                                    // Quality difference too small or reached minimum, use best blob or current
                                    const finalBlobToUse = bestBlob && bestBlob.size < finalBlob.size ? bestBlob : finalBlob;
                                    const compressedFile = new File([finalBlobToUse], file.name, {
                                        type: file.type,
                                        lastModified: Date.now()
                                    });
                                    resolve(compressedFile);
                                    return;
                                }
                                tryCompress(newQuality);
                            } else {
                                // Too small, we can increase quality
                                minQuality = q; // Current quality works, we can try higher
                                const newQuality = (q + maxQuality) / 2; // Try higher quality
                                if (Math.abs(newQuality - q) < 0.01 || newQuality >= maxQuality) {
                                    // Quality difference too small or reached maximum, use current blob
                                    const compressedFile = new File([finalBlob], file.name, {
                                        type: file.type,
                                        lastModified: Date.now()
                                    });
                                    resolve(compressedFile);
                                    return;
                                }
                                tryCompress(newQuality);
                            }
                        });
                    }, file.type, q);
                };
                
                // Start compression
                tryCompress(quality);
            };
            
            img.onerror = () => {
                reject(new Error('Failed to load image'));
            };
            
            img.src = e.target.result;
        };
        
        reader.onerror = () => {
            reject(new Error('Failed to read file'));
        };
        
        reader.readAsDataURL(file);
    }

}

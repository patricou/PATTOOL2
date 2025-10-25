import { Component, OnInit, ViewChild, TemplateRef } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Evenement } from '../../model/evenement';
import { EvenementsService } from '../../services/evenements.service';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';

// Removed ngx-mydatepicker imports - using native HTML date inputs
import { Member } from '../../model/member';
import { UrlEvent } from '../../model/url-event';
import { Commentary } from '../../model/commentary';
import { MembersService } from '../../services/members.service';
import { FileService } from '../../services/file.service';
import { UploadedFile } from '../../model/uploadedfile';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { environment } from '../../../environments/environment';

@Component({
	selector: 'update-evenement',
	templateUrl: './update-evenement.component.html',
	styleUrls: ['./update-evenement.component.css']
})
export class UpdateEvenementComponent implements OnInit {

	public evenement: Evenement = new Evenement(new Member("", "", "", "", "", [], ""), new Date(), "", new Date(), new Date(), new Date(), "Nouvel Evenement !!", "", [], new Date(), "", "", [], "", "", "", "", 0, 0, "", [], []);
	// Removed ngx-mydatepicker options - using native HTML date inputs
	// Using native HTML date inputs instead of ngx-mydatepicker
	public author: string = "";
	public beginEventDateString: string = "";
	public endEventDateString: string = "";
	public openInscriptionDateString: string = "";
	public closeInscriptionDateString: string = "";
	// change color for select placeholder 
	public typeColor: string = "rgb(70,74,76)";
	public diffColor: string = "rgb(70,74,76)";
	
	// URL Events management
	public newUrlEvent: UrlEvent = new UrlEvent("", new Date(), "", "", "");
	public urlEventTypes: {id: string, label: string}[] = [
		{id: "MAP", label: "EVENTHOME.URL_TYPE_CARTE"},
		{id: "DOCUMENTATION", label: "EVENTHOME.URL_TYPE_DOCUMENTATION"},
		{id: "OTHER", label: "EVENTHOME.URL_TYPE_OTHER"},
		{id: "PHOTOS", label: "EVENTHOME.URL_TYPE_PHOTOS"},
		{id: "WEBSITE", label: "EVENTHOME.URL_TYPE_WEBSITE"}
	];
	public user: Member = new Member("", "", "", "", "", [], "");
	
	// URL Event editing management
	public editingUrlEvent: UrlEvent = new UrlEvent("", new Date(), "", "", "");
	public editingIndex: number = -1;
	public isAddingUrlEvent: boolean = false;

	// Commentary management
	public newCommentary: Commentary = new Commentary("", "", new Date());
	public isAddingCommentary: boolean = false;
	public editingCommentaryIndex: number = -1;
	public editingCommentary: Commentary = new Commentary("", "", new Date());

    // Image modal properties
    @ViewChild('imageModal') imageModal!: TemplateRef<any>;
    public selectedImageUrl: any = '';
    public selectedImageAlt: string = '';

    // User modal properties
    public selectedUser: Member | null = null;
    @ViewChild('userModal') userModal!: TemplateRef<any>;

    // Confirmation modal for delete all files
    @ViewChild('confirmDeleteAllModal') confirmDeleteAllModal!: TemplateRef<any>;

    // Confirmation modal for delete all links
    @ViewChild('confirmDeleteAllLinksModal') confirmDeleteAllLinksModal!: TemplateRef<any>;

    // Confirmation modal for delete all commentaries
    @ViewChild('confirmDeleteAllCommentariesModal') confirmDeleteAllCommentariesModal!: TemplateRef<any>;

    // File upload properties
    public selectedFiles: File[] = [];
    public isDragOver: boolean = false;
    public isUploading: boolean = false;

	constructor(private _route: ActivatedRoute,
		private _evenementsService: EvenementsService,
		private _router: Router,
		private _memberService: MembersService,
		private _fileService: FileService,
		private modalService: NgbModal
	) { }

	ngOnInit() {
		// Initialize user
		this.user = this._memberService.getUser();
		
		let id: string = this._route.snapshot.params['id'];
		this._evenementsService.getEvenement(id).subscribe
			(evenement => {
				//console.log("EVenement : " + JSON.stringify(evenement));
				this.evenement = evenement;
				this.author = evenement.author.firstName + " " + evenement.author.lastName + " / " + evenement.author.userName;
				
				// Initialize urlEvents if not present
				if (!this.evenement.urlEvents) {
					this.evenement.urlEvents = [];
				}
				
				// Initialize commentaries if not present
				if (!this.evenement.commentaries) {
					this.evenement.commentaries = [];
				}
				
				// Initialize newUrlEvent with current user as owner
				this.newUrlEvent = new UrlEvent("", new Date(), this.user.userName, "", "");
				
				// Initialize newCommentary with current user as owner
				this.newCommentary = new Commentary(this.user.userName, "", new Date());
				
				// Convert dates to string format for native HTML date inputs
				this.beginEventDateString = this.formatDateForInput(this.evenement.beginEventDate);
				this.openInscriptionDateString = this.formatDateForInput(this.evenement.openInscriptionDate);
				this.endEventDateString = this.formatDateForInput(this.evenement.endEventDate);
				this.closeInscriptionDateString = this.formatDateForInput(this.evenement.closeInscriptionDate);
			}
			)
	}

	private formatDateForInput(date: Date | string): string {
		if (!date) return '';
		
		// Ensure we have a proper Date object
		let d: Date;
		if (typeof date === 'string') {
			d = new Date(date);
		} else {
			d = new Date(date);
		}
		
		// Check if the date is valid
		if (isNaN(d.getTime())) {
			console.warn('Invalid date provided:', date);
			return '';
		}
		
		// Format pour datetime-local en utilisant la zone horaire locale
		const year = d.getFullYear();
		const month = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		const hours = String(d.getHours()).padStart(2, '0');
		const minutes = String(d.getMinutes()).padStart(2, '0');
		
		return `${year}-${month}-${day}T${hours}:${minutes}`;
	}

	// Photo management methods - REMOVED since photosUrl field has been removed
	addPhotoUrl(photoUrl: string) {
		// Method disabled - photosUrl field has been removed
		console.log('addPhotoUrl method disabled - photosUrl field has been removed');
	}

	removePhotoUrl(index: number) {
		// Method disabled - photosUrl field has been removed
		console.log('removePhotoUrl method disabled - photosUrl field has been removed');
	}

	hideImageOnError(event: any) {
		const target = event.target as HTMLImageElement;
		if (target) {
			target.style.display = 'none';
		}
	}
	
	// Methods to manage URL Events
	addUrlEvent() {
		if (this.newUrlEvent.link && this.newUrlEvent.link.trim() !== '' && 
			this.newUrlEvent.typeUrl && this.newUrlEvent.typeUrl.trim() !== '') {
			// Create a new UrlEvent instance to avoid reference issues
			const urlEvent = new UrlEvent(
				this.newUrlEvent.typeUrl.trim(),
				new Date(), // Always use current date for creation
				this.user.userName, // Use userName as owner
				this.newUrlEvent.link.trim(),
				this.newUrlEvent.urlDescription.trim()
			);
			this.evenement.urlEvents.push(urlEvent);
			
			// Reset the form
			this.newUrlEvent = new UrlEvent("", new Date(), this.user.userName, "", "");
			this.isAddingUrlEvent = false;
		}
	}
	
	removeUrlEvent(index: number) {
		if (index >= 0 && index < this.evenement.urlEvents.length) {
			const urlEvent = this.evenement.urlEvents[index];
			// Check if user can delete this URL event
			if (this.canDeleteUrlEvent(urlEvent)) {
				this.evenement.urlEvents.splice(index, 1);
			} else {
				alert("Vous n'avez pas l'autorisation de supprimer ce lien.");
			}
		}
	}
	
	cancelAddUrlEvent() {
		this.isAddingUrlEvent = false;
		this.newUrlEvent = new UrlEvent("", new Date(), this.user.userName, "", "");
	}
	
	// URL Event editing methods
	startEditUrlEvent(index: number) {
		// Store the index being edited
		this.editingIndex = index;
		
		// Create a copy of the urlEvent to edit
		const urlEventToEdit = this.evenement.urlEvents[index];
		this.editingUrlEvent = new UrlEvent(
			urlEventToEdit.typeUrl,
			urlEventToEdit.dateCreation,
			urlEventToEdit.owner,
			urlEventToEdit.link,
			urlEventToEdit.urlDescription
		);
	}
	
	saveUrlEventEdit(index: number) {
		if (this.editingUrlEvent.link && this.editingUrlEvent.link.trim() !== '' && 
			this.editingUrlEvent.typeUrl && this.editingUrlEvent.typeUrl.trim() !== '') {
			
			// Update the original urlEvent with edited values
			this.evenement.urlEvents[index].typeUrl = this.editingUrlEvent.typeUrl.trim();
			this.evenement.urlEvents[index].link = this.editingUrlEvent.link.trim();
			this.evenement.urlEvents[index].urlDescription = this.editingUrlEvent.urlDescription.trim();
			// Keep original owner and dateCreation
			
			// Reset editing state
			this.cancelUrlEventEdit();
		}
	}
	
	cancelUrlEventEdit() {
		this.editingUrlEvent = new UrlEvent("", new Date(), "", "", "");
		this.editingIndex = -1;
	}
	
	// Helper method to get the actual index in the full urlEvents array
	getActualIndex(urlEvent: UrlEvent): number {
		return this.evenement.urlEvents.indexOf(urlEvent);
	}

	getUrlTypeLabel(typeId: string): string {
		const type = this.urlEventTypes.find(t => t.id === typeId);
		return type ? type.label : typeId;
	}

	// Method to group URL Events by typeUrl
	getGroupedUrlEvents(): { [key: string]: UrlEvent[] } {
		if (!this.evenement.urlEvents || this.evenement.urlEvents.length === 0) {
			return {};
		}
		
		return this.evenement.urlEvents.reduce((groups: { [key: string]: UrlEvent[] }, urlEvent: UrlEvent) => {
			const typeUrl = urlEvent.typeUrl;
			if (!groups[typeUrl]) {
				groups[typeUrl] = [];
			}
			groups[typeUrl].push(urlEvent);
			return groups;
		}, {});
	}

	// Method to get sorted group keys
	getGroupedUrlEventKeys(): string[] {
		const groups = this.getGroupedUrlEvents();
		return Object.keys(groups).sort();
	}

	updateEvenement(fromform: any, isValid: boolean) {
		// Using native HTML date inputs - convert string to Date objects
		// Use the string values from the form inputs
		if (this.beginEventDateString) {
			this.evenement.beginEventDate = new Date(this.beginEventDateString);
		}
		if (this.endEventDateString) {
			this.evenement.endEventDate = new Date(this.endEventDateString);
		}
		if (this.openInscriptionDateString) {
			this.evenement.openInscriptionDate = new Date(this.openInscriptionDateString);
		}
		if (this.closeInscriptionDateString) {
			this.evenement.closeInscriptionDate = new Date(this.closeInscriptionDateString);
		}
		
		// note  : it is perhaps bad but  fields eventname, map and comment are passed through 2 ways binding.    
		//console.log("Result : "+ JSON.stringify(this.evenement) + " " + isValid);
		this._evenementsService.putEvenement(this.evenement).subscribe(res => this._router.navigate(['even']), err => alert("Error when updating the Event" + err));
	}

	// Commentary management methods
	public addCommentary(): void {
		if (this.newCommentary.commentary && this.newCommentary.commentary.trim() !== '') {
			// Create a new Commentary instance
			const commentary = new Commentary(
				this.user.userName, // Use current user as owner
				this.newCommentary.commentary.trim(),
				new Date() // Use current date
			);
			
			this.evenement.commentaries.push(commentary);
			
			// Reset the form
			this.newCommentary = new Commentary(this.user.userName, "", new Date());
			this.isAddingCommentary = false;
		}
	}

	// Cancel adding commentary
	public cancelAddCommentary(): void {
		this.newCommentary = new Commentary(this.user.userName, "", new Date());
		this.isAddingCommentary = false;
	}

	// Delete a commentary
	public deleteCommentary(index: number): void {
		if (index >= 0 && index < this.evenement.commentaries.length) {
			const commentary = this.evenement.commentaries[index];
			// Check if user can delete this commentary
			if (this.canDeleteCommentary(commentary)) {
				if (confirm("Are you sure you want to delete this commentary?")) {
					this.evenement.commentaries.splice(index, 1);
				}
			} else {
				alert("Vous n'avez pas l'autorisation de supprimer ce commentaire.");
			}
		}
	}

	// Start editing commentary
	public startEditCommentary(index: number): void {
		this.editingCommentaryIndex = index;
		const commentaryToEdit = this.evenement.commentaries[index];
		this.editingCommentary = new Commentary(
			commentaryToEdit.commentOwner,
			commentaryToEdit.commentary,
			commentaryToEdit.dateCreation
		);
	}

	// Save commentary edit
	public saveCommentaryEdit(index: number): void {
		if (this.editingCommentary.commentary && this.editingCommentary.commentary.trim() !== '') {
			// Update the original commentary with edited values
			this.evenement.commentaries[index].commentary = this.editingCommentary.commentary.trim();
			// Keep original owner and dateCreation
			
			// Reset editing state
			this.cancelCommentaryEdit();
		}
	}

	// Cancel commentary edit
	public cancelCommentaryEdit(): void {
		this.editingCommentary = new Commentary("", "", new Date());
		this.editingCommentaryIndex = -1;
	}

	// Check if user can delete commentary (only owner of the commentary)
	public canDeleteCommentary(commentary: Commentary): boolean {
		return this.user.userName === commentary.commentOwner;
	}

	// Check if user can delete URL event (only owner of the link)
	public canDeleteUrlEvent(urlEvent: UrlEvent): boolean {
		return this.user.userName === urlEvent.owner;
	}

	// Check if user can edit URL event (only owner of the link)
	public canEditUrlEvent(urlEvent: UrlEvent): boolean {
		return this.user.userName === urlEvent.owner;
	}

	// Check if user can edit commentary (only owner of the commentary)
	public canEditCommentary(commentary: Commentary): boolean {
		return this.user.userName === commentary.commentOwner;
	}

	// Check if user can edit event fields (only event author)
	public canEditEventFields(): boolean {
		return this.user.userName === this.evenement.author.userName;
	}

	// Format date for display
	public formatCommentaryDate(date: Date): string {
		if (!date) return '';
		return new Date(date).toLocaleString();
	}

	// File management methods
	public isFileOwner(uploadedFile: UploadedFile): boolean {
		return this.user.userName === uploadedFile.uploaderMember.userName;
	}

	private reloadEvent(): void {
		let id: string = this._route.snapshot.params['id'];
		this._evenementsService.getEvenement(id).subscribe(
			evenement => {
				this.evenement = evenement;
				this.author = evenement.author.firstName + " " + evenement.author.lastName + " / " + evenement.author.userName;
				
				// Initialize urlEvents if not present
				if (!this.evenement.urlEvents) {
					this.evenement.urlEvents = [];
				}
				
				// Initialize commentaries if not present
				if (!this.evenement.commentaries) {
					this.evenement.commentaries = [];
				}
				
				// Initialize fileUploadeds if not present
				if (!this.evenement.fileUploadeds) {
					this.evenement.fileUploadeds = [];
				}
			},
			error => {
				console.error('Error reloading event:', error);
			}
		);
	}

	public isImageFile(fileName: string): boolean {
		const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
		const extension = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
		return imageExtensions.includes(extension);
	}

	public isPdfFile(fileName: string): boolean {
		return fileName.toLowerCase().endsWith('.pdf');
	}

	public getFileBlobUrl(fileId: string): Observable<any> {
		return this._fileService.getFile(fileId).pipe(
			map((res: any) => {
				let blob = new Blob([res], { type: 'application/octet-stream' });
				return blob;
			})
		);
	}

    public openUserModal(user: Member): void {
        this.selectedUser = user;
        if (!this.userModal) {
            return;
        }

        this.modalService.open(this.userModal, {
            size: 'md',
            centered: true,
            backdrop: true,
            keyboard: true,
            animation: true
        });
    }

    public openFileImageModal(fileId: string, fileName: string): void {
		this.getFileBlobUrl(fileId).subscribe((blob: any) => {
			const objectUrl = URL.createObjectURL(blob);
			this.selectedImageUrl = objectUrl;
			this.selectedImageAlt = fileName;

			if (!this.imageModal) {
				return;
			}

			this.modalService.open(this.imageModal, {
				size: 'xl',
				centered: true,
				backdrop: true,
				keyboard: true,
				animation: false,
				windowClass: 'modal-smooth-animation'
			});
		}, (error) => {
			console.error('Error loading file:', error);
			alert('Erreur lors du chargement du fichier');
		});
	}

	public openPdfFile(fileId: string, fileName: string): void {
		this.getFileBlobUrl(fileId).subscribe((blob: any) => {
			const pdfBlob = new Blob([blob], { type: 'application/pdf' });
			const objectUrl = URL.createObjectURL(pdfBlob);
			window.open(objectUrl, '_blank', 'width=1200,height=800,scrollbars=yes,resizable=yes,toolbar=yes,menubar=yes');
			setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
		}, (error) => {
			console.error('Error loading PDF file:', error);
			alert('Erreur lors du chargement du fichier PDF');
		});
	}

	public handleFileClick(fileId: string, fileName: string): void {
		if (this.isImageFile(fileName)) {
			this.openFileImageModal(fileId, fileName);
		} else if (this.isPdfFile(fileName)) {
			this.openPdfFile(fileId, fileName);
		}
	}

	public deleteFile(fileIndex: number): void {
		if (confirm('Êtes-vous sûr de vouloir supprimer ce fichier ?')) {
			this.evenement.fileUploadeds.splice(fileIndex, 1);
			this._evenementsService.put4FileEvenement(this.evenement).subscribe(
				(response) => {
					console.log('File deleted successfully');
				},
				(error) => {
					console.error('Error deleting file:', error);
					alert('Erreur lors de la suppression du fichier');
				}
			);
		}
	}

	public onFileSelected(event: any): void {
		const files = event.target.files;
		if (files && files.length > 0) {
			this.addFilesToSelection(Array.from(files));
		}
	}

	// Drag and drop handlers
	public onDragOver(event: DragEvent): void {
		event.preventDefault();
		event.stopPropagation();
		this.isDragOver = true;
	}

	public onDragLeave(event: DragEvent): void {
		event.preventDefault();
		event.stopPropagation();
		this.isDragOver = false;
	}

	public onDrop(event: DragEvent): void {
		event.preventDefault();
		event.stopPropagation();
		this.isDragOver = false;

		const files = event.dataTransfer?.files;
		if (files && files.length > 0) {
			this.addFilesToSelection(Array.from(files));
		}
	}

	// File management methods
	private addFilesToSelection(files: File[]): void {
		// Add new files to the selection
		this.selectedFiles = [...this.selectedFiles, ...files];
		
		// Reset file input
		const fileInput = document.getElementById('fileInput') as HTMLInputElement;
		if (fileInput) {
			fileInput.value = '';
		}
	}

	public removeSelectedFile(index: number): void {
		this.selectedFiles.splice(index, 1);
	}

	public clearSelectedFiles(): void {
		this.selectedFiles = [];
	}

	public formatFileSize(bytes: number): string {
		if (bytes === 0) return '0 Bytes';
		const k = 1024;
		const sizes = ['Bytes', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
	}

	public uploadSelectedFiles(): void {
		if (this.selectedFiles.length === 0) {
			alert('Aucun fichier sélectionné');
			return;
		}

		this.isUploading = true;
		const formData = new FormData();
		
		// Add all files to FormData
		for (let file of this.selectedFiles) {
			formData.append('file', file, file.name);
		}

		// Build the correct upload URL
		const uploadUrl = `${environment.API_URL4FILE}/${this.user.id}/${this.evenement.id}`;

		this._fileService.postFileToUrl(formData, this.user, uploadUrl).subscribe(
			(response) => {
				this.isUploading = false;
				
				// Clear selected files
				this.clearSelectedFiles();
				
				// Reload the event to get updated file list
				this.reloadEvent();
				
				// Show success message with count
				const fileCount = Array.isArray(response) ? response.length : 1;
				alert(`Fichiers uploadés avec succès! (${fileCount} fichiers)`);
			},
			(error) => {
				console.error('Error uploading files:', error);
				this.isUploading = false;
				
				let errorMessage = "Erreur lors de l'upload des fichiers.";
				
				if (error.status === 0) {
					errorMessage = "Impossible de se connecter au serveur. Vérifiez que le service backend fonctionne.";
				} else if (error.status === 401) {
					errorMessage = "Authentification échouée. Veuillez vous reconnecter.";
				} else if (error.status === 403) {
					errorMessage = "Accès interdit. Vous n'avez pas l'autorisation d'uploader des fichiers.";
				} else if (error.status >= 500) {
					errorMessage = "Erreur serveur. Veuillez réessayer plus tard.";
				} else if (error.error && error.error.message) {
					errorMessage = error.error.message;
				}
				
				alert(errorMessage);
			}
		);
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

	// Method to open confirmation modal for deleting all files
	public confirmDeleteAllFiles(): void {
		if (!this.confirmDeleteAllModal) {
			console.error('confirmDeleteAllModal not found');
			return;
		}

		this.modalService.open(this.confirmDeleteAllModal, {
			size: 'md',
			centered: true,
			backdrop: true,
			keyboard: true,
			animation: true
		});
	}

	// Method to delete all files
	public deleteAllFiles(): void {
		if (!this.evenement.fileUploadeds || this.evenement.fileUploadeds.length === 0) {
			alert('Aucun fichier à supprimer');
			return;
		}

		// Clear all files from the event
		this.evenement.fileUploadeds = [];

		// Update the event on the server
		this._evenementsService.put4FileEvenement(this.evenement).subscribe(
			(response) => {
				console.log('All files deleted successfully');
				alert('Tous les fichiers ont été supprimés avec succès!');
			},
			(error) => {
				console.error('Error deleting all files:', error);
				alert('Erreur lors de la suppression des fichiers');
				// Reload event to restore the file list
				this.reloadEvent();
			}
		);
	}

	// Method to open confirmation modal for deleting all links
	public confirmDeleteAllLinks(): void {
		if (!this.confirmDeleteAllLinksModal) {
			console.error('confirmDeleteAllLinksModal not found');
			return;
		}

		this.modalService.open(this.confirmDeleteAllLinksModal, {
			size: 'md',
			centered: true,
			backdrop: true,
			keyboard: true,
			animation: true
		});
	}

	// Method to delete all links
	public deleteAllLinks(): void {
		if (!this.evenement.urlEvents || this.evenement.urlEvents.length === 0) {
			alert('Aucun lien à supprimer');
			return;
		}

		// Clear all links from the event
		this.evenement.urlEvents = [];

		// Update the event on the server
		this._evenementsService.putEvenement(this.evenement).subscribe(
			(response) => {
				console.log('All links deleted successfully');
				alert('Tous les liens ont été supprimés avec succès!');
			},
			(error) => {
				console.error('Error deleting all links:', error);
				alert('Erreur lors de la suppression des liens');
				// Reload event to restore the links list
				this.reloadEvent();
			}
		);
	}

	// Method to open confirmation modal for deleting all commentaries
	public confirmDeleteAllCommentaries(): void {
		if (!this.confirmDeleteAllCommentariesModal) {
			console.error('confirmDeleteAllCommentariesModal not found');
			return;
		}

		this.modalService.open(this.confirmDeleteAllCommentariesModal, {
			size: 'md',
			centered: true,
			backdrop: true,
			keyboard: true,
			animation: true
		});
	}

	// Method to delete all commentaries
	public deleteAllCommentaries(): void {
		if (!this.evenement.commentaries || this.evenement.commentaries.length === 0) {
			alert('Aucun commentaire à supprimer');
			return;
		}

		// Clear all commentaries from the event
		this.evenement.commentaries = [];

		// Update the event on the server
		this._evenementsService.putEvenement(this.evenement).subscribe(
			(response) => {
				console.log('All commentaries deleted successfully');
				alert('Tous les commentaires ont été supprimés avec succès!');
			},
			(error) => {
				console.error('Error deleting all commentaries:', error);
				alert('Erreur lors de la suppression des commentaires');
				// Reload event to restore the commentaries list
				this.reloadEvent();
			}
		);
	}

}

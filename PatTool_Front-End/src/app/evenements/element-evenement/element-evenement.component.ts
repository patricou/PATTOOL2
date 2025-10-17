import { Component, OnInit, Input, Output, ViewChild, EventEmitter, AfterViewInit } from '@angular/core';
import { DomSanitizer, SafeResourceUrl, SafeUrl } from '@angular/platform-browser';
import { Router } from '@angular/router';
// Removed ng2-file-upload - using native HTML file input
import { NgbModal, ModalDismissReasons, NgbRatingConfig } from '@ng-bootstrap/ng-bootstrap';
import { Database, ref, push, remove, onValue, serverTimestamp } from '@angular/fire/database';

import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { UploadedFile } from '../../model/uploadedfile';
import { Member } from '../../model/member';
import { Evenement } from '../../model/evenement';
import { environment } from '../../../environments/environment';
import { WindowRefService } from '../../services/window-ref.service';
import { FileService } from '../../services/file.service';

@Component({
	selector: 'element-evenement',
	templateUrl: './element-evenement.component.html',
	styleUrls: ['./element-evenement.component.css'],
	providers: [NgbRatingConfig]
})
export class ElementEvenementComponent implements OnInit, AfterViewInit {

	public selectedFiles: File[] = [];
	public API_URL: string = environment.API_URL;
	public API_URL4FILE: string = environment.API_URL4FILE;
	// For firebase items
	public items: Observable<any[]> = new Observable();
	public msgVal: string = '';
	// Evaluate rating
	public currentRate: number = 0;
	public safeUrlMap: SafeUrl = {} as SafeUrl;
	public safePhotosUrl: SafeUrl = {} as SafeUrl;
	// Native Window
	public nativeWindow: any;
	// Thumbnail image
	public thumbnailUrl: any = "assets/images/images.jpg";

	@Input()
	evenement: Evenement = new Evenement(new Member("", "", "", "", "", [], ""), new Date(), "", new Date(), new Date(), new Date(), "", "", "", "", [], new Date(), "", "", [], "", "", "", "", 0, 0, "");

	@Input()
	user: Member = new Member("", "", "", "", "", [], "");

	@Output()
	addMember: EventEmitter<Evenement> = new EventEmitter<Evenement>();

	@Output()
	delMember: EventEmitter<Evenement> = new EventEmitter<Evenement>();

	@Output()
	delEvenement: EventEmitter<Evenement> = new EventEmitter<Evenement>();

	@Output()
	updateEvenement: EventEmitter<Evenement> = new EventEmitter<Evenement>();

	@Output()
	updateFileUploaded: EventEmitter<Evenement> = new EventEmitter<Evenement>();

	constructor(
		private sanitizer: DomSanitizer,
		private _router: Router,
		private modalService: NgbModal,
		private database: Database,
		private ratingConfig: NgbRatingConfig,
		private _fileService: FileService,
		private winRef: WindowRefService
	) {
		// Rating config 
		this.ratingConfig.max = 10;
		this.ratingConfig.readonly = true;
		this.nativeWindow = winRef.getNativeWindow();
	}

	ngOnInit() {
		// init the rate 
		this.currentRate = 0;
		if (this.evenement.ratingMinus != null) {
			let rateClick = this.evenement.ratingMinus + this.evenement.ratingPlus;
			if (rateClick !== 0) {
				this.currentRate = (this.evenement.ratingPlus) / rateClick * 10;
			}
		}
		// sanitize the map url & photoUrl
		this.safeUrlMap = this.sanitizer.bypassSecurityTrustResourceUrl(this.evenement.map);
		this.safePhotosUrl = this.sanitizer.bypassSecurityTrustResourceUrl(this.evenement.photosUrl);
		
		// for the firebase : create a reference with evenement.id as name 
		const messagesRef = ref(this.database, this.evenement.id);
		this.items = new Observable(observer => {
			const unsubscribe = onValue(messagesRef, (snapshot) => {
				const messages: any[] = [];
				snapshot.forEach((childSnapshot) => {
					messages.push({
						id: childSnapshot.key,
						...childSnapshot.val()
					});
				});
				// Trier les messages par date/heure (plus récents en premier)
				messages.sort((a, b) => {
					// Utiliser la propriété 'priority' qui est définie comme 0 - Date.now()
					// Plus la valeur est négative, plus le message est récent
					return a.priority - b.priority;
				});
				observer.next(messages);
			}, (error) => {
				observer.error(error);
			});
			
			return () => unsubscribe();
		});
		// Call Thumbnail Image function
		this.setThumbnailImage();
	}
	
	public onFileSelected(event: any): void {
		const files: FileList = event.target.files;
		if (files && files.length > 0) {
			this.selectedFiles = Array.from(files);
			this.uploadFiles();
		}
	}

	private uploadFiles(): void {
		if (this.selectedFiles.length === 0) {
			console.log('No files to upload');
			return;
		}

		const formData = new FormData();
		for (let file of this.selectedFiles) {
			console.log("Uploading file:", file.name, "Size:", file.size, "Type:", file.type);
			formData.append('file', file, file.name);
		}

		// Build the correct upload URL with user ID and event ID
		const uploadUrl = `${this.API_URL4FILE}/${this.user.id}/${this.evenement.id}`;
		console.log("Upload URL:", uploadUrl);

		this._fileService.postFileToUrl(formData, this.user, uploadUrl)
			.subscribe({
				next: (response: any) => {
					console.log('File upload successful:', response);
					
					// The response should contain the uploaded file information directly
					this.handleUploadResponse(response);
					
					// Clear selected files
					this.selectedFiles = [];
					// Reset file input
					const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
					if (fileInput) {
						fileInput.value = '';
					}
					
					// Show success message
					alert('Fichiers uploadés avec succès!');
				},
				error: (error: any) => {
					console.error('File upload error:', error);
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
			});
	}

	private handleUploadResponse(response: any): void {
		try {
			console.log('Processing upload response:', response);
			
			// The response from database upload should contain the uploaded file information
			if (response && Array.isArray(response)) {
				// Response is directly an array of uploaded files
				this.addUploadedFilesToEvent(response);
			} else if (response && (response.uploadedFiles || response.files)) {
				// Response contains uploaded files in a property
				const uploadedFiles = response.uploadedFiles || response.files;
				this.addUploadedFilesToEvent(uploadedFiles);
			} else if (response && response.fieldId) {
				// Response is a single uploaded file object
				this.addUploadedFilesToEvent([response]);
			} else {
				// Fallback: create uploaded file entries based on selected files
				console.log('No file information in response, creating entries from selected files');
				this.createUploadedFileEntries();
			}
		} catch (error) {
			console.error('Error processing upload response:', error);
			// Fallback: create uploaded file entries based on selected files
			this.createUploadedFileEntries();
		}
	}

	private addUploadedFilesToEvent(uploadedFilesData: any[]): void {
		for (let fileData of uploadedFilesData) {
			const uploadedFile = new UploadedFile(
				fileData.fieldId || fileData.id || this.generateFileId(),
				fileData.fileName || fileData.name,
				fileData.fileType || fileData.type || 'unknown',
				this.user
			);
			
			// Add to event's file list if not already present
			const existingFile = this.evenement.fileUploadeds.find(f => f.fieldId === uploadedFile.fieldId);
			if (!existingFile) {
				this.evenement.fileUploadeds.push(uploadedFile);
			}
		}
		
		// Don't emit update event since the database upload already updated the event
		// this.updateFileUploaded.emit(this.evenement);
	}

	private createUploadedFileEntries(): void {
		// Fallback method: create uploaded file entries based on selected files
		for (let file of this.selectedFiles) {
			const uploadedFile = new UploadedFile(
				this.generateFileId(),
				file.name,
				file.type || 'unknown',
				this.user
			);
			
			// Add to event's file list if not already present
			const existingFile = this.evenement.fileUploadeds.find(f => f.fileName === uploadedFile.fileName);
			if (!existingFile) {
				this.evenement.fileUploadeds.push(uploadedFile);
			}
		}
		
		// Don't emit update event since the database upload already updated the event
		// this.updateFileUploaded.emit(this.evenement);
	}

	private generateFileId(): string {
		// Generate a unique file ID (you might want to use a proper UUID generator)
		return 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
	}
	// Set image thumbnail
	public setThumbnailImage() {
		if (this.evenement.fileUploadeds.length != 0) {
			this.evenement.fileUploadeds.map(fileUploaded => {
				if (fileUploaded.fileName.indexOf('thumbnail') !== -1) {
					this.getFileBlobUrl(fileUploaded.fieldId).subscribe((blob: any) => {
						console.log('blob type : ' + blob.type + " // blob.size : " + blob.size);
						let objectUrl = this.nativeWindow.URL.createObjectURL(blob);
						this.thumbnailUrl = this.sanitizer.bypassSecurityTrustUrl(objectUrl);
						let natw = this.nativeWindow;
						setTimeout(function () {
							console.log('Object revoked');
							natw.URL.revokeObjectURL(objectUrl);
						}, 5000);
					}
					);
				}
			}
			)
		};
	}
	// not used
	ngAfterViewInit() {
	}
	// delete a file uploaded linked to the evenement, update the evenement
	delFile(fieldId: string) {
		//console.log("File Id : " + fieldId);
		if (confirm("Are you sure you want to delete the file ? ")) {
			this.evenement.fileUploadeds = this.evenement.fileUploadeds.filter(fileUploaded => !(fileUploaded.fieldId == fieldId));
			this.updateFileUploaded.emit(this.evenement);
		}
	}
	// check if a map is available
	public isMapAvailable(): boolean {
		let b: boolean = !!this.evenement.map;
		// console.log("map is available " + b);
		return b;
	}
	// check if thur picture URL is available
	public isPhotosUrlAvailable(): boolean {
		let b: boolean = !!this.evenement.photosUrl;
		// console.log("map is available " + b);
		return b;
	}
	// call the modal window for del confirmation
	public deleteEvenement() {
		if (confirm("Are you sure you want to delete the event ? ")) {
			this.delEvenement.emit(this.evenement);
		}
	}
	// add the user as member
	public addMemberClick() {
		this.addMember.emit(this.evenement);
	};
	// del the user as member
	public delMemberClick() {
		this.delMember.emit(this.evenement);
	};
	// Change Status
	public changeStatusEvent(status: string) {
		if (status == "Closed") {
			this.evenement.status = "Cancel"
		} else
			if (status == "Cancel") {
				this.evenement.status = "Open"
			}
			else
				this.evenement.status = "Closed"

		this.updateEvenement.emit(this.evenement);
	};

	public isAuthor(): boolean {
		// i don't search by Id becoze sometimes the page can be diaplyed after the id is filled 
		// as it is completed by the id becoming from Mlab with an observable in membersService.completeMemberId()
		return this.evenement.author.userName == this.user.userName;
	}

	public isParticipant(): boolean {
		let b: boolean = false;
		this.evenement.members.forEach(member => {
			if (member.userName == this.user.userName) { b = true };
		}
		);
		return b;
	}

	public isAnyParticpants(): boolean {
		return this.evenement.members.length > 0;
	}

	public isAnyFiles(): boolean {
		return this.evenement.fileUploadeds.length > 0;
	}

	public isFileOwner(member: Member): boolean {
		let b: boolean = false;
		b = this.user.id == member.id
		return b;
	}
	// for modal chat
	public closeResult: string = "";

	public open(content: any) {
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

	async Send() {     
		const messagesRef = ref(this.database, this.evenement.id);
		await push(messagesRef, {
			'message': this.msgVal,
			'date': new Date().toISOString(),
			'user': {
				firstName: this.user.firstName,
				lastName: this.user.lastName,
				userName: this.user.userName
			},
			'priority': 0 - Date.now()
		});
		this.msgVal = '';
	}


	public async deleteMessage(item: any) {
		const messageRef = ref(this.database, this.evenement.id + '/' + item.id);
		await remove(messageRef);
	}
	// for file list toogle
	public tfl: boolean = true;
	public toogleFileListe() {
		this.tfl = !this.tfl;
	}
	// Rate functions
	public addRatePlus() {
		this.evenement.ratingPlus = this.evenement.ratingPlus + 1;
		this.currentRate = (this.evenement.ratingPlus) / (this.evenement.ratingMinus + this.evenement.ratingPlus) * 10;
		this.updateEvenement.emit(this.evenement);
	};
	public addRateMinus() {
		this.evenement.ratingMinus = this.evenement.ratingMinus + 1;
		this.currentRate = (this.evenement.ratingPlus) / (this.evenement.ratingMinus + this.evenement.ratingPlus) * 10;
		this.updateEvenement.emit(this.evenement);
	}
	// Get the file url with the baerer token for authentifcation
	public getFileBlobUrl(fileId: string): Observable<any> {
		return this._fileService.getFile(fileId).pipe(
			map((res: any) => {
				// Note: HttpClient returns the body directly, not as res._body
				let blob = new Blob([res], { type: 'application/octet-stream' });
				return blob;
			})
		);
	}
	// Open window when click on associate button
	public openWindows(fileId: string, fileName: string) {
		this.getFileBlobUrl(fileId).subscribe((blob: any) => {
			console.log('blob type : ' + blob.type + " // blob.size : " + blob.size);
			//IE11 & Edge
			if ((navigator as any).msSaveBlob) {
				(navigator as any).msSaveBlob(blob, fileName);
			} else {
				let natw = this.nativeWindow;
				//In FF link must be added to DOM to be clicked
				let link = natw.document.createElement('a');
				let objectUrl = natw.URL.createObjectURL(blob);
				link.href = objectUrl;
				// this method allow to give a name to the file
				link.setAttribute('download', fileName);
				natw.document.body.appendChild(link);
				link.click();
				// remove the 				
				setTimeout(function () {
					console.log('Object revoked');
					natw.document.body.removeChild(link);
					natw.URL.revokeObjectURL(objectUrl);
				}, 5000);
			}
			//this.nativeWindow.open(objectUrl);
		}
		);
	}

}

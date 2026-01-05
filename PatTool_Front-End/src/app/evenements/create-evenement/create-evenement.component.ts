import { Component, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NavigationButtonsModule } from '../../shared/navigation-buttons/navigation-buttons.module';

// Removed ngx-mydatepicker imports - using native HTML date inputs
import { Member } from '../../model/member';
import { Evenement } from '../../model/evenement';
import { UrlEvent } from '../../model/url-event';
import { Commentary } from '../../model/commentary';
import { MembersService } from '../../services/members.service';
import { EvenementsService } from '../../services/evenements.service';
import { FriendsService } from '../../services/friends.service';
import { FriendGroup } from '../../model/friend';
import { KeycloakService } from '../../keycloak/keycloak.service';
import { CommentaryEditor } from '../../commentary-editor/commentary-editor';
import { EventColorService } from '../../services/event-color.service';

@Component({
	selector: 'app-create-evenement',
	standalone: true,
	imports: [CommonModule, FormsModule, RouterModule, TranslateModule, NavigationButtonsModule, CommentaryEditor],
	templateUrl: './create-evenement.component.html',
	styleUrls: ['./create-evenement.component.css']
})
export class CreateEvenementComponent implements OnInit {

	public user: Member = new Member("", "", "", "", "", [], "");
	public evenement: Evenement = new Evenement(new Member("", "", "", "", "", [], ""), new Date(), "", new Date(), new Date(), new Date(), "", "", [], new Date(), "", "", [], "", "", "", "", 0, 0, "", [], [], undefined);
	// Removed ngx-mydatepicker options - using native HTML date inputs
	// Using native HTML date inputs instead of ngx-mydatepicker
	public author: string = "";
	public beginEventDateString: string = "";
	public endEventDateString: string = "";
	//public closeInscriptionDate: Object;
	
	// URL Events management
	public newUrlEvent: UrlEvent = new UrlEvent("", new Date(), "", "", "");
	public isAddingUrlEvent: boolean = false;
	public urlEventTypes: {id: string, label: string}[] = [
		{id: "MAP", label: "EVENTHOME.URL_TYPE_CARTE"},
		{id: "DOCUMENTATION", label: "EVENTHOME.URL_TYPE_DOCUMENTATION"},
		{id: "FICHE", label: "EVENTHOME.URL_TYPE_FICHE"},
		{id: "OTHER", label: "EVENTHOME.URL_TYPE_OTHER"},
		{id: "PHOTOS", label: "EVENTHOME.URL_TYPE_PHOTOS"},
		{id: "PHOTOFROMFS", label: "EVENTHOME.URL_TYPE_PHOTOFROMFS"},
		{id: "VIDEO", label: "EVENTHOME.URL_TYPE_VIDEO"},
		{id: "WEBSITE", label: "EVENTHOME.URL_TYPE_WEBSITE"},
		{id: "WHATSAPP", label: "EVENTHOME.URL_TYPE_WHATSAPP"}
	];

	/**
	 * Get available URL event types based on user permissions
	 * Filters out PHOTOFROMFS if user doesn't have FileSystem role
	 */
	public getAvailableUrlEventTypes(): {id: string, label: string}[] {
		if (this._keycloakService.hasFileSystemRole()) {
			return this.urlEventTypes;
		}
		// Filter out PHOTOFROMFS if user doesn't have FileSystem role
		return this.urlEventTypes.filter(type => type.id !== 'PHOTOFROMFS');
	}

	public eventTypes: {value: string, label: string}[] = [
		{ value: "11", label: "EVENTCREATION.TYPE.DOCUMENTS" },
		{ value: "12", label: "EVENTCREATION.TYPE.FICHE" },
		{ value: "3", label: "EVENTCREATION.TYPE.RUN" },
		{ value: "6", label: "EVENTCREATION.TYPE.PARTY" },
		{ value: "4", label: "EVENTCREATION.TYPE.WALK" },
		{ value: "10", label: "EVENTCREATION.TYPE.PHOTOS" },
		{ value: "9", label: "EVENTCREATION.TYPE.RANDO" },
		{ value: "2", label: "EVENTCREATION.TYPE.SKI" },
		{ value: "7", label: "EVENTCREATION.TYPE.VACATION" },
		{ value: "5", label: "EVENTCREATION.TYPE.BIKE" },
		{ value: "8", label: "EVENTCREATION.TYPE.TRAVEL" },
		{ value: "1", label: "EVENTCREATION.TYPE.VTT" },
		{ value: "13", label: "EVENTCREATION.TYPE.WINE" },
		{ value: "14", label: "EVENTCREATION.TYPE.OTHER" },
		{ value: "15", label: "EVENTCREATION.TYPE.VISIT" },
		{ value: "16", label: "EVENTCREATION.TYPE.WORK" },
		{ value: "17", label: "EVENTCREATION.TYPE.FAMILY" }
	];

	// Commentary management
	public newCommentary: Commentary = new Commentary("", "", new Date());
	public isAddingCommentary: boolean = false;
	public editingCommentaryIndex: number = -1;
	public editingCommentary: Commentary = new Commentary("", "", new Date());

	// Friend groups for visibility
	public friendGroups: FriendGroup[] = [];
	public selectedFriendGroupId: string = '';
	public selectedFriendGroupIds: string[] = [];

	constructor(public _evenementsService: EvenementsService,
		public _router: Router,
		public _memberService: MembersService,
		private translate: TranslateService,
		private _friendsService: FriendsService,
		private _keycloakService: KeycloakService,
		private eventColorService: EventColorService) {
	};

	ngOnInit() {

		this.user = this._memberService.getUser();

		// init new event fields
		this.evenement = new Evenement(this.user, new Date(), "", new Date(), new Date(), new Date(), "", "", [], new Date(), "Open", "", [], "", "", "", "", 0, 0, "public", [], [], undefined, undefined);
		this.author = this.evenement.author.firstName + " " + this.evenement.author.lastName + " / " + this.evenement.author.userName;
		
		// Initialize date strings with local timezone
		this.beginEventDateString = this.formatDateForInput(this.evenement.beginEventDate);
		this.endEventDateString = this.formatDateForInput(this.evenement.endEventDate);
		
		// Initialize newUrlEvent with current user as owner
		this.newUrlEvent = new UrlEvent("", new Date(), this.user.userName, "", "");
		
		// Initialize commentaries if not present
		if (!this.evenement.commentaries) {
			this.evenement.commentaries = [];
		}
		
		// Initialize newCommentary with current user as owner
		this.newCommentary = new Commentary(this.user.userName, "", new Date());

		// Load friend groups for visibility
		this.loadFriendGroups();

		/*this.beginEventDate = { date: { 
										year: this.evenement.beginEventDate.getFullYear() , 
										month: this.evenement.beginEventDate.getMonth() + 1 ,
										day: this.evenement.beginEventDate.getDate() } 
									  };*/
		//this.openInscriptionDate = {
		//	date: {
		//		year: this.evenement.openInscriptionDate.getFullYear(),
		//		month: this.evenement.openInscriptionDate.getMonth() + 1,
		//		day: this.evenement.openInscriptionDate.getDate()
		//	}
		//};

	};
	// change color for select placeholder 
	public typeColor: string = "#dcdcdc";
	public diffColor: string = "#dcdcdc";
	typeChange() {
		this.typeColor = "rgb(70,74,76)";
	}

	// Sorted list of URL event types by translated label
	public getSortedUrlEventTypes(): {id: string, label: string}[] {
		return [...this.getAvailableUrlEventTypes()].sort((a, b) =>
			this.translate.instant(a.label).localeCompare(this.translate.instant(b.label))
		);
	}

	public getSortedEventTypes(): {value: string, label: string}[] {
		return [...this.eventTypes].sort((a, b) =>
			this.translate.instant(a.label).localeCompare(this.translate.instant(b.label))
		);
	}
	diffChange() {
		this.diffColor = "rgb(70,74,76)";
	}

	saveEvenement(fromform: any, isValid: boolean) {
		// Using native HTML date inputs - convert string to Date objects
		// Use the string values from the form inputs
		if (this.beginEventDateString) {
			this.evenement.beginEventDate = new Date(this.beginEventDateString);
		}
		if (this.endEventDateString) {
			this.evenement.endEventDate = new Date(this.endEventDateString);
		}
		this.evenement.openInscriptionDate = new Date(1900, 1, 1);
		this.evenement.closeInscriptionDate = new Date(1900, 1, 1);
		// note  : it is perhaps bad but  fields eventname, map and comment are passed through 2 ways binding.    
		//console.log("Result : "+ JSON.stringify(this.evenement) + " " + isValid);
		if (this.user.id == "") { alert("Not possible to save the event as the user.id is null, please logout/login") }
		else {
		this._evenementsService.postEvenement(this.evenement).subscribe(
			res => this._router.navigate(['even']), 
			err => {
				if (err.status === 403) {
					// Check the error type from backend response
					const errorType = err.error?.error || err.error?.errorType;
					if (errorType === 'FRIEND_GROUP_UNAUTHORIZED') {
						alert(this.translate.instant('EVENTCREATION.FRIEND_GROUP_UNAUTHORIZED'));
					} else if (errorType === 'PHOTOFROMFS_UNAUTHORIZED') {
						alert(this.translate.instant('EVENTCREATION.PHOTOFROMFS_UNAUTHORIZED_SAVE'));
					} else {
						// Default to PHOTOFROMFS message for backward compatibility
						alert(this.translate.instant('EVENTCREATION.PHOTOFROMFS_UNAUTHORIZED_SAVE'));
					}
				} else {
					alert("Error when creating the Event : " + err);
				}
			}
		);
		}
	};

	// Removed onDateChanged method - using native HTML date inputs

	private formatDateForInput(date: Date): string {
		if (!date) return '';
		const d = new Date(date);
		
		// Format pour datetime-local en utilisant la zone horaire locale
		const year = d.getFullYear();
		const month = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		const hours = String(d.getHours()).padStart(2, '0');
		const minutes = String(d.getMinutes()).padStart(2, '0');
		
		return `${year}-${month}-${day}T${hours}:${minutes}`;
	}

	// Methods to manage photos - REMOVED since photosUrl field has been removed
	addPhotoUrl(photoUrl: string) {
		// Method disabled - photosUrl field has been removed
		console.log('addPhotoUrl method disabled - photosUrl field has been removed');
	}

	removePhotoUrl(index: number) {
		// Method disabled - photosUrl field has been removed
		console.log('removePhotoUrl method disabled - photosUrl field has been removed');
	}
	
	// Methods to manage URL Events
	addUrlEvent() {
		if (this.newUrlEvent.link && this.newUrlEvent.link.trim() !== '' && 
			this.newUrlEvent.typeUrl && this.newUrlEvent.typeUrl.trim() !== '') {
			
			let linkValue = this.newUrlEvent.link.trim();
			
			// For PHOTOFROMFS type, check if first 4 chars are a year (YYYY)
			const typeUrl = this.newUrlEvent.typeUrl.trim().toUpperCase();
			if (typeUrl === 'PHOTOFROMFS') {
				// Check authorization before adding PHOTOFROMFS link
				if (!this.canCreatePhotoFromFsLink()) {
					alert(this.translate.instant('EVENTCREATION.PHOTOFROMFS_UNAUTHORIZED'));
					return;
				}
				linkValue = this.addYearPrefixIfNeeded(linkValue);
			}
			
			// Create a new UrlEvent instance to avoid reference issues
			const urlEvent = new UrlEvent(
				this.newUrlEvent.typeUrl.trim(),
				new Date(), // Always use current date for creation
				this.user.userName, // Use userName as owner
				linkValue,
				this.newUrlEvent.urlDescription.trim()
			);
			this.evenement.urlEvents.push(urlEvent);
			
			// Reset the form
			this.newUrlEvent = new UrlEvent("", new Date(), this.user.userName, "", "");
			this.isAddingUrlEvent = false;
		}
	}
	
	// Check if user can create PHOTOFROMFS links
	// Requires FileSystem role (matches backend authorization check)
	private canCreatePhotoFromFsLink(): boolean {
		return this._keycloakService.hasFileSystemRole();
	}

	// Handle folder selection for PHOTOFROMFS
	@ViewChild('directoryInput') directoryInput!: any;
	
	async selectDirectory() {
		// Try to use File System Access API if available (modern browsers)
		if ('showDirectoryPicker' in window) {
			try {
				const directoryHandle = await (window as any).showDirectoryPicker();
				const dirName = directoryHandle.name;
				// For PHOTOFROMFS type, check if first 4 chars are a year (YYYY)
				if (this.newUrlEvent.typeUrl && this.newUrlEvent.typeUrl.trim().toUpperCase() === 'PHOTOFROMFS') {
					this.newUrlEvent.link = this.addYearPrefixIfNeeded(dirName);
				} else {
					this.newUrlEvent.link = dirName;
				}
			} catch (error: any) {
				// User cancelled or error occurred, fall back to webkitdirectory
				if (error.name !== 'AbortError') {
					console.error('Error selecting directory:', error);
				}
				// Fall back to webkitdirectory method
				if (this.directoryInput && this.directoryInput.nativeElement) {
					this.directoryInput.nativeElement.click();
				}
			}
		} else {
			// Fall back to webkitdirectory for older browsers
			if (this.directoryInput && this.directoryInput.nativeElement) {
				this.directoryInput.nativeElement.click();
			}
		}
	}
	
	onDirectorySelected(event: any) {
		const files: FileList = event?.target?.files;
		const directoryPath = this.resolveDirectoryPathFromSelection(files);

		if (directoryPath) {
			// For PHOTOFROMFS type, check if first 4 chars are a year (YYYY)
			if (this.newUrlEvent.typeUrl && this.newUrlEvent.typeUrl.trim().toUpperCase() === 'PHOTOFROMFS') {
				this.newUrlEvent.link = this.addYearPrefixIfNeeded(directoryPath);
			} else {
				this.newUrlEvent.link = directoryPath;
			}
		}

		// Reset the input so the same directory can be selected again
		if (event?.target) {
			event.target.value = '';
		}
	}

	// Helper method to check if first 4 chars are a valid year and add prefix if needed
	private addYearPrefixIfNeeded(link: string): string {
		if (!link) {
			return link;
		}
		
		// Trim and normalize the link first
		const trimmedLink = link.trim();
		
		if (trimmedLink.length < 4) {
			return trimmedLink;
		}
		
		const firstFourChars = trimmedLink.substring(0, 4);
		
		// Check if first 4 characters are digits (YYYY format)
		const isYearFormat = /^\d{4}$/.test(firstFourChars);
		
		if (isYearFormat) {
			const year = parseInt(firstFourChars, 10);
			// Validate it's a reasonable year (1900-2100)
			if (year >= 1900 && year <= 2100) {
				// Check if it's not already prefixed with the year
				// Check for both '/' and '\' separators and also check if it's already duplicated
				const yearWithSlash = firstFourChars + '/';
				const yearWithBackslash = firstFourChars + '\\';
				const doubleYear = firstFourChars + '/' + firstFourChars;
				
				const alreadyHasSlash = trimmedLink.startsWith(yearWithSlash);
				const alreadyHasBackslash = trimmedLink.startsWith(yearWithBackslash);
				const alreadyDouble = trimmedLink.startsWith(doubleYear);
				
				if (!alreadyHasSlash && !alreadyHasBackslash && !alreadyDouble) {
					// Add the year at the start with a "/" between
					return firstFourChars + '/' + trimmedLink;
				}
			}
		}
		
		return trimmedLink;
	}

	// Handle real-time link input changes for NEW PHOTOFROMFS type
	onNewLinkInputChange(value: string) {
		// Check if this is a PHOTOFROMFS type
		const currentTypeUrl = this.newUrlEvent?.typeUrl;
		const isPhotoFromFs = currentTypeUrl && 
		                      currentTypeUrl.trim().toUpperCase() === 'PHOTOFROMFS';
		
		// Update the link value first
		if (this.newUrlEvent) {
			this.newUrlEvent.link = value;
		}
		
		// For PHOTOFROMFS type, check if first 4 chars are a year (YYYY) and add prefix if needed
		if (isPhotoFromFs && value && value.length >= 4) {
			const processedLink = this.addYearPrefixIfNeeded(value);
			
			// Only update if the processed link is different to avoid cursor jumping
			if (processedLink !== value && this.newUrlEvent) {
				// Use setTimeout to update after the input event completes
				setTimeout(() => {
					if (this.newUrlEvent) {
						this.newUrlEvent.link = processedLink;
					}
				}, 0);
			}
		}
	}
	
	// Handle new link blur event
	onNewLinkBlur() {
		// Check if this is a PHOTOFROMFS type
		const isPhotoFromFs = this.newUrlEvent?.typeUrl && 
		                      this.newUrlEvent.typeUrl.trim().toUpperCase() === 'PHOTOFROMFS';
		
		if (isPhotoFromFs && this.newUrlEvent?.link) {
			const processedLink = this.addYearPrefixIfNeeded(this.newUrlEvent.link);
			if (processedLink !== this.newUrlEvent.link) {
				this.newUrlEvent.link = processedLink;
			}
		}
	}

	private resolveDirectoryPathFromSelection(files: FileList | null | undefined): string {
		if (!files || files.length === 0) {
			return '';
		}

		const fullPath = this.extractFullPathFromFiles(files);
		if (fullPath) {
			return fullPath;
		}

		const relativePath = this.extractRelativeDirectoryFromFiles(files);
		return this.finalizePath(relativePath);
	}

	private extractFullPathFromFiles(files: FileList): string {
		const fileArray = Array.from(files) as any[];

		if (fileArray.length === 0) {
			return '';
		}

		const candidates = fileArray.filter(file => !!(file?.path || file?.mozFullPath));
		if (candidates.length === 0) {
			return '';
		}

		const firstFile = candidates[0];
		const rawFilePath: string = firstFile.path || firstFile.mozFullPath;
		if (!rawFilePath) {
			return '';
		}

		const normalizedFilePath = this.normalizePath(rawFilePath);
		const relativePaths = this.getRelativePaths(fileArray);
		const relativeDirectory = this.getRelativeDirectoryPrefix(relativePaths);
		const firstRelative = this.normalizePath(firstFile.webkitRelativePath || firstFile.name || '');

		let basePath = this.stripSuffix(normalizedFilePath, firstRelative);
		if (!basePath) {
			basePath = this.stripFilenameFromPath(normalizedFilePath);
		}

		if (relativeDirectory) {
			const combined = this.joinPaths(basePath, relativeDirectory);
			return this.finalizePath(combined);
		}

		return this.finalizePath(basePath);
	}

	private getRelativePaths(files: any[]): string[] {
		return files
			.map(file => this.normalizePath(file?.webkitRelativePath || file?.relativePath || file?.name || ''))
			.filter(path => !!path);
	}

	private getRelativeDirectoryPrefix(paths: string[]): string {
		if (paths.length === 0) {
			return '';
		}

		const splitPaths = paths.map(path => path.split('/').filter(segment => segment.length > 0));
		const firstPathParts = splitPaths[0];
		let minLength = firstPathParts.length;

		for (let i = 1; i < splitPaths.length; i++) {
			minLength = Math.min(minLength, splitPaths[i].length);
		}

		const commonParts: string[] = [];

		for (let i = 0; i < minLength; i++) {
			const segment = firstPathParts[i];
			const allMatch = splitPaths.every(parts => parts[i] === segment);
			if (allMatch) {
				commonParts.push(segment);
			} else {
				break;
			}
		}

		// Avoid returning the filename when only one file is present
		if (commonParts.length === firstPathParts.length) {
			commonParts.pop();
		}

		return commonParts.join('/');
	}

	private extractRelativeDirectoryFromFiles(files: FileList): string {
		const relativePaths = this.getRelativePaths(Array.from(files) as any[]);
		const relativeDirectory = this.getRelativeDirectoryPrefix(relativePaths);
		return this.normalizePath(relativeDirectory);
	}

	private stripFilenameFromPath(pathWithFile: string): string {
		if (!pathWithFile) {
			return '';
		}

		const normalized = this.normalizePath(pathWithFile);
		const lastSlash = normalized.lastIndexOf('/');

		if (lastSlash === -1) {
			return normalized;
		}

		return normalized.substring(0, lastSlash);
	}

	private stripSuffix(value: string, suffix: string): string {
		if (!value || !suffix) {
			return value;
		}

		if (!value.endsWith(suffix)) {
			return value;
		}

		return value.substring(0, value.length - suffix.length);
	}

	private normalizePath(path: string): string {
		if (!path) {
			return '';
		}

		const isUnc = path.startsWith('\\\\') || path.startsWith('//');
		let normalized = path.replace(/\\/g, '/');

		if (isUnc) {
			normalized = '//' + normalized.replace(/^\/+/, '');
		} else {
			normalized = normalized.replace(/\/{2,}/g, '/');
		}

		return normalized;
	}

	private joinPaths(base: string, relative: string): string {
		const normalizedBase = this.normalizePath(base).replace(/\/+$/, '');
		const normalizedRelative = this.normalizePath(relative).replace(/^\/+/, '');

		if (!normalizedRelative) {
			return normalizedBase;
		}

		if (!normalizedBase) {
			return normalizedRelative;
		}

		if (normalizedBase.endsWith(':')) {
			return `${normalizedBase}/${normalizedRelative}`;
		}

		return `${normalizedBase}/${normalizedRelative}`;
	}

	private finalizePath(path: string): string {
		if (!path) {
			return '';
		}

		const normalized = this.normalizePath(path);

		if (this.isWindowsPlatform()) {
			if (normalized.startsWith('//')) {
				return '\\\\' + normalized.substring(2).replace(/\//g, '\\');
			}

			return normalized.replace(/\//g, '\\');
		}

		return normalized;
	}

	private isWindowsPlatform(): boolean {
		if (typeof navigator === 'undefined' || !navigator) {
			return false;
		}

		const platform = (navigator as any).userAgentData?.platform || navigator.platform || '';
		return platform.toLowerCase().includes('win');
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

	getUrlTypeLabel(typeId: string): string {
		const type = this.urlEventTypes.find(t => t.id === typeId);
		return type ? type.label : typeId;
	}

	// Get URL event icon based on type
	getUrlEventIcon(urlEvent: UrlEvent): string {
		if (!urlEvent || !urlEvent.typeUrl) {
			return 'fa fa-external-link';
		}
		
		const normalizedType = urlEvent.typeUrl.trim().toUpperCase();
		
		// Check for MAP
		if (normalizedType === 'MAP' || normalizedType === 'CARTE') {
			return 'fa fa-map';
		}
		
		// Check for WEBSITE
		if (normalizedType === 'WEBSITE' || normalizedType === 'SITE' || normalizedType === 'WEB') {
			return 'fa fa-globe';
		}
		
		// Check for DOCUMENTATION
		if (normalizedType === 'DOCUMENTATION' || normalizedType === 'DOC') {
			return 'fa fa-file-alt';
		}
		
		// Check for PHOTOS
		if (normalizedType === 'PHOTOS' || normalizedType === 'PHOTO') {
			return 'fa fa-images';
		}
		
		// Check for PHOTOFROMFS
		if (normalizedType === 'PHOTOFROMFS') {
			return 'fa fa-image';
		}
		
		// Check for VIDEO
		if (normalizedType === 'VIDEO' || normalizedType === 'VIDÉO' || normalizedType === 'YOUTUBE' || normalizedType === 'VIMEO') {
			return 'fa fa-video-camera';
		}
		
		// Check for WHATSAPP
		if (normalizedType === 'WHATSAPP' || normalizedType === 'WA') {
			return 'fa fa-whatsapp';
		}
		
		// Default
		return 'fa fa-external-link';
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

	hideImageOnError(event: any) {
		const target = event.target as HTMLImageElement;
		if (target) {
			target.style.display = 'none';
		}
	}

	// Commentary management methods for commentary-editor component
	public onCommentaryAdded(commentary: Commentary): void {
		// For create mode, just add to local evenement object
		// The commentary will be saved when the event is created
		if (!this.evenement.commentaries) {
			this.evenement.commentaries = [];
		}
		// Generate a temporary ID if not present
		if (!commentary.id) {
			commentary.id = 'temp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
		}
		this.evenement.commentaries.push(commentary);
	}

	public onCommentaryUpdated(event: { commentId: string; commentary: Commentary }): void {
		// For create mode, update the commentary in local evenement object
		if (this.evenement.commentaries) {
			const index = this.evenement.commentaries.findIndex(c => c.id === event.commentId);
			if (index !== -1) {
				// Preserve the ID from the event
				event.commentary.id = event.commentId;
				this.evenement.commentaries[index] = event.commentary;
			}
		}
	}

	public onCommentaryDeleted(commentId: string): void {
		// For create mode, remove the commentary from local evenement object
		if (this.evenement.commentaries) {
			const index = this.evenement.commentaries.findIndex(c => c.id === commentId);
			if (index !== -1) {
				this.evenement.commentaries.splice(index, 1);
			}
		}
	}

	// Get calculated color for commentary editor
	public getCalculatedColor(): { r: number; g: number; b: number } | null {
		if (!this.evenement) {
			return null;
		}
		
		// For create mode, calculate color from event name if available
		if (this.evenement.evenementName) {
			return this.calculateColorFromString(this.evenement.evenementName);
		}
		
		return null;
	}

	// Calculate a color from a string (simple hash function)
	private calculateColorFromString(str: string): { r: number; g: number; b: number } {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			hash = str.charCodeAt(i) + ((hash << 5) - hash);
		}
		
		// Generate RGB values from hash
		const r = (hash & 0xFF0000) >> 16;
		const g = (hash & 0x00FF00) >> 8;
		const b = hash & 0x0000FF;
		
		// Ensure values are in valid range and not too dark or too bright
		const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
		
		return {
			r: clamp(Math.abs(r), 50, 230),
			g: clamp(Math.abs(g), 50, 230),
			b: clamp(Math.abs(b), 50, 230)
		};
	}

	// Legacy commentary management methods (kept for backward compatibility if needed)
	public addCommentary(): void {
		if (this.newCommentary.commentary && this.newCommentary.commentary.trim() !== '') {
			// Create a new Commentary instance
			const commentary = new Commentary(
				this.user.userName, // Use current user userName as commentOwner
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
		return this.user.userName.toLowerCase() === commentary.commentOwner.toLowerCase();
	}

	// Check if user can delete URL event (only owner of the link)
	public canDeleteUrlEvent(urlEvent: UrlEvent): boolean {
		return this.user.userName.toLowerCase() === urlEvent.owner.toLowerCase();
	}

	// Check if user can edit URL event (only owner of the link)
	public canEditUrlEvent(urlEvent: UrlEvent): boolean {
		return this.user.userName.toLowerCase() === urlEvent.owner.toLowerCase();
	}

	// Check if user can edit commentary (only owner of the commentary)
	public canEditCommentary(commentary: Commentary): boolean {
		return this.user.userName.toLowerCase() === commentary.commentOwner.toLowerCase();
	}

	// Check if user can edit event fields (only event author)
	public canEditEventFields(): boolean {
		return this.user.userName.toLowerCase() === this.evenement.author.userName.toLowerCase();
	}

	// Format date for display
	public formatCommentaryDate(date: Date): string {
		if (!date) return '';
		return new Date(date).toLocaleString();
	}

	// Load friend groups - only show groups where user is owner or authorized
	private loadFriendGroups() {
		this._friendsService.getFriendGroups().subscribe(
			groups => {
				// Filter to only show groups where user is owner or authorized (not just a member)
				this.friendGroups = groups.filter(group => {
					if (!group || !this.user || !this.user.id) {
						return false;
					}
					// Check if user is owner
					const isOwner = group.owner && group.owner.id === this.user.id;
					// Check if user is in authorizedUsers
					const isAuthorized = group.authorizedUsers && group.authorizedUsers.some(
						authorizedUser => authorizedUser && authorizedUser.id === this.user.id
					);
					return isOwner || isAuthorized;
				});
				// Sort friend groups alphabetically
				this.sortFriendGroups();
			},
			error => {
				console.error('Error loading friend groups:', error);
			}
		);
	}
	
	// Sort friend groups alphabetically by name
	private sortFriendGroups(): void {
		if (this.friendGroups && Array.isArray(this.friendGroups)) {
			this.friendGroups.sort((a, b) => {
				const nameA = (a.name || '').toLowerCase();
				const nameB = (b.name || '').toLowerCase();
				return nameA.localeCompare(nameB);
			});
		}
	}

	// Handle visibility change
	public onVisibilityChange() {
		if (this.evenement.visibility === 'friendGroups') {
			// Friend groups mode - initialize friendGroupIds if not already set
			if (!this.evenement.friendGroupIds) {
				this.evenement.friendGroupIds = [];
			}
			// Clear old friendGroupId for backward compatibility
			this.evenement.friendGroupId = undefined;
		} else {
			// Standard visibility (public, private, friends) - clear friendGroupIds
			this.evenement.friendGroupIds = undefined;
			this.evenement.friendGroupId = undefined;
			this.selectedFriendGroupIds = [];
			this.selectedFriendGroupId = '';
		}
	}

	// Toggle friend group selection
	public toggleFriendGroup(groupId: string, event: any): void {
		if (!this.evenement.friendGroupIds) {
			this.evenement.friendGroupIds = [];
		}
		
		if (event.target.checked) {
			// Add group if not already in the list
			if (!this.evenement.friendGroupIds.includes(groupId)) {
				this.evenement.friendGroupIds.push(groupId);
			}
		} else {
			// Remove group from the list
			const index = this.evenement.friendGroupIds.indexOf(groupId);
			if (index > -1) {
				this.evenement.friendGroupIds.splice(index, 1);
			}
		}
		
		// Update selectedFriendGroupIds for UI
		this.selectedFriendGroupIds = [...this.evenement.friendGroupIds];
	}

	// Check if a friend group is selected
	public isFriendGroupSelected(groupId: string): boolean {
		if (!this.evenement.friendGroupIds) {
			return false;
		}
		return this.evenement.friendGroupIds.includes(groupId);
	}

	// Check if visibility is friend groups mode
	public isFriendGroupsVisibility(): boolean {
		return this.evenement.visibility === 'friendGroups';
	}

	// Get friend group names for visibility display
	public getFriendGroupNames(): string {
		if (!this.evenement.friendGroupIds || this.evenement.friendGroupIds.length === 0) {
			return '';
		}
		return this.evenement.friendGroupIds
			.map(id => {
				const group = this.friendGroups.find(g => g.id === id);
				return group ? group.name : id;
			})
			.join(', ');
	}

}

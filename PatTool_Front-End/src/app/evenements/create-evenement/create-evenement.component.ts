import { Component, OnInit, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';

// Removed ngx-mydatepicker imports - using native HTML date inputs
import { Member } from '../../model/member';
import { Evenement } from '../../model/evenement';
import { UrlEvent } from '../../model/url-event';
import { Commentary } from '../../model/commentary';
import { MembersService } from '../../services/members.service';
import { EvenementsService } from '../../services/evenements.service';

@Component({
	selector: 'app-create-evenement',
	templateUrl: './create-evenement.component.html',
	styleUrls: ['./create-evenement.component.css']
})
export class CreateEvenementComponent implements OnInit {

	public user: Member = new Member("", "", "", "", "", [], "");
	public evenement: Evenement = new Evenement(new Member("", "", "", "", "", [], ""), new Date(), "", new Date(), new Date(), new Date(), "", "", [], new Date(), "", "", [], "", "", "", "", 0, 0, "", [], []);
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
		{id: "WEBSITE", label: "EVENTHOME.URL_TYPE_WEBSITE"}
	];

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
		{ value: "1", label: "EVENTCREATION.TYPE.VTT" }
	];

	// Commentary management
	public newCommentary: Commentary = new Commentary("", "", new Date());
	public isAddingCommentary: boolean = false;
	public editingCommentaryIndex: number = -1;
	public editingCommentary: Commentary = new Commentary("", "", new Date());

	constructor(public _evenementsService: EvenementsService,
		public _router: Router,
		public _memberService: MembersService,
		private translate: TranslateService) {
	};

	ngOnInit() {

		this.user = this._memberService.getUser();

		// init new event fields
		this.evenement = new Evenement(this.user, new Date(), "", new Date(), new Date(), new Date(), "", "", [], new Date(), "Open", "", [], "", "", "", "", 0, 0, "public", [], []);
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
		return [...this.urlEventTypes].sort((a, b) =>
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
			this._evenementsService.postEvenement(this.evenement).subscribe(res => this._router.navigate(['even']), err => alert("Error when creating the Event : " + err));
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

	// Handle folder selection for PHOTOFROMFS
    
	
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

	// Commentary management methods
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

}

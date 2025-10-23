import { Component, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Evenement } from '../../model/evenement';
import { EvenementsService } from '../../services/evenements.service';

// Removed ngx-mydatepicker imports - using native HTML date inputs
import { Member } from '../../model/member';
import { UrlEvent } from '../../model/url-event';
import { Commentary } from '../../model/commentary';
import { MembersService } from '../../services/members.service';

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
	public newCommentary: Commentary = new Commentary(new Member("", "", "", "", "", [], ""), "", new Date());
	public isAddingCommentary: boolean = false;
	public editingCommentaryIndex: number = -1;
	public editingCommentary: Commentary = new Commentary(new Member("", "", "", "", "", [], ""), "", new Date());

	constructor(private _route: ActivatedRoute,
		private _evenementsService: EvenementsService,
		private _router: Router,
		private _memberService: MembersService
	) { }

	ngOnInit() {
		// Initialize user
		this.user = this._memberService.getUser();
		
		let id: string = this._route.snapshot.params['id'];
		this._evenementsService.getEvenement(id).subscribe
			(evenement => {
				//console.log("EVenement : " + JSON.stringify(evenement));
				this.evenement = evenement;
				this.author = evenement.author.firstName + " " + evenement.author.lastName;
				
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
				this.newCommentary = new Commentary(this.user, "", new Date());
				
				// Convert dates to string format for native HTML date inputs
				this.beginEventDateString = this.formatDateForInput(this.evenement.beginEventDate);
				this.openInscriptionDateString = this.formatDateForInput(this.evenement.openInscriptionDate);
				this.endEventDateString = this.formatDateForInput(this.evenement.endEventDate);
				this.closeInscriptionDateString = this.formatDateForInput(this.evenement.closeInscriptionDate);
			}
			)
	}

	private formatDateForInput(date: Date): string {
		if (!date) return '';
		const d = new Date(date);
		return d.toISOString().slice(0, 16); // Format: YYYY-MM-DDTHH:MM
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
			this.evenement.urlEvents.splice(index, 1);
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
		this.evenement.beginEventDate = new Date(fromform.beginEventDate);
		this.evenement.endEventDate = new Date(fromform.endEventDate);
		this.evenement.openInscriptionDate = new Date(fromform.openInscriptionDate);
		this.evenement.closeInscriptionDate = new Date(fromform.closeInscriptionDate);	
		// note  : it is perhaps bad but  fields eventname, map and comment are passed through 2 ways binding.    
		//console.log("Result : "+ JSON.stringify(this.evenement) + " " + isValid);
		this._evenementsService.putEvenement(this.evenement).subscribe(res => this._router.navigate(['even']), err => alert("Error when updating the Event" + err));
	}

	// Commentary management methods
	public addCommentary(): void {
		if (this.newCommentary.commentary && this.newCommentary.commentary.trim() !== '') {
			// Create a new Commentary instance
			const commentary = new Commentary(
				this.user, // Use current user as owner
				this.newCommentary.commentary.trim(),
				new Date() // Use current date
			);
			
			this.evenement.commentaries.push(commentary);
			
			// Reset the form
			this.newCommentary = new Commentary(this.user, "", new Date());
			this.isAddingCommentary = false;
		}
	}

	// Cancel adding commentary
	public cancelAddCommentary(): void {
		this.newCommentary = new Commentary(this.user, "", new Date());
		this.isAddingCommentary = false;
	}

	// Delete a commentary
	public deleteCommentary(index: number): void {
		if (confirm("Are you sure you want to delete this commentary?")) {
			if (index >= 0 && index < this.evenement.commentaries.length) {
				this.evenement.commentaries.splice(index, 1);
			}
		}
	}

	// Start editing commentary
	public startEditCommentary(index: number): void {
		this.editingCommentaryIndex = index;
		const commentaryToEdit = this.evenement.commentaries[index];
		this.editingCommentary = new Commentary(
			commentaryToEdit.owner,
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
		this.editingCommentary = new Commentary(new Member("", "", "", "", "", [], ""), "", new Date());
		this.editingCommentaryIndex = -1;
	}

	// Check if user can delete commentary (only owner or event author)
	public canDeleteCommentary(commentary: Commentary): boolean {
		return this.user.userName === commentary.owner.userName || this.user.userName === this.evenement.author.userName;
	}

	// Format date for display
	public formatCommentaryDate(date: Date): string {
		if (!date) return '';
		return new Date(date).toLocaleString();
	}

}

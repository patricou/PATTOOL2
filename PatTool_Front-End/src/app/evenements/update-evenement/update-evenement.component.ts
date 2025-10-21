import { Component, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Evenement } from '../../model/evenement';
import { EvenementsService } from '../../services/evenements.service';

// Removed ngx-mydatepicker imports - using native HTML date inputs
import { Member } from '../../model/member';
import { UrlEvent } from '../../model/url-event';
import { MembersService } from '../../services/members.service';

@Component({
	selector: 'update-evenement',
	templateUrl: './update-evenement.component.html',
	styleUrls: ['./update-evenement.component.css']
})
export class UpdateEvenementComponent implements OnInit {

	public evenement: Evenement = new Evenement(new Member("", "", "", "", "", [], ""), new Date(), "", new Date(), new Date(), new Date(), "Nouvel Evenement !!", "", "", [], [], new Date(), "", "", [], "", "", "", "", 0, 0, "", []);
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
				
				// Initialize newUrlEvent with current user as owner
				this.newUrlEvent = new UrlEvent("", new Date(), this.user.userName, "", "");
				
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

	// Photo management methods
	addPhotoUrl(photoUrl: string) {
		if (photoUrl && photoUrl.trim() !== '') {
			this.evenement.photosUrl.push(photoUrl.trim());
		}
	}

	removePhotoUrl(index: number) {
		if (index >= 0 && index < this.evenement.photosUrl.length) {
			this.evenement.photosUrl.splice(index, 1);
		}
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
				this.user.userName, // Use userName instead of firstName + lastName
				this.newUrlEvent.link.trim(),
				this.newUrlEvent.urlDescription.trim()
			);
			this.evenement.urlEvents.push(urlEvent);
			
			// Reset the form
			this.newUrlEvent = new UrlEvent("", new Date(), this.user.userName, "", "");
		}
	}
	
	removeUrlEvent(index: number) {
		if (index >= 0 && index < this.evenement.urlEvents.length) {
			this.evenement.urlEvents.splice(index, 1);
		}
	}

	getUrlTypeLabel(typeId: string): string {
		const type = this.urlEventTypes.find(t => t.id === typeId);
		return type ? type.label : typeId;
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

}

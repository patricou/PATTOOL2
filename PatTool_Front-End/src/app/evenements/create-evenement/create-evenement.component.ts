import { Component, OnInit, ViewChild } from '@angular/core';
import { Router } from '@angular/router';

// Removed ngx-mydatepicker imports - using native HTML date inputs
import { Member } from '../../model/member';
import { Evenement } from '../../model/evenement';
import { UrlEvent } from '../../model/url-event';
import { MembersService } from '../../services/members.service';
import { EvenementsService } from '../../services/evenements.service';

@Component({
	selector: 'app-create-evenement',
	templateUrl: './create-evenement.component.html',
	styleUrls: ['./create-evenement.component.css']
})
export class CreateEvenementComponent implements OnInit {

	public user: Member = new Member("", "", "", "", "", [], "");
	public evenement: Evenement = new Evenement(new Member("", "", "", "", "", [], ""), new Date(), "", new Date(), new Date(), new Date(), "", "", "", [], [], new Date(), "", "", [], "", "", "", "", 0, 0, "", []);
	// Removed ngx-mydatepicker options - using native HTML date inputs
	// Using native HTML date inputs instead of ngx-mydatepicker
	public author: string = "";
	public beginEventDateString: string = "";
	public endEventDateString: string = "";
	//public closeInscriptionDate: Object;
	
	// URL Events management
	public newUrlEvent: UrlEvent = new UrlEvent("", new Date(), "", "", "");
	public urlEventTypes: {id: string, label: string}[] = [
		{id: "MAP", label: "EVENTHOME.URL_TYPE_CARTE"},
		{id: "DOCUMENTATION", label: "EVENTHOME.URL_TYPE_DOCUMENTATION"},
		{id: "OTHER", label: "EVENTHOME.URL_TYPE_OTHER"},
		{id: "PHOTOS", label: "EVENTHOME.URL_TYPE_PHOTOS"},
		{id: "WEBSITE", label: "EVENTHOME.URL_TYPE_WEBSITE"}
	];

	constructor(public _evenementsService: EvenementsService,
		public _router: Router,
		public _memberService: MembersService) {
	};

	ngOnInit() {

		this.user = this._memberService.getUser();

		// init new event fields
		this.evenement = new Evenement(this.user, new Date(), "", new Date(), new Date(), new Date(), "", "", "", [], [], new Date(), "Open", "", [], "", "", "", "", 0, 0, "public", []);
		this.author = this.evenement.author.firstName + " " + this.evenement.author.lastName;
		
		// Initialize newUrlEvent with current user as owner
		this.newUrlEvent = new UrlEvent("", new Date(), this.user.userName, "", "");

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
	diffChange() {
		this.diffColor = "rgb(70,74,76)";
	}

	saveEvenement(fromform: any, isValid: boolean) {
		// Using native HTML date inputs - convert string to Date objects
		this.evenement.beginEventDate = new Date(fromform.beginEventDate);
		this.evenement.endEventDate = new Date(fromform.endEventDate);
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

	// Methods to manage photos
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

	hideImageOnError(event: any) {
		const target = event.target as HTMLImageElement;
		if (target) {
			target.style.display = 'none';
		}
	}

}

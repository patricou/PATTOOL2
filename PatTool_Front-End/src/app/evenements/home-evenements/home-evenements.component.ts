import { Component, OnInit, HostListener, ElementRef, AfterViewInit, ViewChild, OnDestroy, TemplateRef } from '@angular/core';
import { Observable, fromEvent } from 'rxjs';
import { debounceTime, map } from 'rxjs/operators';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { NgbModal, ModalDismissReasons } from '@ng-bootstrap/ng-bootstrap';
import { TranslateService } from '@ngx-translate/core';
import { Database, ref, push, remove, onValue } from '@angular/fire/database';

import { Evenement } from '../../model/evenement';
import { MembersService } from '../../services/members.service';
import { Member } from '../../model/member';
import { Router } from '@angular/router';
import { WindowRefService } from '../../services/window-ref.service';
import { FileService } from '../../services/file.service';
import { CommonvaluesService } from '../../services/commonvalues.service';
import { EvenementsService } from '../../services/evenements.service';
import { environment } from '../../../environments/environment';

export enum KEY_CODE {
	RIGHT_ARROW = 39,
	LEFT_ARROW = 37
}

@Component({
	selector: 'home-evenements',
	templateUrl: './home-evenements.component.html',
	styleUrls: ['./home-evenements.component.css']
})
export class HomeEvenementsComponent implements OnInit, AfterViewInit, OnDestroy {

	public evenements: Evenement[] = [];
	public user: Member = new Member("", "", "", "", "", [], "");
	public totalElements: number = 0;
	public totalPages: number = 0;
	public pageNumber: number = this._commonValuesService.getPageNumber();
	public elementsByPage: number = this._commonValuesService.getElementsByPage();
	public dataFIlter: string = this._commonValuesService.getDataFilter();
	public pages: number[] = [];
	public visible: boolean = false;
	public isCompactView: boolean = false;
	public thumbnailCache: Map<string, SafeUrl> = new Map();
	public eventThumbnails: Map<string, SafeUrl> = new Map();
	public nativeWindow: any;
	public selectedEventPhotos: string[] = [];
	public selectedEvent: Evenement = new Evenement(new Member("", "", "", "", "", [], ""), new Date(), "", new Date(), new Date(), new Date(), "", "", [], new Date(), "", "", [], "", "", "", "", 0, 0, "", [], []);
	public selectedEventName: string = '';
	public msgVal: string = '';
	public items: Observable<any> = new Observable();
	@ViewChild('searchterm')
	public searchterm!: ElementRef;
	@ViewChild('photosModal') photosModal!: TemplateRef<any>;
	@ViewChild('urlsModal') urlsModal!: TemplateRef<any>;
	@ViewChild('chatModal') chatModal!: TemplateRef<any>;
	@ViewChild('chatMessagesContainer') chatMessagesContainer!: ElementRef;

	constructor(private _evenementsService: EvenementsService,
		private _memberService: MembersService,
		private _fileService: FileService,
		private _router: Router,
		private _commonValuesService: CommonvaluesService,
		private sanitizer: DomSanitizer,
		private winRef: WindowRefService,
		private modalService: NgbModal,
		private translateService: TranslateService,
		private database: Database) {
		this.nativeWindow = winRef.getNativeWindow();
	}

	ngOnInit() {
		this.user = this._memberService.getUser();
		this.getEvents(this.dataFIlter);
		
		// Scroll to top when component loads
		this.scrollToTop();
	}

	ngAfterViewInit() {
		// used to not have to press enter when filter
		const eventObservable = fromEvent(this.searchterm.nativeElement, 'input')
			.pipe(debounceTime(700));

		eventObservable.subscribe(
			((data: any) => {
				this.pageNumber = 0;
				this._commonValuesService.setPageNumber(this.pageNumber);
				this.dataFIlter = data.target.value;
				this._commonValuesService.setDataFilter(this.dataFIlter);
				this.getEvents(this.dataFIlter);
			}),
			((err: any) => console.error(err)),
			() => console.log('complete')
		)
	}

	private waitForNonEmptyValue(): Promise<void> {
		return new Promise<void>((resolve) => {
			const checkValue = () => {
				if (this.user.id !== "") {
					resolve();
				} else {
					let now = new Date();
					console.log("This.user.id is still empty " + now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds() + '.' + now.getMilliseconds());
					setTimeout(checkValue, 100); // Appeler checkValue de manière récursive après 100ms
				}
			};
			checkValue(); // Déclencher la première vérification
		});
	}

	// Get the evenements list with pagination
	public getEvents(data: any) {
		let searchString: string = "*";
		if (data !== "")
			searchString = data == "" ? "*" : data;

		this.waitForNonEmptyValue().then(() => {
			let now = new Date();

			console.log("4|------------------> This.user.id is no more null ( from HomeEvenementsComponent ) :", this.user.id + " at " + now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds() + '.' + now.getMilliseconds());

			this._evenementsService
				.getEvents(searchString, this.pageNumber, this.elementsByPage, this.user.id)
				.subscribe((res: any) => {
					this.evenements = res.content;
					this.totalElements = res.page.totalElements;
					this.totalPages = res.page.totalPages;
					this.pageNumber = res.page.number;
					this._commonValuesService.setPageNumber(this.pageNumber);
					this.pages = Array.from(Array(this.totalPages), (x, i) => i);
				},
					(err: any) => alert("Error when getting Events " + JSON.stringify(this.user))
				);
		});
	};

	public addMemberInEvent(evenement: Evenement) {
		//console.log("addMemberInEvent " + JSON.stringify(evenement));
		// put the user logged in the venemen as member
		evenement.members.push(this.user);
		// save the evenement ( does an Update )
		this._evenementsService.putEvenement(evenement).subscribe(
			(res: any) => // console.log("I participe return ok " ),
				(err: any) => alert("Error when deleting participant " + err));
	}

	public delMemberInEvent(evenement: Evenement) {
		//console.log("delMemberInEvent " + JSON.stringify(evenement));
		// put the user logged in the venemen as member    
		let members: Member[] = evenement.members;
		// remove the member
		evenement.members = members.filter(memb => !(memb.id == this.user.id));
		// save the evenement ( does an Update )
		this._evenementsService.putEvenement(evenement).subscribe(
			(res: any) => // console.log("I don't participe in evenement ok "),
				(err: any) => alert("Error when deleting participant " + err));
	}

	public delEvent(evenement: Evenement) {
		this._evenementsService.delEvenement(evenement.id)
			.subscribe(
				(res: any) => {  //  update evenements for screen update			
					this.getEvents(this.dataFIlter);
				},
				(err: any) => {
					console.log("Del evenement error : " + err);
					alert("Issue when deleting the event : " + err);
				}
			);
	}

	public updEvent(evenement: Evenement) {
		this._evenementsService.putEvenement(evenement)
			.subscribe((resp: any) => // console.log("Update Status OK "),
				(err: any) => alert("Update Status Error : " + err));
	}

	public changeStatusEvent(evenement: Evenement) {
		if (evenement.status == "Closed") {
			evenement.status = "Cancel"
		} else if (evenement.status == "Cancel") {
			evenement.status = "Open"
		} else {
			evenement.status = "Closed"
		}
		this.updEvent(evenement);
	}

	// Méthodes pour les actions des événements dans la vue compacte
	public isAuthor(evenement: Evenement): boolean {
		return evenement.author.userName == this.user.userName;
	}

	public isParticipant(evenement: Evenement): boolean {
		return evenement.members.some(member => member.userName == this.user.userName);
	}



	public isAnyFiles(evenement: Evenement): boolean {
		return evenement.fileUploadeds && evenement.fileUploadeds.length > 0;
	}

	public deleteEvenement(evenement: Evenement) {
		if (confirm("Are you sure you want to delete the event ? ")) {
			this.delEvent(evenement);
		}
	}

	public toggleFileList(evenement: Evenement) {
		// Cette méthode pourrait être implémentée si nécessaire
		console.log('Toggle file list for event:', evenement.evenementName);
	}

	public openPhotosModal(evenement: Evenement) {
		// Ouvrir le modal des photos pour l'événement
		console.log('Opening photos modal for event:', evenement.evenementName);
		
		// No photos available since photosUrl field has been removed
		console.log('No photos available - photosUrl field has been removed');
	}

	public openPhotoInNewTab(url: string) {
		this.nativeWindow.open(url, '_blank');
	}

	public isUrlEventsAvailable(evenement: Evenement): boolean {
		return evenement.urlEvents && evenement.urlEvents.length > 0;
	}

	public getUrlEventsCount(evenement: Evenement): number {
		return evenement.urlEvents ? evenement.urlEvents.length : 0;
	}

	public openUrlsModal(evenement: Evenement) {
		console.log('Opening URLs modal for event:', evenement.evenementName);
		console.log('UrlEvents data:', evenement.urlEvents);
		
		this.selectedEvent = evenement;
		this.selectedEventName = evenement.evenementName;
		
		this.modalService.open(this.urlsModal, { 
			size: 'lg',
			backdrop: true,
			keyboard: true,
			animation: true,
			centered: true
		}).result.then((result) => {
			console.log('URLs modal closed with:', result);
		}, (reason) => {
			console.log('URLs modal dismissed:', reason);
		});
	}

	public getUrlTypeLabel(typeUrl: string): string {
		// Normaliser le type en supprimant les espaces et en convertissant en majuscules
		const normalizedType = typeUrl?.trim().toUpperCase() || 'OTHER';
		
		const urlEventTypes = [
			{id: "MAP", label: "EVENTHOME.URL_TYPE_CARTE", aliases: ["CARTE", "CARTA", "KARTE", "MAPA", "地图", "خريطة"]},
			{id: "DOCUMENTATION", label: "EVENTHOME.URL_TYPE_DOCUMENTATION", aliases: ["DOC", "DOCUMENT", "DOCS", "文档", "وثائق"]},
			{id: "OTHER", label: "EVENTHOME.URL_TYPE_OTHER", aliases: ["AUTRE", "OTRO", "ANDERE", "其他", "أخرى"]},
			{id: "PHOTOS", label: "EVENTHOME.URL_TYPE_PHOTOS", aliases: ["PHOTO", "PHOTOS", "IMAGES", "PICTURES", "照片", "صور"]},
			{id: "WEBSITE", label: "EVENTHOME.URL_TYPE_WEBSITE", aliases: ["SITE", "WEB", "SITIO", "网站", "موقع"]}
		];
		
		// Chercher d'abord par ID exact
		let type = urlEventTypes.find(t => t.id === normalizedType);
		
		// Si pas trouvé, chercher dans les alias
		if (!type) {
			type = urlEventTypes.find(t => 
				t.aliases.some(alias => alias.toUpperCase() === normalizedType)
			);
		}
		
		// Si toujours pas trouvé, chercher une correspondance partielle
		if (!type) {
			type = urlEventTypes.find(t => 
				t.id.includes(normalizedType) || 
				normalizedType.includes(t.id) ||
				t.aliases.some(alias => 
					alias.includes(normalizedType) || 
					normalizedType.includes(alias)
				)
			);
		}
		
		return type ? type.label : normalizedType;
	}

	// Group URLs by type for better display
	public getGroupedUrlEvents(evenement: Evenement): { [key: string]: any[] } {
		if (!evenement.urlEvents || evenement.urlEvents.length === 0) {
			return {};
		}
		
		return evenement.urlEvents.reduce((groups: { [key: string]: any[] }, urlEvent) => {
			// Normaliser le type pour le regroupement
			const normalizedType = this.normalizeTypeForGrouping(urlEvent.typeUrl || 'OTHER');
			if (!groups[normalizedType]) {
				groups[normalizedType] = [];
			}
			groups[normalizedType].push(urlEvent);
			return groups;
		}, {});
	}

	// Normaliser le type pour le regroupement (utilise la même logique que getUrlTypeLabel)
	private normalizeTypeForGrouping(typeId: string): string {
		const normalizedType = typeId?.trim().toUpperCase() || 'OTHER';
		
		const urlEventTypes = [
			{id: "MAP", aliases: ["CARTE", "CARTA", "KARTE", "MAPA", "地图", "خريطة"]},
			{id: "DOCUMENTATION", aliases: ["DOC", "DOCUMENT", "DOCS", "文档", "وثائق"]},
			{id: "OTHER", aliases: ["AUTRE", "OTRO", "ANDERE", "其他", "أخرى"]},
			{id: "PHOTOS", aliases: ["PHOTO", "PHOTOS", "IMAGES", "PICTURES", "照片", "صور"]},
			{id: "WEBSITE", aliases: ["SITE", "WEB", "SITIO", "网站", "موقع"]}
		];
		
		// Chercher d'abord par ID exact
		let type = urlEventTypes.find(t => t.id === normalizedType);
		
		// Si pas trouvé, chercher dans les alias
		if (!type) {
			type = urlEventTypes.find(t => 
				t.aliases.some(alias => alias.toUpperCase() === normalizedType)
			);
		}
		
		// Si toujours pas trouvé, chercher une correspondance partielle
		if (!type) {
			type = urlEventTypes.find(t => 
				t.id.includes(normalizedType) || 
				normalizedType.includes(t.id) ||
				t.aliases.some(alias => 
					alias.includes(normalizedType) || 
					normalizedType.includes(alias)
				)
			);
		}
		
		return type ? type.id : 'OTHER';
	}

	// Get sorted type keys for consistent display order
	public getSortedTypeKeys(evenement: Evenement): string[] {
		const grouped = this.getGroupedUrlEvents(evenement);
		const typeOrder = ['MAP', 'DOCUMENTATION', 'WEBSITE', 'PHOTOS', 'Photos', 'OTHER'];
		return typeOrder.filter(type => grouped[type] && grouped[type].length > 0);
	}

	public updateFileUploadedInEvent(evenement: Evenement) {
		this._evenementsService.put4FileEvenement(evenement)
			.subscribe((resp: any) => // console.log("Delete file OK "),
				(err: any) => alert("Delete File Error : " + err));
	}
	// Pagination functions
	public changePage(page: number) {
		this.pageNumber = page;
		this.getEvents(this.dataFIlter);
		this.scrollToTop();
	}
	public changePreviousPage() {
		if (this.pageNumber > 0) {
			this.pageNumber = this.pageNumber - 1;
			this._commonValuesService.setPageNumber(this.pageNumber);
			this.getEvents(this.dataFIlter);
			this.scrollToTop();
		}
	}
	public changeNextPage() {
		if (this.pageNumber < this.totalPages - 1) {
			this.pageNumber = this.pageNumber + 1;
			this._commonValuesService.setPageNumber(this.pageNumber);
			this.getEvents(this.dataFIlter);
			this.scrollToTop();
		}
	}
	public changeFiltre() {
		this.pageNumber = 0;
		this._commonValuesService.setPageNumber(this.pageNumber);
		this._commonValuesService.setElementsByPage(this.elementsByPage);
		this.getEvents(this.dataFIlter);
		this.scrollToTop();
	}

	public clearFilter() {
		this.dataFIlter = "";
		this.changeFiltre();
	}

	// Allow to use arrow for pagination
	@HostListener('window:keyup', ['$event'])
	keyEvent(event: KeyboardEvent) {
		if (event.keyCode === KEY_CODE.RIGHT_ARROW) {
			this.changeNextPage();
		}
		if (event.keyCode === KEY_CODE.LEFT_ARROW) {
			this.changePreviousPage();
		}
	}

	public checkVisibility(evenement: Evenement) {
		console.log(evenement.evenementName + " --> visibility : " + evenement.visibility);
		console.log(evenement.evenementName + " --> Author : " + JSON.stringify(evenement.author.id));
		console.log(evenement.evenementName + " --> Current user : " + this.user.id);
		console.log("visibility = " + (evenement.visibility === null || evenement.visibility === 'public') || (evenement.visibility === 'private' && evenement.author.id === this.user.id));
		this.visible = (evenement.visibility === null || evenement.visibility === 'public') || (evenement.visibility === 'private' && evenement.author.id === this.user.id);
	}

	// Méthodes pour la vue compacte
	public toggleViewMode() {
		this.isCompactView = !this.isCompactView;
	}


	public getEventThumbnail(evenement: Evenement): SafeUrl {
		// Vérifier si on a déjà cette thumbnail en cache
		if (this.eventThumbnails.has(evenement.id)) {
			const cachedUrl = this.eventThumbnails.get(evenement.id);
			if (cachedUrl) {
				return cachedUrl;
			}
		}

		// Chercher un fichier avec "thumbnail" dans le nom
		const thumbnailFile = evenement.fileUploadeds?.find(file => 
			file.fileName && file.fileName.toLowerCase().includes('thumbnail')
		);
		
		if (thumbnailFile) {
			// Charger l'image via le service de fichiers pour l'authentification
			this.loadThumbnailFromFile(evenement.id, thumbnailFile.fieldId);
			// Retourner l'image par défaut en attendant le chargement
			const defaultUrl = this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg");
			this.eventThumbnails.set(evenement.id, defaultUrl);
			return defaultUrl;
		}
		
		const defaultUrl = this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg");
		this.eventThumbnails.set(evenement.id, defaultUrl);
		return defaultUrl;
	}

	private loadThumbnailFromFile(eventId: string, fileId: string): void {
		this._fileService.getFile(fileId).pipe(
			map((res: any) => {
				let blob = new Blob([res], { type: 'application/octet-stream' });
				return blob;
			})
		).subscribe((blob: any) => {
			let objectUrl = this.nativeWindow.URL.createObjectURL(blob);
			let safeUrl = this.sanitizer.bypassSecurityTrustUrl(objectUrl);
			
			// Mettre à jour l'URL dans le cache des événements
			this.eventThumbnails.set(eventId, safeUrl);
			
			// Ne pas révoquer l'URL blob immédiatement - la garder en mémoire
			// L'URL sera automatiquement révoquée quand le composant sera détruit
		}, (error: any) => {
			console.error('Error loading thumbnail for event:', eventId, error);
			// En cas d'erreur, utiliser l'image par défaut
			this.eventThumbnails.set(eventId, this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg"));
		});
	}

	public formatEventDate(date: Date): string {
		if (!date) return '';
		
		const eventDate = new Date(date);
		const now = new Date();
		const diffTime = eventDate.getTime() - now.getTime();
		const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
		
		if (diffDays === 0) {
			return "Aujourd'hui";
		} else if (diffDays === 1) {
			return "Demain";
		} else if (diffDays === -1) {
			return "Hier";
		} else if (diffDays > 0) {
			return `Dans ${diffDays} jour${diffDays > 1 ? 's' : ''}`;
		} else {
			return `Il y a ${Math.abs(diffDays)} jour${Math.abs(diffDays) > 1 ? 's' : ''}`;
		}
	}

	public openEventDetails(evenement: Evenement) {
		// Navigation vers la page de détails de l'événement
		this._router.navigate(['/updeven', evenement.id]);
	}

	public onImageError(event: any) {
		const target = event.target as HTMLImageElement;
		if (target) {
			target.src = "assets/images/images.jpg";
		}
	}

	public hideImageOnError(event: any) {
		const target = event.target as HTMLImageElement;
		if (target) {
			target.style.display = 'none';
		}
	}

	// Méthodes pour le chat - utilisant la même logique que element-evenement
	public openChatModal(evenement: Evenement) {
		this.selectedEvent = evenement;
		this.selectedEventName = evenement.evenementName;
		
		// Utiliser Firebase comme dans element-evenement
		const messagesRef = ref(this.database, evenement.id);
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
				console.error('Error loading messages:', error);
				observer.error(error);
			});
			
			// Retourner la fonction de nettoyage
			return () => unsubscribe();
		});
		
		// Utiliser la même méthode que element-evenement
		this.open(this.chatModal);
	}

	// Méthode identique à celle d'element-evenement
	public closeResult: string = "";

	public open(content: any) {
		this.modalService.open(content).result.then((result) => {
			this.closeResult = `Closed with: ${result}`;
		}, (reason) => {
			this.closeResult = `Dismissed ${this.getDismissReason(reason)}`;
		});
	}

	private getDismissReason(reason: any): string {
		if (reason === ModalDismissReasons.ESC) {
			return 'by pressing ESC';
		} else if (reason === ModalDismissReasons.BACKDROP_CLICK) {
			return 'by clicking on a backdrop';
		} else {
			return `with: ${reason}`;
		}
	}

	public async Send() {
		if (this.msgVal.trim() !== '') {
			const messagesRef = ref(this.database, this.selectedEvent.id);
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
			// Faire défiler vers le bas après l'envoi
			setTimeout(() => this.scrollToBottom(), 100);
		}
	}

	private scrollToBottom(): void {
		if (this.chatMessagesContainer) {
			const element = this.chatMessagesContainer.nativeElement;
			element.scrollTop = element.scrollHeight;
		}
	}

	public async deleteMessage(item: any) {
		const messageRef = ref(this.database, this.selectedEvent.id + '/' + item.id);
		await remove(messageRef);
	}

	ngOnDestroy() {
		// Nettoyer toutes les URLs blob pour éviter les fuites mémoire
		this.eventThumbnails.forEach((safeUrl, eventId) => {
			try {
				// SafeUrl peut être un objet, on doit extraire la valeur string
				const url = safeUrl && typeof safeUrl === 'object' && 'changingThisBreaksApplicationSecurity' in safeUrl 
					? safeUrl['changingThisBreaksApplicationSecurity'] 
					: safeUrl as string;
				
				if (url && typeof url === 'string' && url.startsWith('blob:')) {
					this.nativeWindow.URL.revokeObjectURL(url);
				}
			} catch (error) {
				// Ignorer les erreurs lors du nettoyage
				console.warn('Error cleaning up blob URL:', error);
			}
		});
		this.eventThumbnails.clear();
	}
	
	// Scroll to top of the page
	private scrollToTop(): void {
		this.nativeWindow.scrollTo(0, 0);
	}
}

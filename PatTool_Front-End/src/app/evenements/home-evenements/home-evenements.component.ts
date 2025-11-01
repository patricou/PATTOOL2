import { Component, OnInit, HostListener, ElementRef, AfterViewInit, ViewChild, OnDestroy, TemplateRef } from '@angular/core';
import { Observable, fromEvent, Subscription } from 'rxjs';
import { debounceTime, map } from 'rxjs/operators';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { NgbModal, ModalDismissReasons } from '@ng-bootstrap/ng-bootstrap';
import { TranslateService } from '@ngx-translate/core';
import { Database, ref, push, remove, onValue } from '@angular/fire/database';

import { Evenement } from '../../model/evenement';
import { MembersService } from '../../services/members.service';
import { Member } from '../../model/member';
import { UrlEvent } from '../../model/url-event';
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
	public controlsCollapsed: boolean = false;
	public thumbnailCache: Map<string, SafeUrl> = new Map();
	public eventThumbnails: Map<string, SafeUrl> = new Map();
	public nativeWindow: any;
	public selectedEventPhotos: string[] = [];
	public selectedEvent: Evenement = new Evenement(new Member("", "", "", "", "", [], ""), new Date(), "", new Date(), new Date(), new Date(), "", "", [], new Date(), "", "", [], "", "", "", "", 0, 0, "", [], []);
	public selectedEventName: string = '';
	public selectedImageUrl: SafeUrl | string = '';
	public selectedImageAlt: string = '';
	public selectedUser: Member | null = null;
	public msgVal: string = '';
	public items: Observable<any> = new Observable();
	@ViewChild('searchterm')
	public searchterm!: ElementRef;
	@ViewChild('photosModal') photosModal!: TemplateRef<any>;
	@ViewChild('imageModal') imageModal!: TemplateRef<any>;
	@ViewChild('urlsModal') urlsModal!: TemplateRef<any>;
	@ViewChild('chatModal') chatModal!: TemplateRef<any>;
	@ViewChild('jsonModal') jsonModal!: TemplateRef<any>;
	@ViewChild('userModal') userModal!: TemplateRef<any>;
	@ViewChild('commentsModal') commentsModal!: TemplateRef<any>;
	@ViewChild('chatMessagesContainer') chatMessagesContainer!: ElementRef;
	@ViewChild('slideshowModal') slideshowModal!: TemplateRef<any>;
	@ViewChild('fsPhotosSelectorModal') fsPhotosSelectorModal!: TemplateRef<any>;
	@ViewChild('slideshowContainer') slideshowContainerRef!: ElementRef;
	@ViewChild('slideshowImgEl') slideshowImgElRef!: ElementRef<HTMLImageElement>;

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
		
		// Initialize controls collapsed state based on screen size
		if (this.nativeWindow.innerWidth <= 767) {
			this.controlsCollapsed = true;
		}
		
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
					// console.log("This.user.id is still empty " + now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds() + '.' + now.getMilliseconds());
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

			// console.log("4|------------------> This.user.id is no more null ( from HomeEvenementsComponent ) :", this.user.id + " at " + now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds() + '.' + now.getMilliseconds());

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

	public async delEvent(evenement: Evenement) {
		// Delete Firebase chat messages first
		try {
			const messagesRef = ref(this.database, evenement.id);
			await remove(messagesRef);
			console.log("Firebase chat messages deleted for event: " + evenement.id);
		} catch (error) {
			console.error("Error deleting Firebase chat messages:", error);
			// Continue with event deletion even if Firebase deletion fails
		}
		
		// Then delete the event from backend
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
		// Count associated data
		const fileCount = evenement.fileUploadeds ? evenement.fileUploadeds.length : 0;
		const urlCount = evenement.urlEvents ? evenement.urlEvents.length : 0;
		const commentaryCount = evenement.commentaries ? evenement.commentaries.length : 0;
		
		// Build detailed confirmation message
		let confirmMessage = this.translateService.instant('EVENTELEM.DELETE_EVENT_CONFIRM_MESSAGE') + '\n\n';
		
		if (fileCount > 0) {
			confirmMessage += this.translateService.instant('EVENTELEM.DELETE_EVENT_CONFIRM_FILES', { count: fileCount }) + '\n';
		}
		if (urlCount > 0) {
			confirmMessage += this.translateService.instant('EVENTELEM.DELETE_EVENT_CONFIRM_URLS', { count: urlCount }) + '\n';
		}
		if (commentaryCount > 0) {
			confirmMessage += this.translateService.instant('EVENTELEM.DELETE_EVENT_CONFIRM_COMMENTARIES', { count: commentaryCount }) + '\n';
		}
		
		// Always mention chat messages (Firebase) regardless of count
		confirmMessage += this.translateService.instant('EVENTELEM.DELETE_EVENT_CONFIRM_CHAT');
		
		if (confirm(confirmMessage)) {
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
	public changePage(page: number | string) {
		// Convert to number if it's a string (from select box)
		const pageNum = typeof page === 'string' ? parseInt(page, 10) : page;
		this.pageNumber = pageNum;
		this._commonValuesService.setPageNumber(this.pageNumber);
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
		// Don't handle arrow keys if a modal is open
		const modal = document.querySelector('.modal.show');
		if (modal) {
			return;
		}
		
		// Don't handle arrow keys if we're in fullscreen mode (slideshow fullscreen)
		const isFullscreenActive = !!(document.fullscreenElement || (document as any).webkitFullscreenElement || 
			(document as any).mozFullScreenElement || (document as any).msFullscreenElement);
		if (isFullscreenActive) {
			return;
		}
		
		// Check if target is an input or textarea
		const target = event.target as HTMLElement;
		if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
			return;
		}
		
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
	public toggleControlsCollapse(): void {
		this.controlsCollapsed = !this.controlsCollapsed;
	}

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
		
		// Mapper la langue actuelle à la locale appropriée
		const currentLang = this.translateService.currentLang || 'fr';
		const localeMap: { [key: string]: string } = {
			'fr': 'fr-FR',
			'en': 'en-US',
			'es': 'es-ES',
			'de': 'de-DE',
			'it': 'it-IT',
			'ru': 'ru-RU',
			'jp': 'ja-JP',
			'cn': 'zh-CN',
			'ar': 'ar-SA',
			'el': 'el-GR',
			'he': 'he-IL',
			'in': 'hi-IN'
		};
		
		const locale = localeMap[currentLang] || 'fr-FR';
		
		// Formater la date selon la locale de la langue sélectionnée
		const formattedDate = eventDate.toLocaleDateString(locale, {
			day: 'numeric',
			month: 'long',
			year: 'numeric'
		});
		
		if (diffDays === 0) {
			return this.translateService.instant('COMMUN.TODAY') + ` <em>(${formattedDate})</em>`;
		} else if (diffDays === 1) {
			return this.translateService.instant('COMMUN.TOMORROW') + ` <em>(${formattedDate})</em>`;
		} else if (diffDays === -1) {
			return this.translateService.instant('COMMUN.YESTERDAY') + ` <em>(${formattedDate})</em>`;
		} else if (diffDays > 0) {
			return this.translateService.instant('COMMUN.IN_DAYS', { days: diffDays }) + ` <em>(${formattedDate})</em>`;
		} else {
			return this.translateService.instant('COMMUN.DAYS_AGO', { days: Math.abs(diffDays) }) + ` <em>(${formattedDate})</em>`;
		}
	}

	public openEventDetails(evenement: Evenement) {
		// Navigation vers la page de détails de l'événement
		this._router.navigate(['/details-evenement', evenement.id]);
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
		this.stopSlideshow();
		this.removeKeyboardListener();
		this.cancelFsDownloads();
		
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
		
		// Clean up slideshow blob URLs
		this.slideshowImages.forEach(url => {
			if (url.startsWith('blob:')) {
				URL.revokeObjectURL(url);
			}
		});
		this.slideshowImages = [];
	}
	
	// Scroll to top of the page
	private scrollToTop(): void {
		this.nativeWindow.scrollTo(0, 0);
	}
	
	// Open image modal for large display
	openImageModal(imageUrl: SafeUrl, imageAlt: string): void {
		this.selectedImageUrl = imageUrl;
		this.selectedImageAlt = imageAlt;
		
		if (!this.imageModal) {
			return;
		}
		
		this.modalService.open(this.imageModal, { 
			size: 'lg', 
			centered: true,
			backdrop: true,
			keyboard: true,
			animation: false,
			windowClass: 'modal-smooth-animation'
		});
	}

	public showEventJson(evenement: Evenement): void {
		this.selectedEvent = evenement;
		this.selectedEventName = evenement.evenementName;
		
		this.modalService.open(this.jsonModal, { 
			size: 'lg',
			backdrop: true,
			keyboard: true,
			animation: true,
			centered: true
		}).result.then((result) => {
			console.log('JSON modal closed with:', result);
		}, (reason) => {
			console.log('JSON modal dismissed:', reason);
		});
	}

	public getFormattedEventJson(): string {
		if (this.selectedEvent) {
			return JSON.stringify(this.selectedEvent, null, 2);
		}
		return '';
	}

	public hasComments(evenement: Evenement): boolean {
		return evenement.commentaries && evenement.commentaries.length > 0;
	}

	public getCommentsCount(evenement: Evenement): number {
		return evenement.commentaries ? evenement.commentaries.length : 0;
	}

	public getFilesCount(evenement: Evenement): number {
		return evenement.fileUploadeds ? evenement.fileUploadeds.length : 0;
	}

	public getEventComments(evenement: Evenement): any[] {
		if (!evenement.commentaries || evenement.commentaries.length === 0) {
			return [];
		}
		
		// Trier les commentaires par date de création décroissante (plus récent en premier)
		return evenement.commentaries.sort((a, b) => {
			const dateA = new Date(a.dateCreation).getTime();
			const dateB = new Date(b.dateCreation).getTime();
			return dateB - dateA;
		});
	}

	public openCommentsModal(evenement: Evenement): void {
		this.selectedEvent = evenement;
		this.selectedEventName = evenement.evenementName;
		
		this.modalService.open(this.commentsModal, { 
			size: 'lg',
			backdrop: true,
			keyboard: true,
			animation: true,
			centered: true
		}).result.then((result) => {
			console.log('Comments modal closed with:', result);
		}, (reason) => {
			console.log('Comments modal dismissed:', reason);
		});
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

	public sendEmail(email: string): void {
		window.open(`mailto:${email}`, '_blank');
	}

	// Slideshow properties
	public isSlideshowActive: boolean = false;
	public currentSlideshowIndex: number = 0;
	public slideshowImages: string[] = [];
	public slideshowInterval: any;
	public isFullscreen: boolean = false;
	private keyboardListener?: (event: KeyboardEvent) => void;
	private isSlideshowModalOpen: boolean = false;
	private lastKeyPressTime: number = 0;
	private lastKeyCode: number = 0;
	private selectedEventForSlideshow: Evenement | null = null;
	
	// Photo selection
	public selectedFsLink: string = '';
	public selectedEventForPhotosSelector: Evenement | null = null;

	// FS Photos download control
	private fsDownloadsActive: boolean = false;
	private fsActiveSubs: Subscription[] = [];
	private fsQueue: string[] = [];

	// Zoom state for slideshow
	public slideshowZoom: number = 1;
	public slideshowTranslateX: number = 0;
	public slideshowTranslateY: number = 0;
	public isDraggingSlideshow: boolean = false;
	private hasDraggedSlideshow: boolean = false;
	private dragStartX: number = 0;
	private dragStartY: number = 0;
	private dragOrigX: number = 0;
	private dragOrigY: number = 0;

	// Touch state for mobile gestures
	private touchStartDistance: number = 0;
	private touchStartZoom: number = 1;
	private lastTouchDistance: number = 0;
	private touchStartX: number = 0;
	private touchStartY: number = 0;
	private isPinching: boolean = false;
	private initialTouches: Touch[] = [];
	private pinchStartTranslateX: number = 0;
	private pinchStartTranslateY: number = 0;

	// Check if file is an image based on extension
	public isImageFile(fileName: string): boolean {
		if (!fileName) return false;
		
		const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tiff', '.tif'];
		const lowerFileName = fileName.toLowerCase();
		
		return imageExtensions.some(ext => lowerFileName.endsWith(ext));
	}

	// Check if event has image files
	public hasImageFiles(evenement: Evenement): boolean {
		return evenement.fileUploadeds && evenement.fileUploadeds.some(file => this.isImageFile(file.fileName));
	}

	// Get count of image files
	public getImageFilesCount(evenement: Evenement): number {
		if (!evenement.fileUploadeds) return 0;
		return evenement.fileUploadeds.filter(file => this.isImageFile(file.fileName)).length;
	}

	// =========================
	// Photo From FS integration
	// =========================

	public getPhotoFromFsLinks(evenement: Evenement): UrlEvent[] {
		if (!evenement || !evenement.urlEvents) return [];
		return evenement.urlEvents.filter(u => (u.typeUrl || '').toUpperCase().trim() === 'PHOTOFROMFS');
	}

	public getPhotosUrlLinks(evenement: Evenement): UrlEvent[] {
		if (!evenement || !evenement.urlEvents) return [];
		return evenement.urlEvents.filter(u => (u.typeUrl || '').toUpperCase().trim() === 'PHOTOS');
	}

	public getPhotoFromFsCount(evenement: Evenement): number {
		return this.getPhotoFromFsLinks(evenement).length;
	}

	public openFsPhotosSelector(evenement: Evenement, includeUploadedChoice: boolean = false): void {
		this.selectedEventForPhotosSelector = evenement;
		const fsLinks = this.getPhotoFromFsLinks(evenement);
		const webLinks = this.getPhotosUrlLinks(evenement);
		const hasAnyLinks = (fsLinks.length + webLinks.length) > 0;

		if (!includeUploadedChoice && !hasAnyLinks) {
			return;
		}
		if (!includeUploadedChoice && fsLinks.length === 1 && webLinks.length === 0) {
			this.openFsPhotosDiaporama(evenement, fsLinks[0].link);
			return;
		}
		// Default selection priority: uploaded (if requested and available) -> first FS link -> first web photos link
		if (includeUploadedChoice && this.hasImageFiles(evenement)) {
			this.selectedFsLink = '__UPLOADED__';
		} else if (fsLinks.length > 0) {
			this.selectedFsLink = fsLinks[0].link;
		} else if (webLinks.length > 0) {
			this.selectedFsLink = 'PHOTOS:' + webLinks[0].link;
		}
		if (!this.fsPhotosSelectorModal) return;
		this.modalService.open(this.fsPhotosSelectorModal, { centered: true, size: 'md', windowClass: 'fs-selector-modal' });
	}

	public confirmFsPhotosSelection(modalRef?: any): void {
		if (!this.selectedFsLink || !this.selectedEventForPhotosSelector) return;
		if (this.selectedFsLink === '__UPLOADED__') {
			this.openSlideshow(this.selectedEventForPhotosSelector);
		} else if (this.selectedFsLink.startsWith('PHOTOS:')) {
			const url = this.selectedFsLink.substring('PHOTOS:'.length);
			try { this.winRef.getNativeWindow().open(url, '_blank'); } catch {}
		} else {
			this.openFsPhotosDiaporama(this.selectedEventForPhotosSelector, this.selectedFsLink);
		}
		if (modalRef) { modalRef.close(); }
		this.selectedEventForPhotosSelector = null;
	}

	private openFsPhotosDiaporama(evenement: Evenement, relativePath: string): void {
		this.selectedEventForSlideshow = evenement;
		this.slideshowImages = [];
		this.currentSlideshowIndex = 0;
		// ensure slideshow starts paused
		if (this.slideshowInterval) { clearInterval(this.slideshowInterval); this.slideshowInterval = null; }
		this.isSlideshowActive = false;
		this.fsDownloadsActive = true;
		// cleanup any previous subscriptions
		this.cancelFsDownloads();
		this.fsDownloadsActive = true;
		// First, list images
		this._fileService.listImagesFromDisk(relativePath).subscribe({
			next: (fileNames: string[]) => {
				// Open the modal immediately (will show loader until images arrive)
				const modalRef = this.modalService.open(this.slideshowModal, { size: 'xl', centered: true });

				if (!fileNames || fileNames.length === 0) {
					return;
				}
				// Limit concurrent downloads for faster first paint
				this.loadImagesWithConcurrency(relativePath, fileNames, 4);

				// Setup keyboard listener after modal is opened
				setTimeout(() => {
					this.setupKeyboardListener();
				}, 0);

				// Cleanup and cancel downloads when modal closes
				modalRef.result.finally(() => {
					this.cancelFsDownloads();
					this.removeKeyboardListener();
					try { this.slideshowImages.forEach(url => URL.revokeObjectURL(url)); } catch {}
				});
			},
			error: () => {
				// Open modal anyway to show empty state/error
				this.modalService.open(this.slideshowModal, { size: 'xl', centered: true });
				setTimeout(() => {
					this.setupKeyboardListener();
				}, 0);
			}
		});
	}

	private loadImagesWithConcurrency(relativePath: string, fileNames: string[], concurrency: number): void {
		this.fsQueue = [...fileNames];
		let active = 0;

		const next = () => {
			if (!this.fsDownloadsActive) { return; }
			while (this.fsDownloadsActive && active < concurrency && this.fsQueue.length > 0) {
				const name = this.fsQueue.shift() as string;
				active++;
				const sub = this._fileService.getImageFromDisk(relativePath, name).subscribe({
					next: (buffer: ArrayBuffer) => {
						const blob = new Blob([buffer], { type: 'image/*' });
						const url = URL.createObjectURL(blob);
						this.slideshowImages.push(url);
					},
					error: () => {
						// ignore failed image
					},
					complete: () => {
						active--;
						next();
					}
				});
				this.fsActiveSubs.push(sub);
			}
		};

		next();
	}

	private cancelFsDownloads(): void {
		this.fsDownloadsActive = false;
		try { this.fsActiveSubs.forEach(s => { if (s && !s.closed) { s.unsubscribe(); } }); } catch {}
		this.fsActiveSubs = [];
		this.fsQueue = [];
	}

	// Unified photos opener (uploaded photos or FS photos)
	public openPhotos(evenement: Evenement): void {
		const hasFs = this.getPhotoFromFsCount(evenement) > 0;
		const hasPhotosWeb = this.getPhotosUrlLinks(evenement).length > 0;
		const hasUploaded = this.hasImageFiles(evenement);

		if ((hasFs || hasPhotosWeb) && hasUploaded) {
			this.openFsPhotosSelector(evenement, true);
			return;
		}
		if (hasFs || hasPhotosWeb) {
			this.openFsPhotosSelector(evenement, false);
			return;
		}
		if (hasUploaded) {
			this.openSlideshow(evenement);
		}
	}

	// Listen to fullscreen events
	private setupFullscreenListener(): void {
		const handleFullscreenChange = () => {
			this.isFullscreen = !!(document.fullscreenElement || (document as any).webkitFullscreenElement || 
				(document as any).mozFullScreenElement || (document as any).msFullscreenElement);
		};

		document.addEventListener('fullscreenchange', handleFullscreenChange);
		document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
		document.addEventListener('mozfullscreenchange', handleFullscreenChange);
		document.addEventListener('MSFullscreenChange', handleFullscreenChange);
	}

	// Open slideshow modal with all images from this event
	public openSlideshow(evenement: Evenement): void {
		this.selectedEventForSlideshow = evenement;
		this.setupFullscreenListener();
		// Filter to get only image files
		const imageFiles = evenement.fileUploadeds.filter(file => this.isImageFile(file.fileName));
		
		if (imageFiles.length === 0) {
			alert('Aucune image trouvée dans cet événement.');
			return;
		}

		// Initialize slideshow state
		this.slideshowImages = [];
		this.currentSlideshowIndex = 0;
		this.isSlideshowActive = false;
		this.resetSlideshowZoom();
		let isFirstImageLoaded = false;

		// Open the modal first
		if (this.slideshowModal) {
			const modalRef = this.modalService.open(this.slideshowModal, { 
				size: 'xl', 
				centered: true,
				backdrop: true,
				keyboard: true,
				windowClass: 'modal-smooth-animation'
			});
			
			// Set flag that modal is open
			this.isSlideshowModalOpen = true;
			this.lastKeyPressTime = 0;
			this.lastKeyCode = 0;
			
			// Setup keyboard listener after modal is opened
			setTimeout(() => {
				this.setupKeyboardListener();
			}, 0);
			
			// Handle modal close event
			modalRef.result.then(
				(result) => {
					this.isSlideshowModalOpen = false;
					this.stopSlideshow();
					this.removeKeyboardListener();
					this.selectedEventForSlideshow = null;
				},
				(reason) => {
					this.isSlideshowModalOpen = false;
					this.stopSlideshow();
					this.removeKeyboardListener();
					this.selectedEventForSlideshow = null;
				}
			);
		}

		// Load images one by one
		imageFiles.forEach((file, index) => {
			this._fileService.getFile(file.fieldId).pipe(
				map((res: any) => {
					const blob = new Blob([res], { type: 'application/octet-stream' });
					return URL.createObjectURL(blob);
				})
			).subscribe((objectUrl: string) => {
				// Add to slideshow images array
				this.slideshowImages.push(objectUrl);
				
				// Initialize slideshow state when first image is loaded
				if (!isFirstImageLoaded) {
					isFirstImageLoaded = true;
					this.isSlideshowActive = false; // Start paused
					setTimeout(() => this.resetSlideshowZoom(), 100);
				}
			}, (error) => {
				console.error('Error loading image for slideshow:', error);
			});
		});
	}

	// Start automatic slideshow
	public startSlideshow(): void {
		if (this.slideshowImages.length <= 1) return;
		
		this.stopSlideshow();
		
		this.slideshowInterval = setInterval(() => {
			this.nextImage();
		}, 3000);
	}

	// Stop slideshow
	public stopSlideshow(): void {
		if (this.slideshowInterval) {
			clearInterval(this.slideshowInterval);
			this.slideshowInterval = null;
		}
		this.isSlideshowActive = false;
		
		// Cleanup blob URLs to prevent memory leaks
		this.slideshowImages.forEach(url => {
			if (url.startsWith('blob:')) {
				URL.revokeObjectURL(url);
			}
		});
		this.slideshowImages = [];
	}

	// Setup keyboard listener for arrow keys navigation
	private setupKeyboardListener(): void {
		this.keyboardListener = (event: KeyboardEvent) => {
			// Only handle if modal is open
			if (!this.isSlideshowModalOpen) {
				return;
			}
			
			// Check if target is not an input or textarea to avoid interfering with form inputs
			const target = event.target as HTMLElement;
			if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
				return;
			}
			
			// Check if modal is open OR if we're in fullscreen mode
			const modal = document.querySelector('.modal.show');
			const isFullscreenActive = !!(document.fullscreenElement || (document as any).webkitFullscreenElement || 
				(document as any).mozFullScreenElement || (document as any).msFullscreenElement);
			
			// Allow if modal is open OR if we're in fullscreen (modal might not have .show class in fullscreen)
			if (!modal && !isFullscreenActive) {
				return;
			}
			
			// In fullscreen, we still want to handle the keys even if modal doesn't contain target
			if (modal && !modal.contains(target) && !isFullscreenActive) {
				return;
			}
			
			const currentTime = Date.now();
			const currentKeyCode = event.keyCode || (event.key === 'ArrowLeft' ? 37 : event.key === 'ArrowRight' ? 39 : 0);
			
			// Debounce: ignore if same key pressed within 100ms (to prevent double triggering)
			if (currentKeyCode === this.lastKeyCode && currentTime - this.lastKeyPressTime < 100) {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
				return;
			}
			
			if (event.key === 'ArrowLeft' || event.keyCode === 37) {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
				this.lastKeyPressTime = currentTime;
				this.lastKeyCode = 37;
				this.previousImage();
			} else if (event.key === 'ArrowRight' || event.keyCode === 39) {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
				this.lastKeyPressTime = currentTime;
				this.lastKeyCode = 39;
				this.nextImage();
			}
		};
		
		// Use capture phase with keydown only (to avoid double triggering)
		window.addEventListener('keydown', this.keyboardListener, { capture: true, passive: false });
		document.addEventListener('keydown', this.keyboardListener, { capture: true, passive: false });
	}

	// Remove keyboard listener
	private removeKeyboardListener(): void {
		if (this.keyboardListener) {
			window.removeEventListener('keydown', this.keyboardListener, { capture: true });
			document.removeEventListener('keydown', this.keyboardListener, { capture: true });
			this.keyboardListener = undefined;
		}
	}

	// Navigate to next image
	public nextImage(): void {
		if (this.slideshowImages.length === 0) return;
		this.currentSlideshowIndex = (this.currentSlideshowIndex + 1) % this.slideshowImages.length;
		setTimeout(() => this.resetSlideshowZoom(), 0);
	}

	// Navigate to previous image
	public previousImage(): void {
		if (this.slideshowImages.length === 0) return;
		this.currentSlideshowIndex = (this.currentSlideshowIndex - 1 + this.slideshowImages.length) % this.slideshowImages.length;
		setTimeout(() => this.resetSlideshowZoom(), 0);
	}

	// Get current slideshow image URL
	public getCurrentSlideshowImage(): string {
		if (this.slideshowImages.length === 0 || this.currentSlideshowIndex >= this.slideshowImages.length) {
			return '';
		}
		return this.slideshowImages[this.currentSlideshowIndex];
	}

	// Toggle slideshow play/pause
	public toggleSlideshow(): void {
		if (this.isSlideshowActive) {
			// Just stop the interval, don't cleanup images
			if (this.slideshowInterval) {
				clearInterval(this.slideshowInterval);
				this.slideshowInterval = null;
			}
			this.isSlideshowActive = false;
		} else {
			this.startSlideshow();
			this.isSlideshowActive = true;
		}
	}

	// Toggle slideshow with message
	public toggleSlideshowWithMessage(): void {
		const wasActive = this.isSlideshowActive;
		this.toggleSlideshow();
		
		if (wasActive) {
			this.showSlideshowMessage('EVENTELEM.SLIDESHOW_PAUSED');
		} else {
			this.showSlideshowMessage('EVENTELEM.SLIDESHOW_PLAYING');
		}
	}

	private showSlideshowMessage(translationKey: string): void {
		this.translateService.get(translationKey).subscribe((translation: string) => {
			const toast = document.createElement('div');
			toast.textContent = translation;
			toast.style.cssText = 'position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.8); color: white; padding: 10px 20px; border-radius: 5px; z-index: 9999; font-size: 16px;';
			document.body.appendChild(toast);
			setTimeout(() => {
				toast.remove();
			}, 2000);
		});
	}

	// Toggle fullscreen mode
	public toggleFullscreen(): void {
		// Use slideshow-container to include both image and controls
		const slideshowContainer = document.querySelector('.slideshow-container');
		const slideshowImageWrapper = document.querySelector('.slideshow-image-wrapper');
		const imageElement = slideshowContainer || slideshowImageWrapper;
		if (!imageElement) return;

		if (!this.isFullscreen) {
			// Enter fullscreen
			if ((imageElement as any).requestFullscreen) {
				(imageElement as any).requestFullscreen();
			} else if ((imageElement as any).webkitRequestFullscreen) {
				(imageElement as any).webkitRequestFullscreen();
			} else if ((imageElement as any).mozRequestFullScreen) {
				(imageElement as any).mozRequestFullScreen();
			} else if ((imageElement as any).msRequestFullscreen) {
				(imageElement as any).msRequestFullscreen();
			}
		} else {
			// Exit fullscreen
			if (document.exitFullscreen) {
				document.exitFullscreen();
			} else if ((document as any).webkitExitFullscreen) {
				(document as any).webkitExitFullscreen();
			} else if ((document as any).mozCancelFullScreen) {
				(document as any).mozCancelFullScreen();
			} else if ((document as any).msExitFullscreen) {
				(document as any).msExitFullscreen();
			}
		}
	}

	// Get event name for slideshow title
	public getSlideshowEventName(): string {
		return this.selectedEventForSlideshow ? this.selectedEventForSlideshow.evenementName : '';
	}

	// =========================
	// Slideshow zoom and drag methods (same as element-evenement)
	// =========================

	public getMinSlideshowZoom(): number {
		try {
			const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
			const imgEl = this.slideshowImgElRef?.nativeElement as HTMLImageElement;
			if (!container || !imgEl || !imgEl.naturalWidth || !imgEl.naturalHeight) return 0.5;
			const cw = container.clientWidth || 1;
			const ch = container.clientHeight || 1;
			const iw = imgEl.naturalWidth;
			const ih = imgEl.naturalHeight;
			return Math.max(cw / iw, ch / ih);
		} catch { return 0.5; }
	}

	private applyWheelZoom(event: WheelEvent, current: number, minZoom: number, maxZoom: number = 5): number {
		event.preventDefault();
		const delta = Math.sign(event.deltaY);
		const step = 0.1;
		let next = current - delta * step; // wheel up -> zoom in
		if (next < minZoom) next = minZoom;
		if (next > maxZoom) next = maxZoom;
		return parseFloat(next.toFixed(2));
	}

	public onWheelSlideshow(event: WheelEvent): void {
		const minZoom = this.getMinSlideshowZoom();
		this.slideshowZoom = this.applyWheelZoom(event, this.slideshowZoom, minZoom);
		this.clampSlideshowTranslation();
	}

	public resetSlideshowZoom(): void { 
		this.slideshowZoom = Math.max(1, this.getMinSlideshowZoom()); 
		this.slideshowTranslateX = 0; 
		this.slideshowTranslateY = 0; 
	}

	public zoomInSlideshow(): void { 
		this.slideshowZoom = Math.min(5, parseFloat((this.slideshowZoom + 0.1).toFixed(2))); 
	}

	public zoomOutSlideshow(): void { 
		this.slideshowZoom = Math.max(this.getMinSlideshowZoom(), parseFloat((this.slideshowZoom - 0.1).toFixed(2))); 
		this.clampSlideshowTranslation(); 
	}

	// Drag handlers for Slideshow modal
	public onSlideshowMouseDown(event: MouseEvent): void {
		const canDrag = this.slideshowZoom > this.getMinSlideshowZoom();
		this.isDraggingSlideshow = canDrag;
		this.hasDraggedSlideshow = false;
		if (canDrag) { try { event.preventDefault(); event.stopPropagation(); } catch {} }
		this.dragStartX = event.clientX;
		this.dragStartY = event.clientY;
		this.dragOrigX = this.slideshowTranslateX;
		this.dragOrigY = this.slideshowTranslateY;
	}

	public onSlideshowMouseMove(event: MouseEvent): void {
		if (!this.isDraggingSlideshow) return;
		try { event.preventDefault(); event.stopPropagation(); } catch {}
		const dx = event.clientX - this.dragStartX;
		const dy = event.clientY - this.dragStartY;
		this.slideshowTranslateX = this.dragOrigX + dx;
		this.slideshowTranslateY = this.dragOrigY + dy;
		if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.hasDraggedSlideshow = true;
		this.clampSlideshowTranslation();
	}

	public onSlideshowMouseUp(): void {
		this.isDraggingSlideshow = false;
	}

	public onSlideshowImageClick(): void {
		// Ignore click if it was a drag
		if (this.hasDraggedSlideshow) { this.hasDraggedSlideshow = false; return; }
		this.toggleSlideshowWithMessage();
	}

	public onSlideshowClose(cRef: any): void {
		try {
			if (document.fullscreenElement) {
				document.exitFullscreen().catch(() => {});
			}
		} catch {}
		this.removeKeyboardListener();
		try { if (typeof cRef === 'function') { cRef('Close click'); } } catch {}
		try { this.modalService.dismissAll(); } catch {}
	}

	private clampSlideshowTranslation(): void {
		try {
			const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
			const imgEl = this.slideshowImgElRef?.nativeElement as HTMLImageElement;
			if (!container || !imgEl) return;
			const cw = container.clientWidth;
			const ch = container.clientHeight;
			const iw = imgEl.clientWidth * this.slideshowZoom;
			const ih = imgEl.clientHeight * this.slideshowZoom;
			const maxX = Math.max(0, (iw - cw) / 2);
			const maxY = Math.max(0, (ih - ch) / 2);
			if (this.slideshowTranslateX > maxX) this.slideshowTranslateX = maxX;
			if (this.slideshowTranslateX < -maxX) this.slideshowTranslateX = -maxX;
			if (this.slideshowTranslateY > maxY) this.slideshowTranslateY = maxY;
			if (this.slideshowTranslateY < -maxY) this.slideshowTranslateY = -maxY;
		} catch {}
	}

	// Helper function to calculate distance between two touches
	private getTouchDistance(touch1: Touch, touch2: Touch): number {
		const dx = touch1.clientX - touch2.clientX;
		const dy = touch1.clientY - touch2.clientY;
		return Math.sqrt(dx * dx + dy * dy);
	}

	// Helper function to get center point between two touches
	private getTouchCenter(touch1: Touch, touch2: Touch): { x: number; y: number } {
		return {
			x: (touch1.clientX + touch2.clientX) / 2,
			y: (touch1.clientY + touch2.clientY) / 2
		};
	}

	// Touch handlers for Slideshow modal - Mobile support
	public onSlideshowTouchStart(event: TouchEvent): void {
		if (event.touches.length === 1) {
			// Single touch - start drag
			const touch = event.touches[0];
			const canDrag = this.slideshowZoom > this.getMinSlideshowZoom();
			this.isDraggingSlideshow = canDrag;
			this.hasDraggedSlideshow = false;
			if (canDrag) {
				try { event.preventDefault(); event.stopPropagation(); } catch {}
			}
			this.touchStartX = touch.clientX;
			this.touchStartY = touch.clientY;
			this.dragStartX = touch.clientX;
			this.dragStartY = touch.clientY;
			this.dragOrigX = this.slideshowTranslateX;
			this.dragOrigY = this.slideshowTranslateY;
			this.isPinching = false;
		} else if (event.touches.length === 2) {
			// Two touches - start pinch zoom
			try { event.preventDefault(); event.stopPropagation(); } catch {}
			this.isPinching = true;
			this.isDraggingSlideshow = false;
			const touch1 = event.touches[0];
			const touch2 = event.touches[1];
			this.touchStartDistance = this.getTouchDistance(touch1, touch2);
			this.touchStartZoom = this.slideshowZoom;
			this.lastTouchDistance = this.touchStartDistance;
			this.initialTouches = [touch1, touch2];
			this.pinchStartTranslateX = this.slideshowTranslateX;
			this.pinchStartTranslateY = this.slideshowTranslateY;
			
			// Store the center point for zoom origin
			const center = this.getTouchCenter(touch1, touch2);
			const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
			if (container) {
				const rect = container.getBoundingClientRect();
				this.touchStartX = center.x - rect.left;
				this.touchStartY = center.y - rect.top;
			}
		}
	}

	public onSlideshowTouchMove(event: TouchEvent): void {
		if (event.touches.length === 1 && !this.isPinching) {
			// Single touch - drag
			if (!this.isDraggingSlideshow) return;
			const touch = event.touches[0];
			try { event.preventDefault(); event.stopPropagation(); } catch {}
			const dx = touch.clientX - this.dragStartX;
			const dy = touch.clientY - this.dragStartY;
			this.slideshowTranslateX = this.dragOrigX + dx;
			this.slideshowTranslateY = this.dragOrigY + dy;
			if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.hasDraggedSlideshow = true;
			this.clampSlideshowTranslation();
		} else if (event.touches.length === 2 && this.isPinching) {
			// Two touches - pinch zoom
			try { event.preventDefault(); event.stopPropagation(); } catch {}
			const touch1 = event.touches[0];
			const touch2 = event.touches[1];
			const currentDistance = this.getTouchDistance(touch1, touch2);
			
			if (this.touchStartDistance > 0) {
				// Calculate zoom factor based on distance change
				const scale = currentDistance / this.touchStartDistance;
				let newZoom = this.touchStartZoom * scale;
				
				// Apply min/max zoom constraints
				const minZoom = this.getMinSlideshowZoom();
				const maxZoom = 5;
				newZoom = Math.max(minZoom, Math.min(maxZoom, newZoom));
				
				this.slideshowZoom = parseFloat(newZoom.toFixed(2));
				
				// Adjust translation to keep zoom centered on pinch point
				if (this.slideshowZoom > minZoom) {
					const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
					const imgEl = this.slideshowImgElRef?.nativeElement as HTMLImageElement;
					if (container && imgEl) {
						const rect = container.getBoundingClientRect();
						const currentPinchCenterX = (touch1.clientX + touch2.clientX) / 2 - rect.left;
						const currentPinchCenterY = (touch1.clientY + touch2.clientY) / 2 - rect.top;
						
						// Get initial pinch center point
						const initialPinchCenterX = this.touchStartX;
						const initialPinchCenterY = this.touchStartY;
						
						// Calculate zoom change factor
						const zoomChange = this.slideshowZoom / this.touchStartZoom;
						
						// Calculate the new translation to zoom around the initial pinch point
						this.slideshowTranslateX = initialPinchCenterX - (initialPinchCenterX - this.pinchStartTranslateX) * zoomChange;
						this.slideshowTranslateY = initialPinchCenterY - (initialPinchCenterY - this.pinchStartTranslateY) * zoomChange;
					}
				}
				
				this.lastTouchDistance = currentDistance;
				this.clampSlideshowTranslation();
			}
		}
	}

	public onSlideshowTouchEnd(event: TouchEvent): void {
		if (event.touches.length === 0) {
			// All touches ended
			this.isDraggingSlideshow = false;
			this.isPinching = false;
			this.initialTouches = [];
			this.touchStartDistance = 0;
			this.lastTouchDistance = 0;
			this.pinchStartTranslateX = 0;
			this.pinchStartTranslateY = 0;
		} else if (event.touches.length === 1 && this.isPinching) {
			// One touch lifted during pinch - switch to drag mode
			this.isPinching = false;
			const touch = event.touches[0];
			this.isDraggingSlideshow = this.slideshowZoom > this.getMinSlideshowZoom();
			if (this.isDraggingSlideshow) {
				this.touchStartX = touch.clientX;
				this.touchStartY = touch.clientY;
				this.dragStartX = touch.clientX;
				this.dragStartY = touch.clientY;
				this.dragOrigX = this.slideshowTranslateX;
				this.dragOrigY = this.slideshowTranslateY;
			}
			this.pinchStartTranslateX = 0;
			this.pinchStartTranslateY = 0;
		}
	}
	
}

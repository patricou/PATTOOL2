import {
  Component,
  DestroyRef,
  ElementRef,
  TemplateRef,
  ViewChild,
  AfterViewChecked,
  AfterViewInit,
  HostListener,
  OnDestroy,
  OnInit,
  ChangeDetectorRef,
  NgZone,
  inject
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NavigationEnd, Router } from '@angular/router';
import { DomSanitizer, SafeHtml, SafeUrl } from '@angular/platform-browser';
import { combineLatest, filter, Subscription } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { KeycloakService } from '../../keycloak/keycloak.service';
import {
  AssistantAttachedImageRequest,
  AssistantChatMeta,
  AssistantChatTurn,
  AssistantOpenAiCredits,
  AssistantService,
  AssistantToolFlagsRequest,
  parseElapsedMsFromAssistantResponse
} from '../../services/assistant.service';
import { AssistantSessionStore } from '../../services/assistant-session.store';
import { AssistantLaunchService } from '../../services/assistant-launch.service';
import { MarkdownChatRenderService } from '../../services/markdown-chat-render.service';
import { NewsTickerService } from '../../services/news-ticker.service';
import { CurrencyTickerService } from '../../services/currency-ticker.service';
import { StockTickerService } from '../../services/stock-ticker.service';
import { copyPlainTextToClipboard } from '../clipboard-copy';
import { NgbModal, NgbModalRef, NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { QuillModule } from 'ngx-quill';
import { marked } from 'marked';
import {
  SlideshowModalComponent,
  SlideshowImageSource
} from '../slideshow-modal/slideshow-modal.component';
import { EvenementsService, StreamedEvent } from '../../services/evenements.service';
import { FileService } from '../../services/file.service';
import { MembersService } from '../../services/members.service';
import { Evenement } from '../../model/evenement';
import { Commentary } from '../../model/commentary';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-assistant-drawer',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, QuillModule, SlideshowModalComponent],
  templateUrl: './assistant-drawer.component.html',
  styleUrls: ['./assistant-drawer.component.css', '../markdown-chat-content.css'],
  /**
   * EvenementsService n'est pas providedIn:'root' (déclaré dans le module Evenements lazy)
   * mais le drawer assistant est monté globalement : on le fournit ici en local pour
   * pouvoir lister les évènements depuis le picker d'insertion d'image.
   */
  providers: [EvenementsService]
})
export class AssistantDrawerComponent
  implements AfterViewInit, AfterViewChecked, OnInit, OnDestroy
{
  private readonly destroyRef = inject(DestroyRef);

  @ViewChild('threadEl') threadEl?: ElementRef<HTMLDivElement>;
  @ViewChild('draftInput') draftInputEl?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('imageFileInput') imageFileInputEl?: ElementRef<HTMLInputElement>;
  @ViewChild('assistantWhatsappShareModal') assistantWhatsappShareModal!: TemplateRef<unknown>;
  @ViewChild('assistantInsertImageInEventModal') assistantInsertImageInEventModal!: TemplateRef<unknown>;
  /**
   * Modal de choix de compression d'image (réutilise les clés i18n
   * `EVENTELEM.IMAGE_COMPRESSION_*` déjà utilisées dans `update-evenement`).
   * Affiché uniquement lorsque l'image insérée dans un évènement dépasse
   * {@link AssistantDrawerComponent.INSERT_IMAGE_COMPRESSION_THRESHOLD_BYTES}.
   */
  @ViewChild('imageCompressionModal') imageCompressionModal!: TemplateRef<unknown>;
  /** Référence à l'instance du slideshow partagé (même viewer que pour les évènements). */
  @ViewChild('slideshowModalComponent') slideshowModalComponent?: SlideshowModalComponent;

  /**
   * Object URLs créés à partir des data: URLs des images générées, pour
   * alimenter le slideshow de façon performante (un blob URL est plus léger
   * qu'une data URL en base64). Ils sont libérés à la fermeture du slideshow
   * et au destroy du composant pour éviter les fuites mémoire.
   */
  private slideshowBlobUrls: string[] = [];

  /** Modal partage WhatsApp (même principe que mur de photos). */
  whatsappShareMessage = '';
  private whatsappShareModalRef: NgbModalRef | null = null;

  /** Modal « Insérer dans un évènement » (image générée OU commentaire texte). */
  private insertImageModalRef: NgbModalRef | null = null;
  /** Mode actif du modal : insertion d'image générée vs ajout de commentaire texte. */
  insertMode: 'image' | 'comment' | null = null;
  /** Data URL retenue pour l'insertion d'image (mode 'image'). */
  private insertImageDataUrl: string | null = null;
  /**
   * Contenu HTML du commentaire à insérer (mode 'comment') ; pré-rempli avec
   * la question utilisateur + la réponse assistant (markdown converti en HTML),
   * modifiable via un éditeur Quill avant soumission. Stocké en HTML pour rester
   * compatible avec le rendu existant des commentaires (`commentary-editor`).
   */
  insertCommentText = '';
  /**
   * Plafond pour la portion TEXTE (HTML) d'un commentaire, hors images.
   * Les images générées (data URL base64) sont concaténées EN PLUS et ne
   * sont jamais tronquées (pour ne pas casser le base64 et obtenir une
   * image illisible). Le plafond global du commentaire dépend donc de la
   * taille des images embarquées (tolérance backend ~plusieurs Mo).
   */
  private static readonly INSERT_COMMENT_MAX_TEXT_HTML_CHARS = 8000;
  /** Toolbar Quill (sous-ensemble similaire à celui de `commentary-editor`). */
  insertCommentQuillModules: Record<string, unknown> = {
    toolbar: [
      ['bold', 'italic', 'underline', 'strike'],
      [{ header: [1, 2, 3, false] }],
      [{ list: 'ordered' }, { list: 'bullet' }],
      [{ script: 'sub' }, { script: 'super' }],
      [{ color: [] }, { background: [] }],
      ['blockquote', 'code-block'],
      ['link'],
      ['clean']
    ]
  };
  /** Liste d'évènements collectée via {@link EvenementsService.streamEvents}. */
  insertImageEventsList: Evenement[] = [];
  /** Texte de filtre saisi dans le modal (filtrage côté client par nom). */
  insertImageEventsFilter = '';
  /**
   * Filtre par type d'activité (ID numérique tel que stocké dans `Evenement.type`).
   * Chaîne vide = aucun filtre, tous les types sont affichés.
   */
  insertImageEventsTypeFilter = '';
  /**
   * Options du filtre par type d'activité — IDs numériques (1..19) mappés vers les
   * mêmes clés i18n `EVENTCREATION.TYPE.*` que celles utilisées dans la création
   * et la mise à jour d'un évènement, pour rester cohérent avec le reste de l'UI.
   */
  readonly insertImageEventTypeOptions: ReadonlyArray<{ value: string; labelKey: string }> = [
    { value: '11', labelKey: 'EVENTCREATION.TYPE.DOCUMENTS' },
    { value: '12', labelKey: 'EVENTCREATION.TYPE.FICHE' },
    { value: '3', labelKey: 'EVENTCREATION.TYPE.RUN' },
    { value: '6', labelKey: 'EVENTCREATION.TYPE.PARTY' },
    { value: '4', labelKey: 'EVENTCREATION.TYPE.WALK' },
    { value: '10', labelKey: 'EVENTCREATION.TYPE.PHOTOS' },
    { value: '9', labelKey: 'EVENTCREATION.TYPE.RANDO' },
    { value: '2', labelKey: 'EVENTCREATION.TYPE.SKI' },
    { value: '7', labelKey: 'EVENTCREATION.TYPE.VACATION' },
    { value: '5', labelKey: 'EVENTCREATION.TYPE.BIKE' },
    { value: '8', labelKey: 'EVENTCREATION.TYPE.TRAVEL' },
    { value: '1', labelKey: 'EVENTCREATION.TYPE.VTT' },
    { value: '13', labelKey: 'EVENTCREATION.TYPE.WINE' },
    { value: '14', labelKey: 'EVENTCREATION.TYPE.OTHER' },
    { value: '15', labelKey: 'EVENTCREATION.TYPE.VISIT' },
    { value: '16', labelKey: 'EVENTCREATION.TYPE.WORK' },
    { value: '17', labelKey: 'EVENTCREATION.TYPE.FAMILY' },
    { value: '18', labelKey: 'EVENTCREATION.TYPE.CINEMA' },
    { value: '19', labelKey: 'EVENTCREATION.TYPE.MUSIQUE' }
  ];
  insertImageEventsLoading = false;
  insertImageEventsError = false;
  /** Évènement en cours d'upload/post (id) — pour bloquer les autres lignes pendant l'envoi. */
  insertImageUploadingEventId: string | null = null;
  /** Message i18n affiché en bas du modal (succès / erreur). */
  insertImageFeedbackKey: string | null = null;
  /** Paramètres d'interpolation pour le message i18n. */
  insertImageFeedbackParams: { name?: string } = {};
  insertImageFeedbackKind: 'success' | 'error' | null = null;
  private insertImageEventsStreamSub?: Subscription;
  private insertImageUploadSub?: Subscription;
  private insertImageFeedbackTimer?: ReturnType<typeof setTimeout>;
  private static readonly INSERT_IMAGE_FEEDBACK_AUTO_CLOSE_MS = 1800;

  private static readonly WA_ME_SAFE_CHARS = 6000;

  /**
   * Seuil au-dessus duquel le modal de compression image s'ouvre lorsque
   * l'utilisateur insère une image générée dans un évènement (cohérent avec
   * la cible "~300KB" annoncée dans les libellés UI et avec le seuil utilisé
   * dans la compression côté chat de discussion).
   */
  private static readonly INSERT_IMAGE_COMPRESSION_THRESHOLD_BYTES = 300 * 1024;

  /**
   * État du modal de compression image (ouvert uniquement quand l'image
   * dépasse le seuil). `compressInsertImage` est lié au switch dans le
   * template et reflète le choix utilisateur (true = compresser).
   */
  compressInsertImage = true;
  /** Taille (en Ko, arrondie) affichée dans le modal pour informer l'utilisateur. */
  insertImageSizeKb = 0;
  private imageCompressionModalRef: NgbModalRef | null = null;

  /** Juste sous la bande bleue `.pat-title` (ou minimum sous navbar + tickers). */
  fabTopPx = 72;

  isOpen = false;
  fullscreen = false;
  draft = '';
  loading = false;
  messages: AssistantChatTurn[] = [];
  /** Outils OpenAI (API Responses) — envoyés avec le prochain message. */
  toolWebSearch = false;
  toolImageGeneration = false;
  toolMcp = false;

  /** Image choisie pour le prochain envoi (vision). */
  pendingImage: {
    mimeType: string;
    base64: string;
    dataUrl: string;
  } | null = null;
  /** Clé i18n ou message d’erreur après sélection de fichier. */
  imageAttachError: string | null = null;

  private static readonly IMAGE_MAX_BYTES = 8 * 1024 * 1024;
  private static readonly IMAGE_ACCEPT_RE = /^image\/(jpeg|png|gif|webp)$/i;
  /** Réponse (ou erreur) reçue alors que le panneau était fermé — pastille sur le FAB jusqu’à réouverture. */
  fabUnreadReply = false;
  private shouldAlignLastQuestionTop = false;

  /** Détail du solde crédits API (bouton titre). */
  creditsBannerOpen = false;
  creditsLoading = false;
  credits: AssistantOpenAiCredits | null = null;

  /** Dernier pixel de la navbar PatTool (~ --navbar-height). */
  private static readonly NAV_BOTTOM_PX = 60;
  private static readonly FAB_GAP_PX = 12;
  /** Espace entre le bas de `.pat-title` et le centre vertical du bouton. */
  private static readonly FAB_UNDER_TITLE_GAP_PX = 10;

  private tickerLayoutSub?: Subscription;
  private routerSub?: Subscription;
  private assistantLaunchSub?: Subscription;
  /** Annulation si nouvelle requête crédits avant la fin de la précédente. */
  private creditsFetchSub?: Subscription;
  /** Une seule requête config à la fois ; HTTP annulé si le composant est détruit. */
  private assistantConfigSub?: Subscription;
  private assistantConfigLoading = false;
  /** Annulation requête chat en cours (ex. navigation pendant l’appel). */
  private chatSendSub?: Subscription;
  private fabAnchorRaf = 0;
  private draftPersistTimer?: ReturnType<typeof setTimeout>;
  private transientTimeouts: Array<ReturnType<typeof setTimeout>> = [];
  private readonly boundScheduleFabAnchor = (): void => this.scheduleFabAnchorUpdate();

  /** Markdown assistant : évite de repasser marked/sanitize à chaque cycle de détection Angular. */
  private readonly assistantBubbleHtmlCache = new WeakMap<
    AssistantChatTurn,
    SafeHtml
  >();

  constructor(
    private keycloak: KeycloakService,
    private assistant: AssistantService,
    private assistantSession: AssistantSessionStore,
    private assistantLaunch: AssistantLaunchService,
    private router: Router,
    private newsTicker: NewsTickerService,
    private currencyTicker: CurrencyTickerService,
    private stockTicker: StockTickerService,
    private cdr: ChangeDetectorRef,
    private translate: TranslateService,
    private sanitizer: DomSanitizer,
    private mdChat: MarkdownChatRenderService,
    private ngZone: NgZone,
    private modalService: NgbModal,
    private evenementsService: EvenementsService,
    private fileService: FileService,
    private membersService: MembersService,
    private hostRef: ElementRef<HTMLElement>
  ) {}

  /** Ligne « fournisseur · modèle » issue de application.properties (GET /assistant/config). */
  clientConfigMetaLine = '';
  private assistantClientConfigLoaded = false;

  ngOnInit(): void {
    this.tickerLayoutSub = combineLatest([
      this.newsTicker.enabled$,
      this.currencyTicker.enabled$,
      this.stockTicker.enabled$
    ]).subscribe(() => this.scheduleFabAnchorUpdate());

    this.routerSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(() => {
        this.scheduleFabAnchorUpdate();
        this.scheduleTransient(() => this.scheduleFabAnchorUpdate(), 0);
        this.scheduleTransient(() => this.scheduleFabAnchorUpdate(), 140);
      });

    window.addEventListener('resize', this.boundScheduleFabAnchor, { passive: true });
    document.addEventListener('scroll', this.boundScheduleFabAnchor, { passive: true, capture: true });

    this.scheduleFabAnchorUpdate();
    if (this.isAuthenticated()) {
      const saved = this.assistantSession.load();
      if (saved != null) {
        this.messages = saved.messages;
        this.draft = saved.draft;
        const tf = saved.toolFlags;
        if (tf != null) {
          this.toolWebSearch = tf.webSearch === true;
          this.toolImageGeneration = tf.imageGeneration === true;
          this.toolMcp = tf.mcp === true;
        }
      }
      this.loadAssistantClientConfig();
    }

    this.assistantLaunchSub = this.assistantLaunch.launches$.subscribe((p) => {
      if (!this.isAuthenticated() || !p.draft?.trim()) {
        return;
      }
      if (p.newConversation) {
        this.chatSendSub?.unsubscribe();
        this.loading = false;
        this.messages = [];
      }
      this.draft = p.draft.trim();
      if (p.toolFlags) {
        const tf = p.toolFlags;
        if (tf.webSearch !== undefined) {
          this.toolWebSearch = tf.webSearch;
        }
        if (tf.imageGeneration !== undefined) {
          this.toolImageGeneration = tf.imageGeneration;
        }
        if (tf.mcp !== undefined) {
          this.toolMcp = tf.mcp;
        }
      }
      this.isOpen = true;
      this.fabUnreadReply = false;
      this.fullscreen = false;
      this.persistSession();
      this.scheduleFabAnchorUpdate();
      this.cdr.detectChanges();
      queueMicrotask(() => this.requestAlignLastQuestionTop());
    });
  }

  ngAfterViewInit(): void {
    queueMicrotask(() => this.scheduleFabAnchorUpdate());
    this.scheduleTransient(() => this.scheduleFabAnchorUpdate(), 0);
    this.scheduleTransient(() => this.scheduleFabAnchorUpdate(), 120);
    this.installThreadResizeObserver();
    queueMicrotask(() => this.fitGeneratedImagesInChat());
    this.scheduleTransient(() => this.fitGeneratedImagesInChat(), 120);
    this.scheduleTransient(() => this.fitGeneratedImagesInChat(), 400);
  }

  /**
   * Recalcule la hauteur max d'une image générée (markdown img dans une bulle
   * assistant) à partir de la hauteur RÉELLEMENT visible de la zone de
   * conversation, pour que l'image complète soit vue sans avoir à scroller.
   *
   * On retire une marge de chrome (en-tête de bulle, footer de réponse,
   * boutons d'action, padding du thread, message utilisateur précédent) afin
   * que l'image + son contexte tiennent dans la zone visible après l'auto-
   * scroll vers le bas. La valeur est exposée via la variable CSS
   * `--pat-assistant-md-img-max-h` consommée par `markdown-chat-content.css`.
   */
  /**
   * Pour chaque image générée affichée dans le thread (markdown img dans une
   * bulle assistant), mesure DIRECTEMENT son offset par rapport au sommet de
   * la zone de conversation visible, puis pose un `style.maxHeight` inline
   * calculé pour que l'image entière + le chrome qui la suit (footer de
   * réponse, marges) tienne dans la zone visible sans avoir à scroller.
   *
   * Préférée à une variable CSS approchée : la mesure est faite après que la
   * bulle est dans le DOM avec ses dimensions réelles, donc indépendante de
   * la longueur du prompt utilisateur précédent ou de la présence de tickers,
   * crédits, etc.
   */
  private fitGeneratedImagesInChat(): void {
    const thread = this.threadEl?.nativeElement;
    if (!thread) {
      return;
    }
    const visible = thread.clientHeight;
    if (!visible || visible <= 0) {
      return;
    }
    const imgs = thread.querySelectorAll(
      '.pat-assistant-md img'
    ) as NodeListOf<HTMLImageElement>;
    if (!imgs || imgs.length === 0) {
      return;
    }
    /**
     * Espace réservé SOUS l'image dans le bubble assistant pour la footer
     * (provider/model/stats), les marges du `<p>` parent, le padding de la
     * bulle, et un petit buffer pour ne pas frôler la limite.
     */
    const belowImageChrome = 110;

    const threadRect = thread.getBoundingClientRect();
    imgs.forEach((img) => {
      const apply = () => {
        const imgRect = img.getBoundingClientRect();
        const offsetFromThreadTop = imgRect.top - threadRect.top;
        const available = visible - offsetFromThreadTop - belowImageChrome;
        const target = Math.max(120, Math.floor(available));
        img.style.maxHeight = `${target}px`;
        img.style.maxWidth = '100%';
        img.style.width = 'auto';
        img.style.height = 'auto';
        img.style.objectFit = 'contain';
      };
      if (img.complete && img.naturalHeight > 0) {
        apply();
      } else {
        img.addEventListener('load', apply, { once: true });
      }
    });
  }

  private installThreadResizeObserver(): void {
    const thread = this.threadEl?.nativeElement;
    if (!thread) {
      return;
    }
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', this.boundFitGeneratedImagesInChat);
      return;
    }
    this.threadResizeObserver?.disconnect();
    this.threadResizeObserver = new ResizeObserver(() => {
      this.ngZone.run(() => this.fitGeneratedImagesInChat());
    });
    this.threadResizeObserver.observe(thread);
  }

  private threadResizeObserver: ResizeObserver | null = null;
  private readonly boundFitGeneratedImagesInChat = (): void => {
    this.fitGeneratedImagesInChat();
  };

  /** Timeouts annulés au destroy pour éviter callbacks après destruction. */
  private scheduleTransient(fn: () => void, ms: number): void {
    const id = setTimeout(() => {
      this.transientTimeouts = this.transientTimeouts.filter((t) => t !== id);
      fn();
    }, ms);
    this.transientTimeouts.push(id);
  }

  private loadAssistantClientConfig(): void {
    if (this.assistantClientConfigLoaded || this.assistantConfigLoading) {
      return;
    }
    this.assistantConfigLoading = true;
    this.assistantConfigSub?.unsubscribe();
    this.assistantConfigSub = this.assistant
      .getAssistantClientConfig()
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.assistantConfigLoading = false;
        })
      )
      .subscribe({
        next: (c) => {
          const p = typeof c.provider === 'string' ? c.provider.trim() : '';
          const m = typeof c.model === 'string' ? c.model.trim() : '';
          this.clientConfigMetaLine = [p, m]
            .filter((x) => x.length > 0)
            .join(' · ');
          this.assistantClientConfigLoaded = true;
          this.cdr.markForCheck();
        },
        error: () => {
          this.assistantClientConfigLoaded = true;
          this.cdr.markForCheck();
        }
      });
  }

  /** Sous-titre du bandeau : config serveur en priorité, sinon dernière réponse. */
  headerTitleMetaLine(): string {
    if (this.clientConfigMetaLine) {
      return this.clientConfigMetaLine;
    }
    return this.headerProviderModelLine();
  }

  /** Fournisseur · modèle affichés sous le titre du panneau (dernière réponse assistant). */
  headerProviderModelLine(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === 'assistant') {
        const line = this.replyProviderModelLine(m);
        if (line.length > 0) {
          return line;
        }
      }
    }
    return '';
  }

  /** Libellé accessibilité du panneau : titre + fournisseur/modèle si connus. */
  drawerAriaLabel(): string {
    const base = this.translate.instant('ASSISTANT.TITLE');
    const meta = this.headerTitleMetaLine();
    return meta ? `${base} — ${meta}` : base;
  }

  /** Infobulle / aria du bouton flottant : variante « réponse prête » si le panneau était fermé pendant la réponse. */
  fabAssistFabTitleKey(): string {
    if (this.isOpen) {
      return 'ASSISTANT.CLOSE';
    }
    if (this.fabUnreadReply) {
      return 'ASSISTANT.FAB_REPLY_READY_TITLE';
    }
    return 'ASSISTANT.TOGGLE';
  }

  /** Fournisseur et modèle (réponse succès uniquement si le backend les envoie). */
  replyProviderModelLine(m: AssistantChatTurn): string {
    if (m.role !== 'assistant') {
      return '';
    }
    const meta = m.meta;
    const provider =
      typeof meta?.provider === 'string' ? meta.provider.trim() : '';
    const model =
      typeof meta?.model === 'string' ? meta.model.trim() : '';
    const parts = [provider, model].filter((x) => x.length > 0);
    return parts.join(' · ');
  }

  replyStatsLine(m: AssistantChatTurn): string {
    if (m.role !== 'assistant') {
      return '';
    }
    const meta = m.meta;
    const tin = meta?.inputTokens;
    const tout = meta?.outputTokens;
    const elapsedMs =
      meta?.elapsedMs != null &&
      typeof meta.elapsedMs === 'number' &&
      Number.isFinite(meta.elapsedMs) &&
      meta.elapsedMs >= 0
        ? Math.round(meta.elapsedMs)
        : undefined;
    const hasTokens =
      (tin != null && tin >= 0) || (tout != null && tout >= 0);
    const i = tin ?? 0;
    const o = tout ?? 0;

    if (elapsedMs != null && hasTokens) {
      return this.translate.instant('ASSISTANT.STAT_MS_AND_TOKENS', {
        ms: elapsedMs,
        total: i + o,
        in: i,
        out: o
      });
    }
    if (hasTokens) {
      return this.translate.instant('ASSISTANT.STAT_TOKENS', {
        total: i + o,
        in: i,
        out: o
      });
    }
    if (elapsedMs != null) {
      return this.translate.instant('ASSISTANT.STAT_MS', { ms: elapsedMs });
    }
    return '';
  }

  toggleCreditsBanner(ev?: MouseEvent): void {
    ev?.stopPropagation();
    this.creditsBannerOpen = !this.creditsBannerOpen;
    if (this.creditsBannerOpen) {
      this.fetchOpenAiCredits();
    }
  }

  fetchOpenAiCredits(): void {
    if (!this.isAuthenticated()) {
      return;
    }
    this.creditsLoading = true;
    this.cdr.detectChanges();
    this.creditsFetchSub?.unsubscribe();
    this.creditsFetchSub = this.assistant
      .getOpenAiCredits()
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.creditsLoading = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (c) => {
          this.credits = c;
          this.cdr.detectChanges();
        },
        error: () => {
          this.credits = {
            ok: false,
            message: this.translate.instant('ASSISTANT.CREDITS_NETWORK_ERROR')
          };
          this.cdr.detectChanges();
        }
      });
  }

  ngOnDestroy(): void {
    this.persistSession();
    this.loading = false;
    if (this.draftPersistTimer !== undefined) {
      clearTimeout(this.draftPersistTimer);
    }
    for (const id of this.transientTimeouts) {
      clearTimeout(id);
    }
    this.transientTimeouts = [];
    this.tickerLayoutSub?.unsubscribe();
    this.routerSub?.unsubscribe();
    this.assistantLaunchSub?.unsubscribe();
    this.creditsFetchSub?.unsubscribe();
    this.assistantConfigSub?.unsubscribe();
    this.chatSendSub?.unsubscribe();
    this.insertImageEventsStreamSub?.unsubscribe();
    this.insertImageUploadSub?.unsubscribe();
    if (this.insertImageFeedbackTimer !== undefined) {
      clearTimeout(this.insertImageFeedbackTimer);
    }
    if (this.whatsappShareModalRef) {
      try {
        this.whatsappShareModalRef.dismiss();
      } catch {
        /* ignore */
      }
      this.whatsappShareModalRef = null;
    }
    if (this.insertImageModalRef) {
      try {
        this.insertImageModalRef.dismiss();
      } catch {
        /* ignore */
      }
      this.insertImageModalRef = null;
    }
    if (this.imageCompressionModalRef) {
      try {
        this.imageCompressionModalRef.dismiss();
      } catch {
        /* ignore */
      }
      this.imageCompressionModalRef = null;
    }
    this.revokeSlideshowBlobUrls();
    if (this.assistantImageCopyFeedbackTimer) {
      clearTimeout(this.assistantImageCopyFeedbackTimer);
      this.assistantImageCopyFeedbackTimer = undefined;
    }
    if (this.threadResizeObserver) {
      try {
        this.threadResizeObserver.disconnect();
      } catch {
        /* ignore */
      }
      this.threadResizeObserver = null;
    }
    window.removeEventListener('resize', this.boundFitGeneratedImagesInChat);
    window.removeEventListener('resize', this.boundScheduleFabAnchor);
    document.removeEventListener('scroll', this.boundScheduleFabAnchor, true);
    if (this.fabAnchorRaf) {
      cancelAnimationFrame(this.fabAnchorRaf);
    }
  }

  /** sessionStorage pour cet utilisateur jusqu’à fermeture de l’onglet. */
  private persistSession(): void {
    if (!this.isAuthenticated()) {
      return;
    }
    this.assistantSession.save(
      this.messages,
      this.draft ?? '',
      this.collectToolFlagsForSession()
    );
  }

  private collectToolFlagsForSession(): AssistantToolFlagsRequest | undefined {
    const o: AssistantToolFlagsRequest = {};
    if (this.toolWebSearch) {
      o.webSearch = true;
    }
    if (this.toolImageGeneration) {
      o.imageGeneration = true;
    }
    if (this.toolMcp) {
      o.mcp = true;
    }
    return Object.keys(o).length > 0 ? o : undefined;
  }

  onToolFlagsChanged(): void {
    this.persistSession();
  }

  /** Frappe dans la zone : reporte l’autosauvegarde du brouillon. */
  onDraftDebouncedPersist(): void {
    if (!this.isAuthenticated()) {
      return;
    }
    if (
      this.draft.trim().length > 0 &&
      this.imageAttachError === 'ASSISTANT.IMAGE_NEED_QUESTION'
    ) {
      this.imageAttachError = null;
    }
    if (this.draftPersistTimer !== undefined) {
      clearTimeout(this.draftPersistTimer);
    }
    this.draftPersistTimer = setTimeout(() => {
      this.draftPersistTimer = undefined;
      this.persistSession();
    }, 450);
  }

  /** Recalcule la position fixed du bouton sous `.pat-title` (viewport). */
  private scheduleFabAnchorUpdate(): void {
    if (this.fabAnchorRaf !== 0) {
      return;
    }
    this.fabAnchorRaf = requestAnimationFrame(() => {
      this.fabAnchorRaf = 0;
      this.updateFabAnchor();
    });
  }

  /** Choisir le bandeau `.pat-title` réellement visible (évite le premier nœud caché / hors viewport). */
  private static resolvePatTitleForFabAnchor(): HTMLElement | null {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return null;
    }
    const titles = Array.from(document.querySelectorAll('.pat-title')).filter(
      (n): n is HTMLElement => n instanceof HTMLElement
    );
    if (titles.length === 0) {
      return null;
    }
    const vh = window.innerHeight;
    let best: HTMLElement | null = null;
    let bestOverlap = -1;

    for (const el of titles) {
      let cs: CSSStyleDeclaration | null = null;
      try {
        cs = getComputedStyle(el);
      } catch {
        cs = null;
      }
      if (cs != null && (cs.display === 'none' || cs.visibility === 'hidden')) {
        continue;
      }

      let r: DOMRect;
      try {
        r = el.getBoundingClientRect();
      } catch {
        continue;
      }
      if (r.height < 3 || r.width < 3) {
        continue;
      }

      const visibleTop = Math.max(0, r.top);
      const visibleBottom = Math.min(vh, r.bottom);
      const overlap = Math.max(0, visibleBottom - visibleTop);

      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = el;
      } else if (overlap === bestOverlap && overlap > 0 && best != null) {
        const bt = best.getBoundingClientRect().top;
        if (r.top < bt) {
          best = el;
        }
      }
    }

    return best ?? titles[titles.length - 1];
  }

  private updateFabAnchor(): void {
    const minTop = AssistantDrawerComponent.computeFabTopBelowNavAndTickers(
      this.newsTicker.isEnabled,
      this.currencyTicker.isEnabled,
      this.stockTicker.isEnabled
    );
    const title = AssistantDrawerComponent.resolvePatTitleForFabAnchor();
    let next = minTop;
    if (title) {
      const bottom = title.getBoundingClientRect().bottom;
      next = Math.max(
        minTop,
        Math.round(bottom + AssistantDrawerComponent.FAB_UNDER_TITLE_GAP_PX)
      );
    }
    if (next !== this.fabTopPx) {
      this.fabTopPx = next;
      this.cdr.markForCheck();
    }
  }

  /** Même empilement que les CSS news/currency/stock ticker (anchors à 56px). */
  private static computeFabTopBelowNavAndTickers(
    news: boolean,
    currency: boolean,
    stock: boolean
  ): number {
    let stackBottom = AssistantDrawerComponent.NAV_BOTTOM_PX;
    if (news) {
      stackBottom = Math.max(stackBottom, 112);
    }
    if (currency) {
      const currencyTop = news ? 112 : 56;
      stackBottom = Math.max(stackBottom, currencyTop + 40);
    }
    if (stock) {
      let stockTop = 56;
      if (news && currency) {
        stockTop = 152;
      } else if (news) {
        stockTop = 112;
      } else if (currency) {
        stockTop = 96;
      }
      stackBottom = Math.max(stackBottom, stockTop + 40);
    }
    return stackBottom + AssistantDrawerComponent.FAB_GAP_PX;
  }

  isAuthenticated(): boolean {
    return this.keycloak.isLoggedIn();
  }

  /** Libellé utilisateur (bulles + placeholder) : preferred_username Keycloak, sinon prénom/nom ou e-mail. */
  chatUserLabel(): string {
    const authz: any = this.keycloak.getAuth();
    const tp = authz?.tokenParsed;
    if (!tp || typeof tp !== 'object') {
      return '';
    }
    const u = typeof tp.preferred_username === 'string' ? tp.preferred_username.trim() : '';
    if (u) {
      return u;
    }
    const fn = typeof tp.given_name === 'string' ? tp.given_name.trim() : '';
    const ln = typeof tp.family_name === 'string' ? tp.family_name.trim() : '';
    const full = [fn, ln].filter(Boolean).join(' ').trim();
    if (full) {
      return full;
    }
    const em = typeof tp.email === 'string' ? tp.email.trim() : '';
    if (em) {
      const at = em.indexOf('@');
      return at > 0 ? em.slice(0, at) : em;
    }
    return '';
  }

  /** Index du dernier message utilisateur (question posée la plus récente). */
  lastUserMessageIndex(): number {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'user') {
        return i;
      }
    }
    return -1;
  }

  /**
   * Corps de bulle : Markdown assistant (mis en cache par objet tour), liens + sauts de ligne pour l’utilisateur.
   */
  bubbleRichHtml(m: AssistantChatTurn): SafeHtml {
    if (m.role === 'assistant') {
      const hit = this.assistantBubbleHtmlCache.get(m);
      if (hit != null) {
        return hit;
      }
      const md = this.mdChat.renderModelReply(m.content);
      const built = md ?? this.linkRichContent(m.content);
      this.assistantBubbleHtmlCache.set(m, built);
      return built;
    }
    return this.linkRichContent(m.content);
  }

  /**
   * Corps de message enrichi : texte échappé, retours ligne → br, URLs http(s) cliquables.
   */
  linkRichContent(text: string | null | undefined): SafeHtml {
    if (text == null || text === '') {
      return this.sanitizer.bypassSecurityTrustHtml('');
    }
    const s = String(text);
    const re = /\b(https?:\/\/[^\s<>"']+)/gi;
    let built = '';
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(s)) !== null) {
      const idx = match.index;
      const full = match[0];
      built += this.escapeHtmlBasic(s.slice(last, idx));
      let url = full;
      let punctTail = '';
      const trailChars = `.,;:!?)]}'"`;
      while (url.length > 0 && trailChars.includes(url.charAt(url.length - 1))) {
        punctTail = url.slice(-1) + punctTail;
        url = url.slice(0, -1);
      }
      let href = url;
      try {
        href = encodeURI(url);
      } catch {
        href = url;
      }
      built +=
        '<a class="pat-assistant-link" href="' +
        this.escapeHtmlAttr(href) +
        '" target="_blank" rel="noopener noreferrer">' +
        this.escapeHtmlBasic(url) +
        '</a>';
      built += this.escapeHtmlBasic(punctTail);
      last = idx + full.length;
    }
    built += this.escapeHtmlBasic(s.slice(last));
    built = built.replace(/\r\n|\r|\n/g, '<br>');
    return this.sanitizer.bypassSecurityTrustHtml(built);
  }

  private escapeHtmlBasic(t: string): string {
    return t
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private escapeHtmlAttr(t: string): string {
    return this.escapeHtmlBasic(t).replace(/\r?\n/g, ' ');
  }

  /** Copie le texte brut de la réponse (Markdown inclus) dans le presse-papiers. */
  copyAssistantReply(content: string | null | undefined, ev: MouseEvent): void {
    ev.stopPropagation();
    ev.preventDefault();
    copyPlainTextToClipboard(typeof content === 'string' ? content : '');
  }

  /**
   * Copie la PREMIÈRE image générée d'une bulle assistant comme image binaire
   * dans le presse-papiers (utilise l'API Clipboard moderne avec
   * `ClipboardItem`). Permet ensuite un coller direct dans Word, Outlook,
   * Paint, etc. — au lieu de copier la longue data URL en base64 sous forme
   * de texte (ce que faisait l'ancien bouton générique "copier la réponse").
   */
  async copyAssistantImageToClipboard(m: AssistantChatTurn, ev: MouseEvent): Promise<void> {
    ev.stopPropagation();
    ev.preventDefault();
    if (m.role !== 'assistant') {
      return;
    }
    const dataUrls = this.extractGeneratedImageDataUrls(m.content);
    if (dataUrls.length === 0) {
      return;
    }
    const blob = this.dataUrlToBlob(dataUrls[0]);
    if (!blob) {
      this.showAssistantImageCopyFeedback(false);
      return;
    }

    /**
     * Pour la compatibilité maximale entre navigateurs, on utilise `image/png`
     * comme MIME du `ClipboardItem` (Chrome/Edge/Firefox/Safari supportent
     * tous PNG). Si le blob source est PNG, on le passe tel quel ; sinon on
     * tente de le re-encoder en PNG via canvas.
     */
    let pngBlob: Blob = blob;
    if (blob.type !== 'image/png') {
      const reEncoded = await this.encodeBlobAsPng(blob);
      if (reEncoded) {
        pngBlob = reEncoded;
      }
    }

    try {
      const w = window as unknown as {
        ClipboardItem?: new (items: Record<string, Blob | Promise<Blob>>) => unknown;
      };
      if (
        navigator.clipboard &&
        typeof navigator.clipboard.write === 'function' &&
        typeof w.ClipboardItem === 'function'
      ) {
        const item = new w.ClipboardItem!({ 'image/png': pngBlob });
        await (
          navigator.clipboard as unknown as {
            write: (items: unknown[]) => Promise<void>;
          }
        ).write([item]);
        this.showAssistantImageCopyFeedback(true);
        return;
      }
    } catch {
      /* fallback below */
    }
    this.showAssistantImageCopyFeedback(false);
  }

  /**
   * Convertit un Blob image (jpeg/webp/...) en PNG via un canvas off-screen.
   * Retourne null si l'opération échoue (CORS, decoding error, etc.).
   */
  private encodeBlobAsPng(blob: Blob): Promise<Blob | null> {
    return new Promise((resolve) => {
      try {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        const cleanup = () => URL.revokeObjectURL(url);
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth || img.width || 1;
            canvas.height = img.naturalHeight || img.height || 1;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              cleanup();
              resolve(null);
              return;
            }
            ctx.drawImage(img, 0, 0);
            canvas.toBlob((out) => {
              cleanup();
              resolve(out);
            }, 'image/png');
          } catch {
            cleanup();
            resolve(null);
          }
        };
        img.onerror = () => {
          cleanup();
          resolve(null);
        };
        img.src = url;
      } catch {
        resolve(null);
      }
    });
  }

  /** Petit message éphémère sous la zone de chat (succès / échec de copie image). */
  assistantImageCopyFeedbackKey: string | null = null;
  assistantImageCopyFeedbackKind: 'success' | 'error' | null = null;
  private assistantImageCopyFeedbackTimer?: ReturnType<typeof setTimeout>;
  private showAssistantImageCopyFeedback(success: boolean): void {
    if (this.assistantImageCopyFeedbackTimer) {
      clearTimeout(this.assistantImageCopyFeedbackTimer);
    }
    this.assistantImageCopyFeedbackKey = success
      ? 'ASSISTANT.COPY_IMG_SUCCESS'
      : 'ASSISTANT.COPY_IMG_ERROR';
    this.assistantImageCopyFeedbackKind = success ? 'success' : 'error';
    this.cdr.markForCheck();
    this.assistantImageCopyFeedbackTimer = setTimeout(() => {
      this.assistantImageCopyFeedbackKey = null;
      this.assistantImageCopyFeedbackKind = null;
      this.cdr.markForCheck();
    }, 2200);
  }

  /** Recopie une question précédente dans le champ du bas (pour relancer ou modifier). */
  copyQuestionIntoDraft(content: string, ev: MouseEvent): void {
    ev.stopPropagation();
    ev.preventDefault();
    const text = typeof content === 'string' ? content : '';
    if (this.loading) {
      return;
    }
    this.draft = text;
    if (this.draftPersistTimer !== undefined) {
      clearTimeout(this.draftPersistTimer);
      this.draftPersistTimer = undefined;
    }
    this.persistSession();
    this.cdr.detectChanges();
    queueMicrotask(() => {
      const el = this.draftInputEl?.nativeElement;
      if (el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    });
  }

  ngAfterViewChecked(): void {
    if (this.shouldAlignLastQuestionTop && this.threadEl) {
      const wrap = this.threadEl.nativeElement;
      const anchor = wrap.querySelector(
        '.pat-assistant-bubble--anchor-last-q'
      ) as HTMLElement | null;
      if (anchor) {
        const desiredTop =
          anchor.getBoundingClientRect().top -
          wrap.getBoundingClientRect().top +
          wrap.scrollTop;
        wrap.scrollTop = Math.max(0, desiredTop - 4);
      }
      this.shouldAlignLastQuestionTop = false;
    }
    /**
     * Toujours redimensionner les images du chat : ngAfterViewChecked se
     * déclenche après chaque cycle de détection (incluant l'ajout d'une
     * nouvelle bulle assistant avec image), et fitGeneratedImagesInChat est
     * idempotent + bon-marché (querySelectorAll ciblé + early-return).
     */
    queueMicrotask(() => this.fitGeneratedImagesInChat());
  }

  toggle(): void {
    if (!this.isAuthenticated()) {
      return;
    }
    this.isOpen = !this.isOpen;
    if (this.isOpen) {
      this.fabUnreadReply = false;
      if (!this.assistantClientConfigLoaded) {
        this.loadAssistantClientConfig();
      }
      if (this.messages.length > 0) {
        queueMicrotask(() => this.requestAlignLastQuestionTop());
      }
    } else {
      this.creditsBannerOpen = false;
    }
  }

  close(): void {
    this.persistSession();
    this.isOpen = false;
    this.fullscreen = false;
    this.creditsBannerOpen = false;
  }

  toggleFullscreen(): void {
    this.fullscreen = !this.fullscreen;
    if (this.messages.length > 0) {
      queueMicrotask(() => this.requestAlignLastQuestionTop());
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (!this.isOpen) {
      return;
    }
    if (this.fullscreen) {
      this.fullscreen = false;
      return;
    }
    this.close();
  }

  clearThread(): void {
    this.messages = [];
    this.draft = '';
    this.pendingImage = null;
    this.imageAttachError = null;
    this.fabUnreadReply = false;
    this.persistSession();
  }

  /** Réinitialisation possible s'il y a du contenu à effacer (historique ou brouillon). */
  hasAnythingToReset(): boolean {
    return (
      this.messages.length > 0 ||
      (!!this.draft && this.draft.trim().length > 0) ||
      this.pendingImage != null
    );
  }

  openImagePicker(): void {
    this.imageAttachError = null;
    this.imageFileInputEl?.nativeElement?.click();
  }

  clearPendingImage(): void {
    this.pendingImage = null;
    this.imageAttachError = null;
    this.cdr.markForCheck();
  }

  onImageFileChange(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    this.imageAttachError = null;
    if (!file) {
      return;
    }
    if (!AssistantDrawerComponent.IMAGE_ACCEPT_RE.test(file.type)) {
      this.imageAttachError = 'ASSISTANT.IMAGE_TYPE_REJECTED';
      this.cdr.markForCheck();
      return;
    }
    if (file.size > AssistantDrawerComponent.IMAGE_MAX_BYTES) {
      this.imageAttachError = 'ASSISTANT.IMAGE_TOO_LARGE';
      this.cdr.markForCheck();
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      this.ngZone.run(() => {
        const dataUrl = reader.result as string;
        const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
        if (!m?.[1] || !m[2]) {
          this.imageAttachError = 'ASSISTANT.IMAGE_READ_ERROR';
          this.pendingImage = null;
          this.cdr.markForCheck();
          return;
        }
        this.pendingImage = {
          mimeType: m[1].trim().toLowerCase(),
          base64: m[2].replace(/\s+/g, ''),
          dataUrl
        };
        this.imageAttachError = null;
        this.cdr.markForCheck();
      });
    };
    reader.onerror = () => {
      this.ngZone.run(() => {
        this.imageAttachError = 'ASSISTANT.IMAGE_READ_ERROR';
        this.pendingImage = null;
        this.cdr.markForCheck();
      });
    };
    reader.readAsDataURL(file);
  }

  trustedImageSrc(url: string): SafeUrl {
    return this.sanitizer.bypassSecurityTrustUrl(url);
  }

  send(): void {
    if (this.loading || !this.isAuthenticated()) {
      return;
    }
    const hasImage = this.pendingImage != null;
    const textTrim = this.draft.trim();
    if (!textTrim && !hasImage) {
      return;
    }
    if (hasImage && !textTrim) {
      this.imageAttachError = 'ASSISTANT.IMAGE_NEED_QUESTION';
      this.cdr.markForCheck();
      return;
    }
    const text = textTrim;

    const attached: AssistantAttachedImageRequest | undefined =
      hasImage && this.pendingImage
        ? {
            mimeType: this.pendingImage.mimeType,
            base64: this.pendingImage.base64
          }
        : undefined;
    const previewDataUrl = this.pendingImage?.dataUrl;

    this.draft = '';
    this.pendingImage = null;
    this.imageAttachError = null;

    const userMsg: AssistantChatTurn = {
      role: 'user',
      content: text,
      ...(attached
        ? { hasImage: true, imageDataUrl: previewDataUrl }
        : {})
    };
    this.messages = [...this.messages, userMsg];
    this.persistSession();
    this.requestAlignLastQuestionTop();
    this.loading = true;

    const payload = this.messages.map((m) => ({
      role: m.role,
      content: m.content
    }));

    this.chatSendSub?.unsubscribe();
    this.chatSendSub = this.assistant
      .sendMessages(
        payload,
        undefined,
        this.collectToolFlagsForSession(),
        attached
      )
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          // Évite NG0100 si la réponse arrive de façon synchrone : finalize sinon dans le même tick que detectChanges() du next.
          queueMicrotask(() => {
            this.loading = false;
            this.cdr.markForCheck();
          });
        })
      )
      .subscribe({
      next: (res) => {
        this.ngZone.run(() => {
          const buildMetaFromRes = (): AssistantChatMeta | undefined => {
            const meta: AssistantChatMeta = {};
            const elapsedMs = parseElapsedMsFromAssistantResponse(res);
            if (elapsedMs != null) {
              meta.elapsedMs = elapsedMs;
            }
            if (res.inputTokens != null) {
              meta.inputTokens = res.inputTokens;
            }
            if (res.outputTokens != null) {
              meta.outputTokens = res.outputTokens;
            }
            const prov =
              typeof res.provider === 'string' ? res.provider.trim() : '';
            if (prov) {
              meta.provider = prov;
            }
            const mod =
              typeof res.model === 'string' ? res.model.trim() : '';
            if (mod) {
              meta.model = mod;
            }
            return Object.keys(meta).length ? meta : undefined;
          };
          if (res.error) {
            const meta = buildMetaFromRes();
            this.messages = [
              ...this.messages,
              {
                role: 'assistant',
                content: res.error,
                ...(meta ? { meta } : {})
              }
            ];
          } else {
            const answer =
              res.content != null && res.content.length > 0
                ? res.content
                : '(Réponse vide)';
            const meta = buildMetaFromRes();
            this.messages = [
              ...this.messages,
              {
                role: 'assistant',
                content: answer,
                ...(meta ? { meta } : {})
              }
            ];
          }
          this.onAssistantTurnFinished();
        });
      },
      error: () => {
        this.ngZone.run(() => {
          this.messages = [
            ...this.messages,
            {
              role: 'assistant',
              content: 'Erreur réseau ou serveur. Réessayez plus tard.'
            }
          ];
          this.onAssistantTurnFinished();
        });
      }
    });
  }

  onTextareaKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      this.send();
    }
  }

  private onAssistantTurnFinished(): void {
    if (!this.isOpen) {
      this.fabUnreadReply = true;
    }
    this.requestAlignLastQuestionTop();
    this.persistSession();
    this.cdr.detectChanges();
  }

  private requestAlignLastQuestionTop(): void {
    this.shouldAlignLastQuestionTop = true;
  }

  /** Ouvert uniquement avec au moins un message dans l’historique. */
  canShareAssistantWhatsApp(): boolean {
    return this.messages.length > 0 && !this.loading;
  }

  /**
   * Vrai si la bulle assistant contient au moins une image générée
   * (insérée par le backend sous forme de Markdown `![…](data:image/…)` ou de balise `<img>`).
   */
  hasGeneratedImage(m: AssistantChatTurn): boolean {
    return m.role === 'assistant' && this.extractGeneratedImageDataUrls(m.content).length > 0;
  }

  /**
   * Extrait les data-URL des images générées présentes dans un contenu assistant.
   * Couvre le format Markdown produit par le backend (`![Image générée](data:image/…)`)
   * et le repli direct `<img src="data:image/…">` au cas où le backend changerait.
   */
  private extractGeneratedImageDataUrls(content: string | null | undefined): string[] {
    if (content == null || content === '') {
      return [];
    }
    const out: string[] = [];
    const seen = new Set<string>();
    const mdRe = /!\[[^\]]*\]\((data:image\/[a-zA-Z0-9.+-]+;base64,[^)\s]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = mdRe.exec(content)) !== null) {
      const url = m[1];
      if (url && !seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    }
    const imgRe = /<img[^>]*\ssrc=["'](data:image\/[a-zA-Z0-9.+-]+;base64,[^"']+)["']/gi;
    while ((m = imgRe.exec(content)) !== null) {
      const url = m[1];
      if (url && !seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    }
    return out;
  }

  /**
   * Récupère le texte du dernier message utilisateur précédant la bulle assistant donnée.
   * Sert de prompt « ayant servi à générer l’image » pour le partage WhatsApp.
   */
  private findPromptingUserText(m: AssistantChatTurn): string {
    const idx = this.messages.indexOf(m);
    if (idx < 0) {
      return '';
    }
    for (let i = idx - 1; i >= 0; i--) {
      const prev = this.messages[i];
      if (prev?.role === 'user') {
        return typeof prev.content === 'string' ? prev.content.trim() : '';
      }
    }
    return '';
  }

  /**
   * Partage WhatsApp ciblé sur une image générée par l’assistant + le prompt utilisateur
   * qui l’a déclenchée. Utilise Web Share API avec fichier(s) ; repli wa.me texte seul si indispo.
   */
  async shareGeneratedImageOnWhatsApp(m: AssistantChatTurn, ev: Event): Promise<void> {
    ev.stopPropagation();
    ev.preventDefault();
    if (!this.hasGeneratedImage(m)) {
      return;
    }

    const dataUrls = this.extractGeneratedImageDataUrls(m.content);
    const files: File[] = [];
    let i = 0;
    for (const url of dataUrls) {
      const f = await this.dataUrlToFile(url, `pat-assistant-generated-${i++}`);
      if (f) {
        files.push(f);
      }
    }

    const title = this.translate.instant('ASSISTANT.TITLE');
    const promptLabel = this.translate.instant('ASSISTANT.SHARE_GENERATED_IMG_PROMPT_LABEL');
    const promptRaw = this.findPromptingUserText(m);
    const promptWa = promptRaw
      ? this.formatMarkdownForWhatsApp(promptRaw).trim()
      : '';

    let message = `*${title}*`;
    if (promptWa.length > 0) {
      message += `\n\n*${promptLabel}*\n\n${promptWa}`;
    }

    const nav = navigator as Navigator & {
      share?: (data: ShareData) => Promise<void>;
      canShare?: (data: ShareData) => boolean;
    };

    const aborted = (e: unknown): boolean =>
      e != null &&
      typeof e === 'object' &&
      'name' in e &&
      String((e as { name?: string }).name) === 'AbortError';

    if (typeof nav.share === 'function') {
      if (files.length > 0) {
        const withFiles: ShareData = { title, text: message, files };
        const canShare = typeof nav.canShare === 'function' ? nav.canShare(withFiles) : true;
        if (canShare) {
          try {
            await nav.share(withFiles);
            return;
          } catch (err: unknown) {
            if (aborted(err)) {
              return;
            }
          }
        }
      }
      try {
        await nav.share({ title, text: message });
        return;
      } catch (err: unknown) {
        if (aborted(err)) {
          return;
        }
      }
    }

    const waText = this.truncateForWaMe(message);
    window.open(
      `https://wa.me/?text=${encodeURIComponent(waText)}`,
      '_blank',
      'noopener,noreferrer'
    );
  }

  // -------------------------------------------------------------------------
  // Insertion d'une image générée dans un évènement (collection MongoDB).
  // -------------------------------------------------------------------------

  /**
   * Ouvre le modal de sélection d'évènement pour insérer la 1re image générée
   * de la bulle assistant cliquée. Charge la liste des évènements accessibles
   * à l'utilisateur courant via SSE (`streamEvents`) et affiche un picker filtrable.
   */
  openInsertImageInEventModal(m: AssistantChatTurn, ev: Event): void {
    ev.stopPropagation();
    ev.preventDefault();
    if (!this.hasGeneratedImage(m)) {
      return;
    }
    const dataUrls = this.extractGeneratedImageDataUrls(m.content);
    if (dataUrls.length === 0) {
      return;
    }
    this.insertMode = 'image';
    this.insertImageDataUrl = dataUrls[0];
    this.insertCommentText = '';
    this.openInsertEventModal();
  }

  /**
   * Ouvre le même modal d'évènement mais en mode « insérer comme commentaire » :
   * le contenu de la bulle assistant (et la question utilisateur précédente) est
   * pré-rempli dans un textarea modifiable avant envoi.
   */
  openInsertCommentInEventModal(m: AssistantChatTurn, ev: Event): void {
    ev.stopPropagation();
    ev.preventDefault();
    if (m.role !== 'assistant') {
      return;
    }
    this.insertMode = 'comment';
    this.insertImageDataUrl = null;
    this.insertCommentText = this.buildDefaultCommentText(m);
    this.openInsertEventModal();
  }

  /** Initialisation commune des deux modes (état du picker + ouverture NgbModal). */
  private openInsertEventModal(): void {
    this.insertImageEventsList = [];
    this.insertImageEventsFilter = '';
    this.insertImageEventsTypeFilter = '';
    this.insertImageEventsLoading = true;
    this.insertImageEventsError = false;
    this.insertImageUploadingEventId = null;
    this.insertImageFeedbackKey = null;
    this.insertImageFeedbackParams = {};
    this.insertImageFeedbackKind = null;
    if (this.insertImageFeedbackTimer !== undefined) {
      clearTimeout(this.insertImageFeedbackTimer);
      this.insertImageFeedbackTimer = undefined;
    }

    this.insertImageModalRef = this.modalService.open(this.assistantInsertImageInEventModal, {
      size: 'lg',
      centered: true,
      windowClass: 'assistant-insert-image-modal',
      modalDialogClass: 'assistant-insert-image-modal-dialog'
    });
    this.insertImageModalRef.dismissed.subscribe(() => this.onInsertImageModalClosed());
    this.insertImageModalRef.closed.subscribe(() => this.onInsertImageModalClosed());
    this.cdr.markForCheck();

    this.streamEventsForInsertImage();
  }

  /**
   * Pré-remplissage de commentaire en HTML : converti le markdown de la réponse
   * assistant via marked (gras / italique / titres / listes / liens / code…)
   * et préfixe par la question utilisateur (échappée HTML pour rester safe).
   *
   * Les éventuelles images générées (`data:image/...` base64) sont extraites
   * de la réponse, le texte est rendu sans elles (et tronqué si trop long),
   * puis chaque image est ajoutée en fin de commentaire dans son propre
   * `<p><img src="data:..."/></p>` — afin que la troncature du texte ne
   * casse jamais le base64 d'une image.
   *
   * Compatible avec l'éditeur Quill et l'affichage HTML des commentaires.
   */
  private buildDefaultCommentText(m: AssistantChatTurn): string {
    const promptRaw = this.findPromptingUserText(m);
    const replyRaw = typeof m.content === 'string' ? m.content : '';
    const imageDataUrls = this.extractGeneratedImageDataUrls(replyRaw);
    const replyTextOnly = this.stripGeneratedImagesFromContent(replyRaw).trim();

    const prefixQ = this.translate.instant('ASSISTANT.INSERT_CMT_IN_EVENT_PROMPT_PREFIX');
    const prefixR = this.translate.instant('ASSISTANT.INSERT_CMT_IN_EVENT_REPLY_PREFIX');

    const parts: string[] = [];
    if (promptRaw && promptRaw.trim().length > 0) {
      parts.push(`<p><strong>${this.escapeHtmlBasic(prefixQ)}</strong></p>`);
      parts.push(
        `<p>${this.escapeHtmlBasic(promptRaw.trim()).replace(/\r?\n/g, '<br>')}</p>`
      );
    }
    if (replyTextOnly.length > 0) {
      parts.push(`<p><strong>${this.escapeHtmlBasic(prefixR)}</strong></p>`);
      let replyHtml: string;
      try {
        replyHtml = marked.parse(replyTextOnly, { async: false }) as string;
      } catch {
        replyHtml = `<p>${this.escapeHtmlBasic(replyTextOnly).replace(/\r?\n/g, '<br>')}</p>`;
      }
      parts.push(replyHtml);
    }

    let textHtml = parts.join('\n');
    const max = AssistantDrawerComponent.INSERT_COMMENT_MAX_TEXT_HTML_CHARS;
    if (textHtml.length > max) {
      textHtml = textHtml.slice(0, Math.max(0, max - 1)) + '…';
    }

    if (imageDataUrls.length > 0) {
      /**
       * On encapsule chaque image dans un `<a target="_blank">` pointant vers
       * la même data URL : le rendu HTML du commentaire (commentary-editor)
       * la limite en taille (max-height en CSS), mais un click sur l'image
       * l'ouvre alors en plein dans un nouvel onglet du navigateur.
       */
      const imagesHtml = imageDataUrls
        .map(
          (url) =>
            `<p><a href="${url}" target="_blank" rel="noopener noreferrer">` +
            `<img src="${url}" alt="" /></a></p>`
        )
        .join('');
      textHtml = textHtml + imagesHtml;
    }

    return textHtml;
  }

  /**
   * Vrai si le commentaire HTML actuel n'a pas de texte significatif. Utile
   * parce que Quill renvoie `<p><br></p>` pour un éditeur vide.
   */
  isInsertCommentEmpty(): boolean {
    const html = this.insertCommentText ?? '';
    if (html.length === 0) {
      return true;
    }
    const text = html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .trim();
    return text.length === 0;
  }

  /** Indique si le bouton « Ajouter ici » est actionnable pour l'évènement courant. */
  canSubmitInsertForEvent(ev: Evenement): boolean {
    if (this.insertImageUploadingEventId != null) {
      return false;
    }
    if (this.insertMode === 'comment') {
      return !this.isInsertCommentEmpty();
    }
    return ev?.id != null;
  }

  /** Supprime les `![…](data:image/…)` Markdown et `<img src="data:…">` du texte. */
  private stripGeneratedImagesFromContent(content: string): string {
    if (!content) {
      return '';
    }
    let out = content.replace(
      /!\[[^\]]*\]\(data:image\/[a-zA-Z0-9.+-]+;base64,[^)\s]+\)/g,
      ''
    );
    out = out.replace(
      /<img[^>]*\ssrc=["']data:image\/[a-zA-Z0-9.+-]+;base64,[^"']+["'][^>]*\/?>(\s*<\/img>)?/gi,
      ''
    );
    return out.replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * Appel SSE — récupère tous les évènements visibles par l'utilisateur courant.
   * On accumule les évènements au fil de l'eau et on remet la liste triée par date.
   *
   * NB : le backend monte la route `/api/even/stream/{evenementName}` avec le
   * nom comme path variable obligatoire ; un nom vide produit `…/stream/` →
   * 404 (segment vide non matché). Le composant home utilise `"*"` comme
   * convention « tout afficher » — on suit la même règle.
   */
  private streamEventsForInsertImage(): void {
    this.insertImageEventsStreamSub?.unsubscribe();
    const user = this.membersService.getUser();
    const userId = user?.id ?? '';

    this.insertImageEventsStreamSub = this.evenementsService
      .streamEvents('*', userId)
      .subscribe({
        next: (s: StreamedEvent) => {
          this.ngZone.run(() => {
            if (s.type === 'event' && s.data && typeof s.data === 'object' && 'id' in s.data) {
              const incoming = s.data as Evenement;
              const existsIdx = this.insertImageEventsList.findIndex((e) => e.id === incoming.id);
              if (existsIdx === -1) {
                this.insertImageEventsList = [...this.insertImageEventsList, incoming];
              }
              this.cdr.markForCheck();
            } else if (s.type === 'complete') {
              this.insertImageEventsLoading = false;
              this.cdr.markForCheck();
            }
          });
        },
        error: () => {
          this.ngZone.run(() => {
            this.insertImageEventsLoading = false;
            this.insertImageEventsError = true;
            this.cdr.markForCheck();
          });
        },
        complete: () => {
          this.ngZone.run(() => {
            this.insertImageEventsLoading = false;
            this.cdr.markForCheck();
          });
        }
      });
  }

  /**
   * Liste filtrée pour le template :
   *  - filtrage par nom (texte, insensible à la casse)
   *  - filtrage par type d'activité (`Evenement.type` exact match)
   *  - tri décroissant par date de début d'évènement (plus récent d'abord).
   */
  insertImageFilteredEvents(): Evenement[] {
    const term = (this.insertImageEventsFilter ?? '').trim().toLowerCase();
    const typeFilter = (this.insertImageEventsTypeFilter ?? '').trim();
    const list = this.insertImageEventsList;
    let out = !term
      ? list
      : list.filter((e) => (e.evenementName ?? '').toLowerCase().includes(term));
    if (typeFilter) {
      out = out.filter((e) => (e.type ?? '') === typeFilter);
    }
    out = [...out].sort((a, b) => {
      const dA = a?.beginEventDate ? new Date(a.beginEventDate).getTime() : 0;
      const dB = b?.beginEventDate ? new Date(b.beginEventDate).getTime() : 0;
      return dB - dA;
    });
    return out;
  }

  /**
   * Renvoie la clé i18n associée à un type d'évènement (ID numérique en string).
   * Si l'ID n'est pas connu, le brut est renvoyé tel quel pour rester debug-friendly.
   */
  insertImageEventTypeLabelKey(typeId: string | undefined | null): string {
    const id = (typeId ?? '').trim();
    if (!id) {
      return '';
    }
    const found = this.insertImageEventTypeOptions.find((o) => o.value === id);
    return found ? found.labelKey : id;
  }

  insertImageEventDateLabel(ev: Evenement): string {
    const d = ev?.beginEventDate ? new Date(ev.beginEventDate) : null;
    if (!d || isNaN(d.getTime())) {
      return '';
    }
    try {
      return d.toLocaleDateString();
    } catch {
      return d.toISOString().slice(0, 10);
    }
  }

  /**
   * Dispatcher : selon {@link insertMode}, upload un fichier image (mode 'image')
   * OU POST un commentaire texte (mode 'comment') sur l'évènement choisi.
   */
  async onSelectEventForInsert(ev: Evenement): Promise<void> {
    if (!ev || !ev.id) {
      return;
    }
    if (this.insertImageUploadingEventId != null) {
      return;
    }
    if (this.insertMode === 'image') {
      await this.runImageInsert(ev);
    } else if (this.insertMode === 'comment') {
      this.runCommentInsert(ev);
    }
  }

  /** Upload de l'image générée (mode 'image'). */
  private async runImageInsert(ev: Evenement): Promise<void> {
    const dataUrl = this.insertImageDataUrl;
    if (!dataUrl) {
      return;
    }
    const user = this.membersService.getUser();
    if (!user || !user.id) {
      this.setInsertImageFeedback('error', 'ASSISTANT.INSERT_IMG_IN_EVENT_NO_USER');
      return;
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = await this.dataUrlToFile(dataUrl, `pat-assistant-generated-${ts}`);
    if (!file) {
      this.setInsertImageFeedback('error', 'ASSISTANT.INSERT_IMG_IN_EVENT_FILE_ERROR');
      return;
    }

    /**
     * Au-delà du seuil "~300KB", on demande à l'utilisateur s'il veut
     * compresser l'image (même UX que `update-evenement`). En dessous,
     * on envoie tel quel (allowOriginal=true) sans pop-up.
     */
    let allowOriginal = true;
    if (file.size > AssistantDrawerComponent.INSERT_IMAGE_COMPRESSION_THRESHOLD_BYTES) {
      const choice = await this.askForInsertImageCompression(file.size);
      if (choice == null) {
        // Modal fermé/annulé : on annule l'insertion silencieusement.
        return;
      }
      // choice === true → compresser ; allowOriginal est l'inverse.
      allowOriginal = !choice;
    }

    const formData = new FormData();
    formData.append('file', file, file.name);
    formData.append('allowOriginal', allowOriginal ? 'true' : 'false');

    const uploadUrl = `${environment.API_URL4FILE}/${user.id}/${ev.id}`;

    this.insertImageUploadingEventId = ev.id;
    this.insertImageFeedbackKey = null;
    this.insertImageFeedbackKind = null;
    this.cdr.markForCheck();

    this.insertImageUploadSub?.unsubscribe();
    this.insertImageUploadSub = this.fileService
      .postFileToUrl(formData, user, uploadUrl)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.ngZone.run(() => {
            this.insertImageUploadingEventId = null;
            this.cdr.markForCheck();
          });
        })
      )
      .subscribe({
        next: () => {
          this.ngZone.run(() => {
            this.setInsertImageFeedback(
              'success',
              'ASSISTANT.INSERT_IMG_IN_EVENT_SUCCESS',
              { name: ev.evenementName ?? '' }
            );
            this.scheduleInsertModalAutoClose();
          });
        },
        error: () => {
          this.ngZone.run(() => {
            this.setInsertImageFeedback('error', 'ASSISTANT.INSERT_IMG_IN_EVENT_UPLOAD_ERROR');
          });
        }
      });
  }

  /** POST commentaire texte (mode 'comment'). */
  private runCommentInsert(ev: Evenement): void {
    const text = (this.insertCommentText ?? '').trim();
    if (text.length === 0) {
      this.setInsertImageFeedback('error', 'ASSISTANT.INSERT_CMT_IN_EVENT_EMPTY_ERROR');
      return;
    }
    const user = this.membersService.getUser();
    if (!user || !user.id) {
      this.setInsertImageFeedback('error', 'ASSISTANT.INSERT_IMG_IN_EVENT_NO_USER');
      return;
    }

    /**
     * Le backend écrase `commentOwner` et `dateCreation` côté serveur (sécurité),
     * donc on envoie une valeur cosmétique localement — la véritable source d'autorité
     * reste l'utilisateur Keycloak côté Spring.
     */
    const ownerLabel =
      this.chatUserLabel()
      || `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()
      || user.userName
      || user.id
      || '';
    const commentary = new Commentary(ownerLabel, text, new Date());

    this.insertImageUploadingEventId = ev.id;
    this.insertImageFeedbackKey = null;
    this.insertImageFeedbackKind = null;
    this.cdr.markForCheck();

    this.insertImageUploadSub?.unsubscribe();
    this.insertImageUploadSub = this.evenementsService
      .addCommentary(ev.id, commentary)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.ngZone.run(() => {
            this.insertImageUploadingEventId = null;
            this.cdr.markForCheck();
          });
        })
      )
      .subscribe({
        next: () => {
          this.ngZone.run(() => {
            this.setInsertImageFeedback(
              'success',
              'ASSISTANT.INSERT_CMT_IN_EVENT_SUCCESS',
              { name: ev.evenementName ?? '' }
            );
            this.scheduleInsertModalAutoClose();
          });
        },
        error: () => {
          this.ngZone.run(() => {
            this.setInsertImageFeedback('error', 'ASSISTANT.INSERT_CMT_IN_EVENT_POST_ERROR');
          });
        }
      });
  }

  /**
   * Ouvre le modal "Compresser l'image ?" lorsque l'image générée à insérer
   * dépasse le seuil. Réutilise les libellés `EVENTELEM.IMAGE_COMPRESSION_*`
   * déjà traduits pour le formulaire d'évènement, afin de ne pas dupliquer
   * de chaînes.
   *
   * Retourne :
   *  - `true`  → l'utilisateur souhaite compresser (allowOriginal=false)
   *  - `false` → l'utilisateur veut envoyer en taille originale
   *  - `null`  → modal fermé/annulé : appelant doit interrompre l'envoi
   */
  private askForInsertImageCompression(fileSizeBytes: number): Promise<boolean | null> {
    return new Promise((resolve) => {
      this.compressInsertImage = true; // valeur par défaut : compression activée
      this.insertImageSizeKb = Math.max(1, Math.round(fileSizeBytes / 1024));

      if (!this.imageCompressionModal) {
        // Repli si pour une raison quelconque le template n'est pas dispo.
        const ok = window.confirm(
          this.translate.instant('EVENTELEM.IMAGE_COMPRESSION_QUESTION', { count: 1 })
        );
        resolve(ok);
        return;
      }

      this.imageCompressionModalRef = this.modalService.open(this.imageCompressionModal, {
        centered: true,
        backdrop: 'static',
        keyboard: false,
        size: 'md',
        windowClass: 'compression-quality-modal'
      });

      this.imageCompressionModalRef.result.then(
        (result: boolean) => {
          this.imageCompressionModalRef = null;
          resolve(result);
        },
        () => {
          this.imageCompressionModalRef = null;
          resolve(null);
        }
      );
    });
  }

  /** Confirme le choix de compression (lié au bouton "Confirmer" du modal). */
  confirmInsertImageCompression(): void {
    if (this.imageCompressionModalRef) {
      this.imageCompressionModalRef.close(this.compressInsertImage);
    }
  }

  /** Annule le modal de compression (croix / bouton "Annuler"). */
  cancelInsertImageCompression(): void {
    if (this.imageCompressionModalRef) {
      this.imageCompressionModalRef.dismiss();
    }
  }

  private scheduleInsertModalAutoClose(): void {
    if (this.insertImageFeedbackTimer !== undefined) {
      clearTimeout(this.insertImageFeedbackTimer);
    }
    this.insertImageFeedbackTimer = setTimeout(() => {
      this.cancelInsertImageInEventModal();
    }, AssistantDrawerComponent.INSERT_IMAGE_FEEDBACK_AUTO_CLOSE_MS);
  }

  private setInsertImageFeedback(
    kind: 'success' | 'error',
    key: string,
    params: { name?: string } = {}
  ): void {
    this.insertImageFeedbackKind = kind;
    this.insertImageFeedbackKey = key;
    this.insertImageFeedbackParams = params;
    this.cdr.markForCheck();
  }

  cancelInsertImageInEventModal(): void {
    if (this.insertImageFeedbackTimer !== undefined) {
      clearTimeout(this.insertImageFeedbackTimer);
      this.insertImageFeedbackTimer = undefined;
    }
    if (this.insertImageModalRef) {
      try {
        this.insertImageModalRef.close();
      } catch {
        /* ignore */
      }
      this.insertImageModalRef = null;
    }
  }

  private onInsertImageModalClosed(): void {
    this.insertImageEventsStreamSub?.unsubscribe();
    this.insertImageUploadSub?.unsubscribe();
    if (this.insertImageFeedbackTimer !== undefined) {
      clearTimeout(this.insertImageFeedbackTimer);
      this.insertImageFeedbackTimer = undefined;
    }
    this.insertMode = null;
    this.insertImageDataUrl = null;
    this.insertCommentText = '';
    this.insertImageEventsList = [];
    this.insertImageEventsFilter = '';
    this.insertImageEventsTypeFilter = '';
    this.insertImageEventsLoading = false;
    this.insertImageEventsError = false;
    this.insertImageUploadingEventId = null;
    this.insertImageFeedbackKey = null;
    this.insertImageFeedbackParams = {};
    this.insertImageFeedbackKind = null;
    this.insertImageModalRef = null;
    this.cdr.markForCheck();
  }

  whatsappPreviewSrc(): SafeUrl {
    const u = this.firstUserImageDataUrlInThread();
    if (u && u.trim()) {
      return this.sanitizer.bypassSecurityTrustUrl(u.trim());
    }
    return this.sanitizer.bypassSecurityTrustUrl('assets/images/pat.png');
  }

  private firstUserImageDataUrlInThread(): string | null {
    for (const m of this.messages) {
      if (m.role === 'user' && m.imageDataUrl && m.imageDataUrl.trim()) {
        return m.imageDataUrl.trim();
      }
    }
    return null;
  }

  openWhatsAppShareModal(): void {
    if (!this.canShareAssistantWhatsApp()) {
      return;
    }
    this.whatsappShareMessage = '';
    this.whatsappShareModalRef = this.modalService.open(this.assistantWhatsappShareModal, {
      size: 'lg',
      centered: true,
      windowClass: 'whatsapp-share-modal',
      modalDialogClass: 'whatsapp-share-modal-dialog'
    });
    this.cdr.markForCheck();
  }

  /**
   * Convertit un sous-ensemble Markdown (réponses modèle) vers le formatage texte WhatsApp :
   * *gras*, titres, ~~barré~~, liens, blocs ``` inchangés.
   */
  private formatMarkdownForWhatsApp(md: string): string {
    if (md == null || md === '') {
      return '';
    }
    const parts = md.split(/(```[\s\S]*?```)/g);
    return parts
      .map((part) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          return part;
        }
        return this.formatMarkdownForWhatsAppSegment(part);
      })
      .join('');
  }

  private formatMarkdownForWhatsAppSegment(s: string): string {
    let t = s.replace(/\r\n/g, '\n');
    t = t.replace(/~~([^~]+)~~/g, '~$1~');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1\n$2');
    t = t.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
    t = t.replace(/\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, '*$1*');
    t = t.replace(/__([^_]+)__/g, '*$1*');
    // Puces Markdown "* " en début de ligne → "- " (évite qu'un * orphelin active le gras WhatsApp)
    t = t.replace(/^\* /gm, '- ');
    return t;
  }

  /**
   * Corps du message de partage : tout l’historique visible (questions + réponses).
   * Les images sont envoyées en pièces jointes via {@link confirmAssistantWhatsAppShare} en parallèle.
   */
  private suggestWhatsAppShareBodyRaw(): string {
    return this.buildAssistantTranscriptPlain();
  }

  private buildAssistantTranscriptPlain(): string {
    const you = this.translate.instant('ASSISTANT.YOU');
    const ai = this.translate.instant('ASSISTANT.AI');
    const imageNote = this.translate.instant('ASSISTANT.IMAGE_SENT_NOTE');
    const photoInShare = this.translate.instant('ASSISTANT.TRANSCRIPT_PHOTO_LINE');
    const chunks: string[] = [];
    for (const m of this.messages) {
      const label = m.role === 'user' ? you : ai;
      let body = typeof m.content === 'string' ? m.content.trim() : '';
      if (m.role === 'user' && m.hasImage && !m.imageDataUrl) {
        body = body ? `${body}\n${imageNote}` : imageNote;
      } else if (m.role === 'user' && m.imageDataUrl?.trim()) {
        const line = photoInShare.trim();
        if (line.length > 0) {
          body = body ? `${body}\n${line}` : line;
        }
      }
      chunks.push(`*${label}*\n${body || '—'}`);
    }
    return chunks.join('\n\n');
  }

  /**
   * Aperçu : complément facultatif (champ), puis transcription du chat (identique au corps envoyé au partage).
   */
  whatsappSharePreviewHtml(): SafeHtml {
    const addonRaw = (this.whatsappShareMessage ?? '').trim();
    const addonWa = addonRaw.length > 0 ? this.formatMarkdownForWhatsApp(addonRaw).trim() : '';

    const chatWa = this.formatMarkdownForWhatsApp(this.suggestWhatsAppShareBodyRaw()).trim();

    const label = (k: string): string =>
      this.escapeHtmlForWaPreview(this.translate.instant(k));

    const chunks: string[] = ['<div class="whatsapp-share-preview-stack">'];

    if (addonWa.length > 0) {
      chunks.push(
        `<div class="whatsapp-share-preview-heading">${label('ASSISTANT.SHARE_WHATSAPP_PREVIEW_ADDON_LABEL')}</div>`
      );
      chunks.push(this.whatsAppFormattedPlainToPreviewHtml(addonWa));
    }

    chunks.push(`<div class="whatsapp-share-preview-heading">${label('ASSISTANT.SHARE_WHATSAPP_PREVIEW_CHAT_LABEL')}</div>`);
    if (chatWa.length > 0) {
      chunks.push(this.whatsAppFormattedPlainToPreviewHtml(chatWa));
    } else {
      chunks.push(
        `<p class="whatsapp-share-preview-empty mb-0">${label('ASSISTANT.SHARE_WHATSAPP_PREVIEW_CHAT_EMPTY')}</p>`
      );
    }

    chunks.push('</div>');
    return this.sanitizer.bypassSecurityTrustHtml(chunks.join(''));
  }

  private escapeHtmlForWaPreview(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private whatsAppFormattedPlainToPreviewHtml(formattedWa: string): string {
    const parts = formattedWa.split(/(```[\s\S]*?```)/g);
    const out: string[] = [];
    for (const part of parts) {
      if (part.startsWith('```') && part.endsWith('```')) {
        const inner = part.slice(3, -3);
        out.push(
          `<pre class="whatsapp-share-preview-fence"><code>${this.escapeHtmlForWaPreview(inner)}</code></pre>`
        );
      } else {
        const block = this.whatsAppPlainSegmentToStyledHtml(part);
        if (block) {
          out.push(block);
        }
      }
    }
    return out.join('');
  }

  private whatsAppPlainSegmentToStyledHtml(s: string): string {
    if (!/\S/.test(s)) {
      return '';
    }
    let t = this.escapeHtmlForWaPreview(s);
    // Monospace ligne interne WhatsApp avec backticks (`code`)
    t = t.replace(/`([^`\n]+)`/g, '<code class="whatsapp-share-preview-inline">$1</code>');
    // *gras*, _italique_, ~barré~ (sans franchir un saut de ligne)
    t = t.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
    t = t.replace(/_([^_\n]+)_/g, '<em>$1</em>');
    t = t.replace(/~([^~\n]+)~/g, '<del>$1</del>');
    t = t.replace(/\n/g, '<br />');
    return `<div class="whatsapp-share-preview-para">${t}</div>`;
  }

  cancelAssistantWhatsAppShare(): void {
    this.whatsappShareMessage = '';
    if (this.whatsappShareModalRef) {
      this.whatsappShareModalRef.close();
      this.whatsappShareModalRef = null;
    }
  }

  /**
   * Click delegation sur la zone de contenu d'une bulle : si l'utilisateur clique
   * sur une `<img>` rendue par le markdown (typiquement une image générée par
   * l'assistant en `data:image/...` ou une image attachée par l'utilisateur),
   * on ouvre le slideshow partagé du projet (même viewer que sur les évènements)
   * avec **toutes les images du chat** ; l'image cliquée est l'image de départ.
   */
  onBubbleBodyClick(ev: MouseEvent): void {
    const target = ev.target as HTMLElement | null;
    if (!target || target.tagName !== 'IMG') {
      return;
    }
    const img = target as HTMLImageElement;
    const src = (img.getAttribute('src') ?? img.src ?? '').trim();
    if (!src) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    this.openImageInSlideshow(src);
  }

  /**
   * Collecte toutes les images du chat (générées par l'assistant + uploads
   * utilisateur) sous forme de data URLs, dans l'ordre chronologique. Sert
   * de source pour le slideshow lorsque l'utilisateur clique sur une image.
   */
  private collectAllChatImageDataUrls(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const m of this.messages) {
      if (m.role === 'assistant') {
        const urls = this.extractGeneratedImageDataUrls(m.content);
        for (const u of urls) {
          if (!seen.has(u)) {
            seen.add(u);
            out.push(u);
          }
        }
      } else if (m.role === 'user') {
        const u = (m.imageDataUrl ?? '').trim();
        if (u && !seen.has(u)) {
          seen.add(u);
          out.push(u);
        }
      }
    }
    return out;
  }

  /**
   * Convertit une data URL `data:image/...;base64,...` en `Blob` pour pouvoir
   * créer un object URL léger. Retourne null si la data URL est invalide.
   */
  private dataUrlToBlob(dataUrl: string): Blob | null {
    const parts = this.parseDataUrlBase64(dataUrl);
    if (!parts) {
      return null;
    }
    try {
      const byteString = atob(parts.base64);
      const buffer = new ArrayBuffer(byteString.length);
      const view = new Uint8Array(buffer);
      for (let i = 0; i < byteString.length; i++) {
        view[i] = byteString.charCodeAt(i);
      }
      return new Blob([buffer], { type: parts.mime });
    } catch {
      return null;
    }
  }

  /**
   * Ouvre le slideshow du projet sur l'image cliquée, avec toutes les images
   * du chat comme contexte de navigation. Les data URLs sont converties en
   * blob URLs (plus performant que data: pour le `<img>`).
   */
  private openImageInSlideshow(clickedSrc: string): void {
    if (!this.slideshowModalComponent) {
      return;
    }
    const allUrls = this.collectAllChatImageDataUrls();
    let startIndex = allUrls.indexOf(clickedSrc);
    let urls: string[];
    if (startIndex < 0) {
      urls = [clickedSrc];
      startIndex = 0;
    } else {
      urls = allUrls;
    }

    this.revokeSlideshowBlobUrls();
    const sources: SlideshowImageSource[] = urls.map((url, idx) => {
      const blob = this.dataUrlToBlob(url);
      let blobUrl: string;
      if (blob) {
        blobUrl = URL.createObjectURL(blob);
        this.slideshowBlobUrls.push(blobUrl);
      } else {
        blobUrl = url;
      }
      return {
        blobUrl,
        blob: blob ?? undefined,
        fileName: `pat-assistant-image-${idx + 1}.png`
      };
    });

    const eventName = this.translate.instant('ASSISTANT.TITLE');
    const assistantBlue = { r: 37, g: 99, b: 235 };
    this.slideshowModalComponent.open(
      sources,
      eventName,
      false,
      0,
      assistantBlue,
      Math.max(0, startIndex)
    );
    this.cdr.markForCheck();
  }

  /** Libère les object URLs (fuite mémoire sinon). */
  private revokeSlideshowBlobUrls(): void {
    for (const u of this.slideshowBlobUrls) {
      try {
        URL.revokeObjectURL(u);
      } catch {
        /* ignore */
      }
    }
    this.slideshowBlobUrls = [];
  }

  /** Hook (closed) du slideshow : on libère les blob URLs créés à l'ouverture. */
  onSlideshowClosed(): void {
    this.revokeSlideshowBlobUrls();
  }

  private truncateForWaMe(text: string): string {
    const max = AssistantDrawerComponent.WA_ME_SAFE_CHARS;
    if (text.length <= max) {
      return text;
    }
    const ell = '\n…';
    return `${text.slice(0, Math.max(0, max - ell.length))}${ell}`;
  }

  /** Comme TodolistsComponent : parsing data URL base64 pour construire des {@link File}. */
  private parseDataUrlBase64(dataUrl: string): { mime: string; base64: string } | null {
    const s = dataUrl.trim();
    const comma = s.indexOf(',');
    if (comma < 0 || !s.startsWith('data:')) {
      return null;
    }
    const header = s.slice(5, comma);
    const lower = header.toLowerCase();
    const b64Marker = ';base64';
    const idx = lower.indexOf(b64Marker);
    if (idx < 0) {
      return null;
    }
    const mime = (header.slice(0, idx).split(';')[0] || 'image/jpeg').trim() || 'image/jpeg';
    const base64 = s.slice(comma + 1).replace(/\s/g, '');
    return base64.length ? { mime, base64 } : null;
  }

  private async dataUrlToFile(dataUrl: string, fileName: string): Promise<File | null> {
    const parsed = this.parseDataUrlBase64(dataUrl);
    if (!parsed) {
      return null;
    }
    const { mime, base64 } = parsed;
    let blob: Blob | null = null;
    try {
      const resp = await fetch(dataUrl.trim());
      const b = await resp.blob();
      const t = b.type && b.type !== 'application/octet-stream' ? b.type : mime;
      blob = t === b.type ? b : new Blob([await b.arrayBuffer()], { type: t });
    } catch {
      blob = null;
    }
    if (!blob) {
      try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        blob = new Blob([bytes], { type: mime });
      } catch {
        return null;
      }
    }
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'jpg';
    const type = blob.type || mime;
    try {
      return new File([blob], `${fileName}.${ext}`, { type });
    } catch {
      return null;
    }
  }

  /** Web Share ({@code text} ± {@code files}) puis repli {@code wa.me}, comme mur + slideshow. */
  async confirmAssistantWhatsAppShare(): Promise<void> {
    const title = this.translate.instant('ASSISTANT.TITLE');

    const addonRaw = (this.whatsappShareMessage ?? '').trim();
    const addon =
      addonRaw.length > 0 ? this.formatMarkdownForWhatsApp(addonRaw).trim() : '';

    const recapFormatted = this.formatMarkdownForWhatsApp(
      this.suggestWhatsAppShareBodyRaw()
    ).trim();

    let message = `*${title}*`;
    if (addon.length > 0) {
      message += `\n\n${addon}`;
    }
    if (recapFormatted.length > 0) {
      const recapTitleEsc = this.translate.instant('ASSISTANT.SHARE_WHATSAPP_RECAP_MESSAGE_TITLE_LINE');
      // Ligne titre lisible avant le corps (sans ** Markdown : gras WhatsApp direct)
      message += `\n\n*${recapTitleEsc}*\n\n${recapFormatted}`;
    }

    const imageFiles: File[] = [];
    let imgIdx = 0;
    for (const m of this.messages) {
      if (m.role === 'user' && m.imageDataUrl?.trim()) {
        const file = await this.dataUrlToFile(m.imageDataUrl.trim(), `pat-assistant-photo-${imgIdx}`);
        imgIdx++;
        if (file) {
          imageFiles.push(file);
        }
      }
    }

    const nav = navigator as Navigator & {
      share?: (data: ShareData) => Promise<void>;
      canShare?: (data: ShareData) => boolean;
    };

    const aborted = (e: unknown): boolean =>
      e != null && typeof e === 'object' && 'name' in e && String((e as { name?: string }).name) === 'AbortError';

    if (typeof nav.share === 'function') {
      if (imageFiles.length > 0) {
        const withFiles: ShareData = { title, text: message, files: imageFiles };
        try {
          await nav.share(withFiles);
          this.cancelAssistantWhatsAppShare();
          return;
        } catch (err: unknown) {
          if (aborted(err)) {
            return;
          }
        }
      }
      try {
        await nav.share({ title, text: message });
        this.cancelAssistantWhatsAppShare();
        return;
      } catch (err: unknown) {
        if (aborted(err)) {
          return;
        }
      }
    }

    const waText = this.truncateForWaMe(message);
    if (this.whatsappShareModalRef) {
      this.whatsappShareModalRef.close();
      this.whatsappShareModalRef = null;
    }
    this.whatsappShareMessage = '';
    window.open(`https://wa.me/?text=${encodeURIComponent(waText)}`, '_blank');
    this.cdr.markForCheck();
  }
}

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
import {
  combineLatest,
  defer,
  EMPTY,
  filter,
  firstValueFrom,
  forkJoin,
  from,
  Observable,
  of,
  Subject,
  Subscription,
  throwError
} from 'rxjs';
import {
  catchError,
  debounceTime,
  exhaustMap,
  finalize,
  map,
  switchMap,
  take,
  tap
} from 'rxjs/operators';
import { KeycloakService } from '../../keycloak/keycloak.service';
import {
  AssistantAttachedImageRequest,
  AssistantChatMeta,
  AssistantChatTurn,
  AssistantClientConfig,
  AssistantConversationDetail,
  AssistantConversationSaveBody,
  AssistantConversationSummary,
  AssistantConversationTurnPersist,
  AssistantPdfExportRequest,
  AssistantPdfExportTurn,
  AssistantRoutingStored,
  AssistantService,
  AssistantToolFlagsRequest,
  parseElapsedMsFromAssistantResponse
} from '../../services/assistant.service';
import { AssistantSessionStore } from '../../services/assistant-session.store';
import {
  AssistantLaunchService,
  ASSISTANT_VISION_IMAGE_LAUNCH_ROUTING,
  type AssistantLaunchRouting
} from '../../services/assistant-launch.service';
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
import { UploadConfigService } from '../../services/upload-config.service';
import { MembersService } from '../../services/members.service';
import { Evenement } from '../../model/evenement';
import { Commentary } from '../../model/commentary';
import { environment } from '../../../environments/environment';
import {
  ASSISTANT_ANTHROPIC_MODEL_PRESETS,
  ASSISTANT_GEMINI_MODEL_PRESETS,
  ASSISTANT_OPENAI_MODEL_PRESETS
} from './assistant-model-presets';
import { ASSISTANT_MODEL_RANKING_ROWS } from './assistant-model-ranking-table';

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
  @ViewChild('assistantWhatsappShareModal') assistantWhatsappShareModal!: TemplateRef<unknown>;
  @ViewChild('assistantInsertImageInEventModal') assistantInsertImageInEventModal!: TemplateRef<unknown>;
  /**
   * Modal de choix de compression d'image (réutilise les clés i18n
   * `EVENTELEM.IMAGE_COMPRESSION_*` déjà utilisées dans `update-evenement`).
   * Affiché uniquement lorsque l'image insérée dans un évènement dépasse
   * {@link AssistantDrawerComponent.INSERT_IMAGE_COMPRESSION_THRESHOLD_BYTES}.
   */
  @ViewChild('imageCompressionModal') imageCompressionModal!: TemplateRef<unknown>;
  @ViewChild('assistantToolsHelpModal') assistantToolsHelpModal!: TemplateRef<unknown>;
  @ViewChild('assistantDraftExpandModal') assistantDraftExpandModal!: TemplateRef<unknown>;
  @ViewChild('draftExpandTextarea') draftExpandTextareaModalEl?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('assistantHistoryModal') assistantHistoryModal!: TemplateRef<unknown>;
  /** Référence à l'instance du slideshow partagé (même viewer que pour les évènements). */
  @ViewChild('slideshowModalComponent') slideshowModalComponent?: SlideshowModalComponent;

  /**
   * Object URLs créés à partir des data: URLs des images générées, pour
   * alimenter le slideshow de façon performante (un blob URL est plus léger
   * qu'une data URL en base64). Ils sont libérés à la fermeture du slideshow
   * et au destroy du composant pour éviter les fuites mémoire.
   */
  private slideshowBlobUrls: string[] = [];

  /** Object URLs créés pour ré-afficher les images générées chargées depuis l’historique (assets serveur). */
  private assistantHydratedBlobUrls: string[] = [];

  /** Modal partage WhatsApp (même principe que mur de photos). */
  whatsappShareMessage = '';
  /** Contenu du récap : tout le fil utilisateur + assistant, ou uniquement les réponses de l’assistant. */
  whatsappShareTranscriptMode: 'full' | 'assistant_only' = 'full';
  private whatsappShareModalRef: NgbModalRef | null = null;

  /** Modal « Insérer dans un évènement » (image générée OU commentaire texte). */
  private insertImageModalRef: NgbModalRef | null = null;
  /** Mode actif du modal : insertion d'image générée vs ajout de commentaire texte. */
  insertMode: 'image' | 'comment' | null = null;
  /** Data URL retenue pour l'insertion d'image (mode 'image'). */
  private insertImageDataUrl: string | null = null;
  /** Object URL créée depuis un asset serveur seul ; révoquée à la fermeture du modal. */
  private insertImagePickObjectUrl: string | null = null;
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
   * État du modal de compression image. `compressInsertImage` est lié au
   * switch dans le template et reflète le choix utilisateur (true =
   * compresser). `insertImageCompressionMode` détermine le rendu :
   *  - 'normal'   : modal classique avec switch (image > seuil
   *                 `app.imagemaxsizekb` côté backend).
   *  - 'allUnder' : image déjà ≤ au seuil → message info-only, pas de
   *                 switch ; envoi en `allowOriginal=true` à la
   *                 confirmation.
   */
  compressInsertImage = true;
  insertImageCompressionMode: 'normal' | 'allUnder' = 'normal';
  /** Taille (en KB, arrondie) affichée dans le modal pour informer l'utilisateur. */
  insertImageSizeKb = 0;
  /** Seuil (KB) lu sur le backend ; affiché dans le message info-only. */
  insertImageMaxSizeKb = 0;
  private imageCompressionModalRef: NgbModalRef | null = null;
  /** Modale aide « outils × fournisseurs » (toggle plein écran). */
  private toolsHelpModalRef: NgbModalRef | null = null;
  assistantToolsHelpFullscreen = false;

  /** Juste sous la bande bleue `.pat-title` (ou minimum sous navbar + tickers). */
  fabTopPx = 72;

  isOpen = false;
  fullscreen = false;
  draft = '';
  /** Nombre de lignes visuelles (retours automatiques inclus) pour la gouttière de la modale « Rédiger ». */
  draftExpandVisualLineCount = 0;
  /** True tant que la modale d’édition du brouillon est ouverte (recalcul gouttière au resize fenêtre). */
  private draftExpandModalOpen = false;
  /** Div hors écran pour mesurer la hauteur du texte avec le même wrapping que le textarea. */
  private draftExpandMeasureDiv: HTMLDivElement | null = null;
  private draftExpandGutterResizeRaf: number | null = null;
  /** Pied de modale « Rédiger » : recherche dans le brouillon. */
  draftExpandSearchPattern = '';
  draftExpandSearchAsRegex = false;
  draftExpandSearchIgnoreCase = true;
  draftExpandSearchMatchCount = 0;
  draftExpandSearchInvalid = false;
  /** Index dans {@link draftExpandSearchMatches}; -1 = aucune occurrence sélectionnée. */
  draftExpandSearchActiveIdx = -1;
  draftExpandSearchMatches: Array<{ start: number; end: number }> = [];
  loading = false;
  /** Temps écoulé pendant l’attente de réponse (rafraîchi pendant {@link loading}). */
  loadingElapsedMs = 0;
  private loadingElapsedIntervalId: ReturnType<typeof setInterval> | null = null;
  private loadingElapsedStartMs = 0;
  /** true pendant la génération PDF (appel serveur). */
  pdfExporting = false;
  /** Conversation Mongo en cours ; null après « nouvelle discussion » ou chargement sans suite. */
  persistedRemoteConversationId: string | null = null;
  historyPersistErrorKey: string | null = null;
  private readonly remotePersistTrigger = new Subject<void>();
  historyLoading = false;
  historyDetailLoading = false;
  historyItems: AssistantConversationSummary[] = [];
  /** Copie question en cours : id conversation (GET détail pour texte complet). */
  assistantHistoryCopyingId: string | null = null;
  /** Filtre plein texte dans la liste de l’historique (modal). */
  historyConversationFilter = '';
  historyErrorKey: string | null = null;
  private historyListSub?: Subscription;
  private assistantHistoryModalRef: NgbModalRef | null = null;
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
  /** Conversion HEIC ou lecture fichier après caméra / galerie. */
  imageAttachProcessing = false;

  private static readonly IMAGE_MAX_BYTES = 8 * 1024 * 1024;
  private static readonly IMAGE_ACCEPT_RE = /^image\/(jpe?g|png|gif|webp)$/i;
  private static readonly JPEG_MIME_ALIASES = new Set([
    'image/jpg',
    'image/pjpeg',
    'image/x-jpeg',
    'image/x-citrix-jpeg'
  ]);

  /**
   * MIME cohérent avec le backend (vision) — sur mobile {@link File.type} est souvent vide :
   * on se rabat sur l’extension ; HEIC/HEIF déclenchera une conversion JPEG côté client.
   */
  private static normalizePickMime(file: File): string {
    let base = (file.type || '').trim().split(';')[0].trim().toLowerCase();
    if (AssistantDrawerComponent.JPEG_MIME_ALIASES.has(base) || base === 'image/jpg') {
      return 'image/jpeg';
    }
    if (base === 'image/heic' || base === 'image/heif') {
      return base;
    }
    const ext = (file.name.toLowerCase().split('.').pop() || '').trim();
    if (base.startsWith('image/') && AssistantDrawerComponent.IMAGE_ACCEPT_RE.test(base)) {
      return base;
    }
    if (ext === 'png') {
      return 'image/png';
    }
    if (ext === 'gif') {
      return 'image/gif';
    }
    if (ext === 'webp') {
      return 'image/webp';
    }
    if (ext === 'jpg' || ext === 'jpeg' || ext === 'jpe') {
      return 'image/jpeg';
    }
    if (ext === 'heic' || ext === 'heif' || ext === 'heics') {
      return 'image/heic';
    }
    if (base.startsWith('image/')) {
      return base;
    }
    return '';
  }
  /** Réponse (ou erreur) reçue alors que le panneau était fermé — pastille sur le FAB jusqu’à réouverture. */
  fabUnreadReply = false;
  private shouldAlignLastQuestionTop = false;
  private shouldAlignLastAssistantTop = false;

  /** Dernier pixel de la navbar PatTool (~ --navbar-height). */
  private static readonly NAV_BOTTOM_PX = 60;
  private static readonly FAB_GAP_PX = 12;
  /** Espace entre le bas de `.pat-title` et le centre vertical du bouton. */
  private static readonly FAB_UNDER_TITLE_GAP_PX = 10;

  private tickerLayoutSub?: Subscription;
  private routerSub?: Subscription;
  private assistantLaunchSub?: Subscription;
  /** Une seule requête config à la fois ; HTTP annulé si le composant est détruit. */
  private assistantConfigSub?: Subscription;
  private assistantConfigLoading = false;
  /** Annulation requête chat en cours (ex. navigation pendant l’appel). */
  private chatSendSub?: Subscription;
  private fabAnchorRaf = 0;
  private draftPersistTimer?: ReturnType<typeof setTimeout>;
  /** Sauvegarde distante (Mongo) du fournisseur / modèle — debounced */
  private routingRemotePersistTimer?: ReturnType<typeof setTimeout>;
  private static readonly ROUTING_REMOTE_DEBOUNCE_MS = 500;
  private transientTimeouts: Array<ReturnType<typeof setTimeout>> = [];
  private readonly boundScheduleFabAnchor = (): void => this.scheduleFabAnchorUpdate();

  /** Markdown assistant : évite de repasser marked/sanitize à chaque cycle de détection Angular. */
  private readonly assistantBubbleHtmlCache = new WeakMap<
    AssistantChatTurn,
    SafeHtml
  >();

  /** Valeurs si le backend ne renvoie pas encore d’URL (alignées sur les défauts Java). */
  private static readonly DEFAULT_BILLING_OPENAI_BILLING =
    'https://platform.openai.com/settings/organization/billing';
  private static readonly DEFAULT_BILLING_OPENAI_USAGE = 'https://platform.openai.com/usage';
  private static readonly DEFAULT_BILLING_ANTHROPIC = 'https://console.anthropic.com/settings/plans';
  private static readonly DEFAULT_BILLING_GEMINI_RATE =
    'https://aistudio.google.com/rate-limit?timeRange=last-28-days&hl=fr&project=gen-lang-client-0509711942';
  private static readonly DEFAULT_BILLING_GEMINI_KEYS = 'https://aistudio.google.com/app/apikey';

  readonly MODEL_PRESET_CUSTOM = '__custom__';

  /** Fournisseur effectif pour les requêtes (surcharge application.properties). */
  routingProvider: 'openai' | 'anthropic' | 'gemini' = 'openai';
  /** Id de modèle parmi {@link routingModelOptions} ou {@link MODEL_PRESET_CUSTOM}. */
  modelPreset = 'gpt-4o';
  /** Saisie libre si {@link modelPreset} === {@link MODEL_PRESET_CUSTOM}. */
  modelCustom = '';
  routingModelOptions: string[] = [...ASSISTANT_OPENAI_MODEL_PRESETS];

  /** Complets / à jour : renseigné par GET /api/assistant/models pour le {@link routingProvider} courant. */
  private remoteCatalogModelIds: string[] = [];

  /** Catalogue modèle / tâche pour la modale d’aide « ℹ︎ » à côté de MCP. */
  readonly assistantModelRankingRows = ASSISTANT_MODEL_RANKING_ROWS;

  /** Modèle du fournisseur par défaut serveur (legacy, = celui de {@code routingDefault}). */
  serverDefaultModel = '';
  /** Modèle configuré côté serveur pour chaque fournisseur (GET /assistant/config). */
  serverOpenaiDefault = '';
  serverAnthropicDefault = '';
  serverGeminiDefault = '';
  /** {@code gemini.image-generation-model} renvoyé par GET /assistant/config. */
  serverGeminiImageGenerationModel = '';
  /** URLs du bandeau facturation (GET /assistant/config, assistant.billing.*). */
  billingOpenaiBillingUrl = '';
  billingOpenaiUsageUrl = '';
  billingAnthropicUrl = '';
  billingGeminiRateLimitUrl = '';
  billingGeminiApiKeysUrl = '';
  /** Valeur de assistant.provider côté serveur. */
  serverRoutingDefault: 'openai' | 'anthropic' | 'gemini' = 'openai';
  /**
   * Routing préservé depuis sessionStorage, appliqué seulement après GET /assistant/config
   * si aucune préférence Mongo (priorité : Mongo → session onglet → application.properties).
   */
  private pendingSessionRouting?: AssistantRoutingStored;
  /** True si le routing vient de Mongo ou de la session onglet (pas des seuls défauts serveur). */
  private routingRestoredFromSession = false;
  /**
   * True si l’utilisateur a changé le fournisseur dans la liste, ou si une conversation chargée impose
   * le fournisseur — évite qu’un GET /assistant/config tardif réécrase le choix (ex. Gemini) par le défaut
   * serveur.
   */
  private routingProviderLockedAgainstConfigDefault = false;

  private assistantClientConfigLoaded = false;

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
    private uploadConfigService: UploadConfigService,
    private membersService: MembersService,
    private hostRef: ElementRef<HTMLElement>
  ) {
    // Pré-charge `app.imagemaxsizekb` dès l'instanciation du drawer pour
    // que le modal de compression puisse adapter son rendu (info-only ou
    // switch) dès la première insertion d'image dans un évènement.
    this.uploadConfigService.preload();

    this.remotePersistTrigger
      .pipe(
        debounceTime(900),
        exhaustMap(() => this.persistRemoteConversationOnce()),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe();
  }

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
        const r = saved.routing;
        if (
          r &&
          (r.provider === 'openai' ||
            r.provider === 'anthropic' ||
            r.provider === 'gemini') &&
          typeof r.modelPreset === 'string'
        ) {
          this.pendingSessionRouting = {
            provider: r.provider,
            modelPreset: r.modelPreset,
            modelCustom: typeof r.modelCustom === 'string' ? r.modelCustom : ''
          };
        }
        if (saved.fabUnread === true) {
          this.fabUnreadReply = true;
        }
      }
      this.rebuildModelOptionsList();
      this.loadAssistantClientConfig();
    }

    this.assistantLaunchSub = this.assistantLaunch.launches$.subscribe((p) => {
      if (!this.isAuthenticated()) {
        return;
      }
      const draftTrim = p.draft?.trim() ?? '';
      const hasImage = !!p.attachedImage;
      if (!draftTrim && !hasImage) {
        return;
      }
      if (p.newConversation) {
        this.chatSendSub?.unsubscribe();
        this.stopLoadingElapsedTimer();
        this.loading = false;
        this.messages = [];
        this.persistedRemoteConversationId = null;
      }
      if (hasImage && p.attachedImage) {
        this.pendingImage = {
          mimeType: p.attachedImage.mimeType,
          base64: p.attachedImage.base64,
          dataUrl: p.attachedImage.dataUrl
        };
        this.imageAttachError = null;
      }
      this.draft = draftTrim;
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
      if (p.routing) {
        this.applyAssistantLaunchRouting(p.routing);
      } else if (hasImage) {
        this.applyAssistantLaunchRouting(ASSISTANT_VISION_IMAGE_LAUNCH_ROUTING);
      }
      if (hasImage) {
        this.toolWebSearch = false;
        this.toolImageGeneration = false;
        this.toolMcp = false;
      }
      this.isOpen = true;
      this.fabUnreadReply = false;
      this.fullscreen = false;
      this.persistSession();
      this.scheduleFabAnchorUpdate();
      this.cdr.detectChanges();
      this.syncAppRootAriaWithAssistantOverModal();
      this.scheduleFocusComposeArea();
      queueMicrotask(() => this.requestAlignLastQuestionTop());
      if (p.autoSend === true) {
        this.tryAutoSendAfterLaunchFromPayload();
      }
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

  private startLoadingElapsedTimer(): void {
    this.stopLoadingElapsedTimer();
    this.loadingElapsedStartMs = Date.now();
    this.loadingElapsedMs = 0;
    this.loadingElapsedIntervalId = setInterval(() => {
      this.ngZone.run(() => {
        this.loadingElapsedMs = Date.now() - this.loadingElapsedStartMs;
        this.cdr.markForCheck();
      });
    }, 100);
  }

  private stopLoadingElapsedTimer(): void {
    if (this.loadingElapsedIntervalId != null) {
      clearInterval(this.loadingElapsedIntervalId);
      this.loadingElapsedIntervalId = null;
    }
  }

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
          const providerBefore = this.routingProvider;
          const m = typeof c.model === 'string' ? c.model.trim() : '';
          this.serverDefaultModel = m;
          this.serverOpenaiDefault =
            typeof c.openaiDefaultModel === 'string' ? c.openaiDefaultModel.trim() : '';
          this.serverAnthropicDefault =
            typeof c.anthropicDefaultModel === 'string' ? c.anthropicDefaultModel.trim() : '';
          this.serverGeminiDefault =
            typeof c.geminiDefaultModel === 'string' ? c.geminiDefaultModel.trim() : '';
          const gimg =
            typeof c.geminiImageGenerationModel === 'string'
              ? c.geminiImageGenerationModel.trim()
              : '';
          this.serverGeminiImageGenerationModel = gimg;
          this.billingOpenaiBillingUrl =
            typeof c.billingOpenaiBillingUrl === 'string' ? c.billingOpenaiBillingUrl.trim() : '';
          this.billingOpenaiUsageUrl =
            typeof c.billingOpenaiUsageUrl === 'string' ? c.billingOpenaiUsageUrl.trim() : '';
          this.billingAnthropicUrl =
            typeof c.billingAnthropicUrl === 'string' ? c.billingAnthropicUrl.trim() : '';
          this.billingGeminiRateLimitUrl =
            typeof c.billingGeminiRateLimitUrl === 'string' ? c.billingGeminiRateLimitUrl.trim() : '';
          this.billingGeminiApiKeysUrl =
            typeof c.billingGeminiApiKeysUrl === 'string' ? c.billingGeminiApiKeysUrl.trim() : '';
          const rd =
            typeof c.routingDefault === 'string'
              ? c.routingDefault.trim().toLowerCase()
              : '';
          this.serverRoutingDefault =
            rd === 'anthropic'
              ? 'anthropic'
              : rd === 'gemini'
                ? 'gemini'
                : 'openai';

          this.applyRoutingPreferenceResolution(c);
          this.pendingSessionRouting = undefined;

          if (
            !this.routingRestoredFromSession &&
            !this.routingProviderLockedAgainstConfigDefault
          ) {
            this.routingProvider = this.serverRoutingDefault;
          }
          if (providerBefore !== this.routingProvider) {
            this.remoteCatalogModelIds = [];
          }
          this.rebuildModelOptionsList();
          if (!this.routingRestoredFromSession) {
            this.syncModelPresetFromServer(m);
          }
          this.persistSession();
          this.assistantClientConfigLoaded = true;
          this.refreshProviderModelCatalog();
          this.cdr.markForCheck();
        },
        error: () => {
          const providerBefore = this.routingProvider;
          this.serverDefaultModel = '';
          this.serverOpenaiDefault = '';
          this.serverAnthropicDefault = '';
          this.serverGeminiDefault = '';
          this.serverGeminiImageGenerationModel = '';
          this.billingOpenaiBillingUrl = '';
          this.billingOpenaiUsageUrl = '';
          this.billingAnthropicUrl = '';
          this.billingGeminiRateLimitUrl = '';
          this.billingGeminiApiKeysUrl = '';
          this.serverRoutingDefault = 'openai';
          this.applyRoutingPreferenceResolution({});
          this.pendingSessionRouting = undefined;
          if (
            !this.routingRestoredFromSession &&
            !this.routingProviderLockedAgainstConfigDefault
          ) {
            this.routingProvider = this.serverRoutingDefault;
          }
          if (providerBefore !== this.routingProvider) {
            this.remoteCatalogModelIds = [];
          }
          this.rebuildModelOptionsList();
          if (!this.routingRestoredFromSession) {
            this.syncModelPresetFromServer('');
          }
          this.persistSession();
          this.assistantClientConfigLoaded = true;
          this.refreshProviderModelCatalog();
          this.cdr.markForCheck();
        }
      });
  }

  /**
   * Détermine fournisseur + modèle affichés : préférence Mongo ({@code persistedRouting}),
   * sinon session de l’onglet, sinon les champs seront complétés via {@code routingDefault}
   * et {@code model} (application.properties) par l’appelant.
   */
  private applyRoutingPreferenceResolution(c: AssistantClientConfig): void {
    const pr = c.persistedRouting;
    if (
      pr &&
      (pr.provider === 'openai' ||
        pr.provider === 'anthropic' ||
        pr.provider === 'gemini') &&
      typeof pr.modelPreset === 'string'
    ) {
      this.routingProvider = pr.provider;
      this.modelPreset = pr.modelPreset;
      this.modelCustom = typeof pr.modelCustom === 'string' ? pr.modelCustom : '';
      this.routingRestoredFromSession = true;
      return;
    }
    const ps = this.pendingSessionRouting;
    if (
      ps &&
      (ps.provider === 'openai' ||
        ps.provider === 'anthropic' ||
        ps.provider === 'gemini') &&
      typeof ps.modelPreset === 'string'
    ) {
      this.routingProvider = ps.provider;
      this.modelPreset = ps.modelPreset;
      this.modelCustom = typeof ps.modelCustom === 'string' ? ps.modelCustom : '';
      this.routingRestoredFromSession = true;
      return;
    }
    this.routingRestoredFromSession = false;
  }

  routingMetaSummary(): string {
    const m = this.effectiveModelForRequest().trim();
    if (!m) {
      return '';
    }
    let lab: string;
    if (this.routingProvider === 'anthropic') {
      lab = this.translate.instant('ASSISTANT.PROVIDER_ANTHROPIC_SHORT');
    } else if (this.routingProvider === 'gemini') {
      lab = this.translate.instant('ASSISTANT.PROVIDER_GEMINI_SHORT');
    } else {
      lab = this.translate.instant('ASSISTANT.PROVIDER_OPENAI_SHORT');
    }
    return `${lab} · ${m}`;
  }

  effectiveModelForRequest(): string {
    if (this.modelPreset === this.MODEL_PRESET_CUSTOM) {
      const c = this.modelCustom.trim();
      if (c) {
        return c;
      }
    } else if (this.modelPreset && this.modelPreset !== this.MODEL_PRESET_CUSTOM) {
      const x = this.modelPreset.trim();
      if (x) {
        return x;
      }
    }
    const fb = this.serverDefaultForActiveProvider().trim();
    if (fb) {
      return fb;
    }
    const defaults =
      this.routingProvider === 'openai'
        ? ASSISTANT_OPENAI_MODEL_PRESETS
        : this.routingProvider === 'gemini'
          ? ASSISTANT_GEMINI_MODEL_PRESETS
          : ASSISTANT_ANTHROPIC_MODEL_PRESETS;
    return defaults[0] ?? 'gpt-4o';
  }

  /**
   * Id non vide pour POST /assistant/chat et pour l’en-tête de persistance : évite tout fallback serveur silencieux.
   */
  private resolvedModelIdForNextChatRequest(): string {
    const m = this.effectiveModelForRequest().trim();
    if (m.length > 0) {
      return m;
    }
    return (
      this.serverDefaultForActiveProvider().trim() ||
      (this.routingProvider === 'openai'
        ? ASSISTANT_OPENAI_MODEL_PRESETS[0] ?? 'gpt-4o'
        : this.routingProvider === 'gemini'
          ? ASSISTANT_GEMINI_MODEL_PRESETS[0] ?? 'gemini-2.0-flash'
          : ASSISTANT_ANTHROPIC_MODEL_PRESETS[0] ?? 'claude-sonnet-4-6')
    );
  }

  /** Évite que le &lt;select&gt; se désynchronise quand {@link routingModelOptions} est recréé (liste catalogue API). */
  compareAssistantModelIds(a: string, b: string): boolean {
    return (a ?? '') === (b ?? '');
  }

  onAssistantRoutingProviderChange(): void {
    this.routingProviderLockedAgainstConfigDefault = true;
    if (this.routingProvider !== 'openai') {
      this.toolMcp = false;
    }
    if (this.routingProvider === 'anthropic') {
      this.toolImageGeneration = false;
    }
    this.remoteCatalogModelIds = [];
    this.rebuildModelOptionsList();
    const sm = this.serverDefaultForActiveProvider().trim();
    if (
      this.routingProvider === this.serverRoutingDefault &&
      sm &&
      this.routingModelOptions.includes(sm)
    ) {
      this.modelPreset = sm;
      this.modelCustom = '';
    } else {
      const first = this.routingModelOptions[0];
      if (first) {
        this.modelPreset = first;
        this.modelCustom = '';
      }
    }
    this.persistSession();
    this.scheduleRoutingPreferenceRemotePersist();
    this.refreshProviderModelCatalog();
    this.cdr.markForCheck();
  }

  /**
   * Forces provider + model when opening from another page (`routing` on the launch payload).
   * Does not run deferred Mongo persistence so the saved DB preference is not overwritten.
   */
  private applyAssistantLaunchRouting(r: AssistantLaunchRouting): void {
    if (
      r.provider !== 'openai' &&
      r.provider !== 'anthropic' &&
      r.provider !== 'gemini'
    ) {
      return;
    }
    this.routingProviderLockedAgainstConfigDefault = true;
    this.routingProvider = r.provider;
    if (this.routingProvider !== 'openai') {
      this.toolMcp = false;
    }
    if (this.routingProvider === 'anthropic') {
      this.toolImageGeneration = false;
    }
    const preset = typeof r.modelPreset === 'string' ? r.modelPreset.trim() : '';
    const custom = typeof r.modelCustom === 'string' ? r.modelCustom.trim() : '';
    if (preset === this.MODEL_PRESET_CUSTOM && custom.length > 0) {
      this.modelPreset = this.MODEL_PRESET_CUSTOM;
      this.modelCustom = custom;
    } else if (preset.length > 0 && preset !== this.MODEL_PRESET_CUSTOM) {
      this.modelPreset = preset;
      this.modelCustom = '';
    } else if (custom.length > 0) {
      this.modelPreset = this.MODEL_PRESET_CUSTOM;
      this.modelCustom = custom;
    }
    this.remoteCatalogModelIds = [];
    this.rebuildModelOptionsList();
    this.refreshProviderModelCatalog();
  }

  onAssistantModelPresetChange(): void {
    if (this.modelPreset !== this.MODEL_PRESET_CUSTOM) {
      this.modelCustom = '';
    }
    this.rebuildModelOptionsList();
    this.persistSession();
    this.scheduleRoutingPreferenceRemotePersist();
    this.cdr.markForCheck();
  }

  onAssistantModelCustomChange(): void {
    this.rebuildModelOptionsList();
    this.persistSession();
    this.scheduleRoutingPreferenceRemotePersist();
    this.cdr.markForCheck();
  }

  private rebuildModelOptionsList(): void {
    const basePresets: string[] =
      this.routingProvider === 'openai'
        ? [...ASSISTANT_OPENAI_MODEL_PRESETS]
        : this.routingProvider === 'gemini'
          ? [...ASSISTANT_GEMINI_MODEL_PRESETS]
          : [...ASSISTANT_ANTHROPIC_MODEL_PRESETS];
    const merged = new Set<string>();
    for (const x of basePresets) {
      merged.add(x);
    }
    const srv = this.serverDefaultForActiveProvider().trim();
    if (srv) {
      merged.add(srv);
    }
    const cur = this.modelCustom.trim();
    if (this.modelPreset === this.MODEL_PRESET_CUSTOM && cur) {
      merged.add(cur);
    } else if (this.modelPreset !== this.MODEL_PRESET_CUSTOM) {
      const presetId = (this.modelPreset ?? '').trim();
      if (presetId) {
        merged.add(presetId);
      }
    }
    for (const id of this.remoteCatalogModelIds) {
      const t = (id ?? '').trim();
      if (t) {
        merged.add(t);
      }
    }
    const ordered: string[] = [];
    for (const p of basePresets) {
      if (merged.has(p)) {
        ordered.push(p);
      }
    }
    if (srv && merged.has(srv) && !ordered.includes(srv)) {
      ordered.push(srv);
    }
    if (
      this.modelPreset === this.MODEL_PRESET_CUSTOM &&
      cur &&
      merged.has(cur) &&
      !ordered.includes(cur)
    ) {
      ordered.push(cur);
    }
    const selectedPreset =
      this.modelPreset !== this.MODEL_PRESET_CUSTOM
        ? (this.modelPreset ?? '').trim()
        : '';
    if (
      selectedPreset &&
      merged.has(selectedPreset) &&
      !ordered.includes(selectedPreset)
    ) {
      ordered.push(selectedPreset);
    }
    const tail = [...merged]
      .filter((id) => !ordered.includes(id))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    this.routingModelOptions = [...ordered, ...tail];
    this.clampModelPresetToOptions();
  }

  /** Catalogue distant pour le fournisseur courant (authentifié uniquement). */
  private refreshProviderModelCatalog(): void {
    if (!this.isAuthenticated()) {
      return;
    }
    const p = this.routingProvider;
    this.assistant
      .getAssistantModels(p)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((ids) => {
        if (p !== this.routingProvider) {
          return;
        }
        this.remoteCatalogModelIds = ids;
        this.rebuildModelOptionsList();
        this.cdr.markForCheck();
      });
  }

  /**
   * Modèle « serveur » applicable au fournisseur actuellement sélectionné (pas le modèle OpenAI global pour tous).
   */
  private serverDefaultForActiveProvider(): string {
    if (this.routingProvider === 'openai') {
      if (this.serverOpenaiDefault) {
        return this.serverOpenaiDefault;
      }
      return this.serverRoutingDefault === 'openai' ? this.serverDefaultModel : '';
    }
    if (this.routingProvider === 'anthropic') {
      if (this.serverAnthropicDefault) {
        return this.serverAnthropicDefault;
      }
      return this.serverRoutingDefault === 'anthropic' ? this.serverDefaultModel : '';
    }
    if (this.serverGeminiDefault) {
      return this.serverGeminiDefault;
    }
    return this.serverRoutingDefault === 'gemini' ? this.serverDefaultModel : '';
  }

  /** Si la valeur courante n’existe pas dans {@link routingModelOptions} (ex. gpt après changement vers Claude). */
  private clampModelPresetToOptions(): void {
    if (this.modelPreset === this.MODEL_PRESET_CUSTOM) {
      return;
    }
    if (this.modelPreset && this.routingModelOptions.includes(this.modelPreset)) {
      return;
    }
    const srv = this.serverDefaultForActiveProvider().trim();
    if (srv && this.routingModelOptions.includes(srv)) {
      this.modelPreset = srv;
      this.modelCustom = '';
      return;
    }
    const first = this.routingModelOptions[0];
    if (first) {
      this.modelPreset = first;
      this.modelCustom = '';
    }
  }

  private syncModelPresetFromServer(serverModel: string): void {
    const sm = serverModel.trim();
    if (!sm) {
      const first = this.routingModelOptions[0];
      this.modelPreset = first ?? this.MODEL_PRESET_CUSTOM;
      this.modelCustom = '';
      return;
    }
    if (this.routingModelOptions.includes(sm)) {
      this.modelPreset = sm;
      this.modelCustom = '';
    } else {
      this.modelPreset = this.MODEL_PRESET_CUSTOM;
      this.modelCustom = sm;
    }
  }

  private collectRoutingForSession(): AssistantRoutingStored {
    return {
      provider: this.routingProvider,
      modelPreset: this.modelPreset,
      modelCustom: this.modelCustom
    };
  }

  private scheduleRoutingPreferenceRemotePersist(): void {
    if (!this.isAuthenticated()) {
      return;
    }
    if (this.routingRemotePersistTimer !== undefined) {
      clearTimeout(this.routingRemotePersistTimer);
    }
    this.routingRemotePersistTimer = setTimeout(() => {
      this.routingRemotePersistTimer = undefined;
      const r = this.collectRoutingForSession();
      this.assistant
        .saveAssistantRoutingPreference(r)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe();
    }, AssistantDrawerComponent.ROUTING_REMOTE_DEBOUNCE_MS);
  }

  /** Libellé accessibilité du panneau : titre + fournisseur/modèle si connus. */
  drawerAriaLabel(): string {
    const base = this.translate.instant('ASSISTANT.TITLE');
    const meta = this.routingMetaSummary();
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

  openProviderBillingSite(ev?: MouseEvent): void {
    ev?.stopPropagation();
    const url = this.primaryBillingUrlForRoutingProvider();
    if (!url) {
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  /** Infobulle : ouverture du site facturation / usage du fournisseur. */
  creditsBtnHint(): string {
    if (this.routingProvider === 'anthropic') {
      return this.translate.instant('ASSISTANT.CREDITS_BTN_HINT_ANTHROPIC');
    }
    if (this.routingProvider === 'gemini') {
      return this.translate.instant('ASSISTANT.CREDITS_BTN_HINT_GEMINI');
    }
    return this.translate.instant('ASSISTANT.CREDITS_BTN_HINT');
  }

  creditsToggleAria(): string {
    if (this.routingProvider === 'anthropic') {
      return this.translate.instant('ASSISTANT.CREDITS_TOGGLE_ANTHROPIC');
    }
    if (this.routingProvider === 'gemini') {
      return this.translate.instant('ASSISTANT.CREDITS_TOGGLE_GEMINI');
    }
    return this.translate.instant('ASSISTANT.CREDITS_TOGGLE');
  }

  private resolveAssistantBillingUrl(configured: string, fallback: string): string {
    const t = (configured ?? '').trim();
    return t.length > 0 ? t : fallback;
  }

  /**
   * URL ouverte par le bouton graphique : usage OpenAI, console Anthropic, quotas Gemini
   * (voir {@code assistant.billing.*}).
   */
  private primaryBillingUrlForRoutingProvider(): string {
    if (this.routingProvider === 'anthropic') {
      return this.resolveAssistantBillingUrl(
        this.billingAnthropicUrl,
        AssistantDrawerComponent.DEFAULT_BILLING_ANTHROPIC
      );
    }
    if (this.routingProvider === 'gemini') {
      return this.resolveAssistantBillingUrl(
        this.billingGeminiRateLimitUrl,
        AssistantDrawerComponent.DEFAULT_BILLING_GEMINI_RATE
      );
    }
    return this.resolveAssistantBillingUrl(
      this.billingOpenaiUsageUrl,
      AssistantDrawerComponent.DEFAULT_BILLING_OPENAI_USAGE
    );
  }

  ngOnDestroy(): void {
    const appRoot = document.querySelector('app-root');
    if (appRoot && document.querySelector('.modal.show')) {
      appRoot.setAttribute('aria-hidden', 'true');
    }
    if (this.routingRemotePersistTimer !== undefined) {
      clearTimeout(this.routingRemotePersistTimer);
      this.routingRemotePersistTimer = undefined;
    }
    this.persistSession();
    this.stopLoadingElapsedTimer();
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
    this.revokeAssistantHydratedBlobs();
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
    this.historyListSub?.unsubscribe();
    if (this.assistantHistoryModalRef) {
      try {
        this.assistantHistoryModalRef.dismiss();
      } catch {
        /* ignore */
      }
      this.assistantHistoryModalRef = null;
    }
    if (this.draftExpandGutterResizeRaf !== null) {
      cancelAnimationFrame(this.draftExpandGutterResizeRaf);
      this.draftExpandGutterResizeRaf = null;
    }
    if (this.draftExpandMeasureDiv) {
      this.draftExpandMeasureDiv.remove();
      this.draftExpandMeasureDiv = null;
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
      this.collectToolFlagsForSession(),
      this.collectRoutingForSession(),
      this.fabUnreadReply
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
    if (this.routingProvider === 'openai' && this.toolMcp) {
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

  /** Index du dernier message assistant (réponse la plus récente). */
  lastAssistantMessageIndex(): number {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'assistant') {
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
    let blob: Blob | null =
      dataUrls.length > 0 ? this.dataUrlToBlob(dataUrls[0]) : null;
    const blobUrls = this.extractGeneratedImageBlobUrls(m.content);
    if (!blob && blobUrls.length > 0) {
      try {
        blob = await (await fetch(blobUrls[0].trim())).blob();
      } catch {
        blob = null;
      }
    }
    if (!blob && m.generatedImageAssetIds?.length) {
      const id = m.generatedImageAssetIds.map((x) => x?.trim()).find(Boolean);
      if (id) {
        try {
          blob = await firstValueFrom(this.assistant.getConversationAssetBlob(id));
        } catch {
          blob = null;
        }
      }
    }
    if (!blob || blob.size === 0) {
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

  private showAssistantTransientBanner(
    key: string,
    kind: 'success' | 'error',
    dismissMs: number
  ): void {
    if (this.assistantImageCopyFeedbackTimer) {
      clearTimeout(this.assistantImageCopyFeedbackTimer);
    }
    this.assistantImageCopyFeedbackKey = key;
    this.assistantImageCopyFeedbackKind = kind;
    this.cdr.markForCheck();
    this.assistantImageCopyFeedbackTimer = setTimeout(() => {
      this.assistantImageCopyFeedbackKey = null;
      this.assistantImageCopyFeedbackKind = null;
      this.cdr.markForCheck();
    }, dismissMs);
  }

  private showAssistantImageCopyFeedback(success: boolean): void {
    this.showAssistantTransientBanner(
      success ? 'ASSISTANT.COPY_IMG_SUCCESS' : 'ASSISTANT.COPY_IMG_ERROR',
      success ? 'success' : 'error',
      2200
    );
  }

  /** Copie le texte du champ de composition vers le presse-papiers. */
  copyAssistantDraftToClipboard(): void {
    if (this.loading) {
      return;
    }
    const text = this.draft ?? '';
    if (!text.trim()) {
      return;
    }
    copyPlainTextToClipboard(text);
    this.showAssistantTransientBanner('ASSISTANT.COPY_QUESTION_SUCCESS', 'success', 1800);
    this.cdr.markForCheck();
  }

  /** Vide uniquement le champ de saisie (sans effacer le fil de discussion). */
  clearDraftOnly(): void {
    if (this.loading) {
      return;
    }
    this.draft = '';
    if (this.draftPersistTimer !== undefined) {
      clearTimeout(this.draftPersistTimer);
      this.draftPersistTimer = undefined;
    }
    this.persistSession();
    this.cdr.markForCheck();
    queueMicrotask(() => {
      this.draftInputEl?.nativeElement?.focus();
    });
  }

  /**
   * Place le texte dans le champ de composition de l’assistant et positionne le curseur à la fin.
   */
  private putQuestionTextInAssistantDraft(text: string): void {
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

  /** Recopie une question précédente dans le champ du bas (pour relancer ou modifier). */
  copyQuestionIntoDraft(content: string, ev: MouseEvent): void {
    ev.stopPropagation();
    ev.preventDefault();
    if (this.loading) {
      return;
    }
    const text = typeof content === 'string' ? content : '';
    this.putQuestionTextInAssistantDraft(text);
  }

  /** Défile le fil de conversation tout en haut. */
  scrollAssistantThreadToTop(): void {
    const el = this.threadEl?.nativeElement;
    if (!el) {
      return;
    }
    el.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** Aligne le début de la dernière réponse de l’assistant en haut de la zone visible. */
  scrollAssistantThreadToBottom(): void {
    const el = this.threadEl?.nativeElement;
    if (!el) {
      return;
    }
    const anchor = el.querySelector(
      '.pat-assistant-bubble--anchor-last-assistant'
    ) as HTMLElement | null;
    if (anchor) {
      const desiredTop =
        anchor.getBoundingClientRect().top -
        el.getBoundingClientRect().top +
        el.scrollTop;
      el.scrollTo({ top: Math.max(0, desiredTop - 4), behavior: 'smooth' });
      return;
    }
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTo({ top: maxTop, behavior: 'smooth' });
  }

  /** Tout en bas du fil (après la dernière bulle / indicateur de chargement). */
  scrollAssistantThreadToEnd(): void {
    const el = this.threadEl?.nativeElement;
    if (!el) {
      return;
    }
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTo({ top: maxTop, behavior: 'smooth' });
  }

  ngAfterViewChecked(): void {
    if (this.shouldAlignLastAssistantTop && this.threadEl) {
      const wrap = this.threadEl.nativeElement;
      const anchor = wrap.querySelector(
        '.pat-assistant-bubble--anchor-last-assistant'
      ) as HTMLElement | null;
      if (anchor) {
        const desiredTop =
          anchor.getBoundingClientRect().top -
          wrap.getBoundingClientRect().top +
          wrap.scrollTop;
        wrap.scrollTop = Math.max(0, desiredTop - 4);
      }
      this.shouldAlignLastAssistantTop = false;
    }
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
      this.syncAppRootAriaWithAssistantOverModal();
      this.scheduleFocusComposeArea();
    } else {
      this.syncAppRootAriaWithAssistantOverModal();
    }
    this.persistSession();
  }

  close(): void {
    this.persistSession();
    this.isOpen = false;
    this.fullscreen = false;
    this.syncAppRootAriaWithAssistantOverModal();
  }

  /**
   * Avec une modale Ngb/Bootstrap ouverte, app-root reçoit aria-hidden=true (accessibilité) alors que
   * le tiroir assistant est peint au-dessus (z-index) mais reste dans app-root — cela peut bloquer
   * focus/saisie. On retire l'attribut tant que le chat est ouvert par-dessus une modale, puis on le
   * rétablit à la fermeture du chat si la modale est toujours là.
   */
  private syncAppRootAriaWithAssistantOverModal(): void {
    const appRoot = document.querySelector('app-root');
    if (!appRoot) {
      return;
    }
    const anyModal = !!document.querySelector('.modal.show');
    if (this.isOpen && anyModal) {
      appRoot.removeAttribute('aria-hidden');
    } else if (!this.isOpen && anyModal) {
      appRoot.setAttribute('aria-hidden', 'true');
    }
  }

  /** Focus la zone de saisie après ouverture (diaporama + modale : focus sinon reste dans le viewer). */
  private scheduleFocusComposeArea(): void {
    queueMicrotask(() => {
      requestAnimationFrame(() => {
        if (!this.isOpen) {
          return;
        }
        const el = this.draftInputEl?.nativeElement;
        if (el) {
          el.focus({ preventScroll: true });
          try {
            const len = el.value.length;
            el.setSelectionRange(len, len);
          } catch {
            /* IE / edge cases */
          }
        }
      });
    });
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

  @HostListener('window:resize')
  onWindowResizeDraftExpandGutter(): void {
    if (!this.draftExpandModalOpen) {
      return;
    }
    this.scheduleRefreshDraftExpandVisualLineCount();
  }

  clearThread(): void {
    this.revokeAssistantHydratedBlobs();
    this.messages = [];
    this.persistedRemoteConversationId = null;
    this.imageAttachError = null;
    this.fabUnreadReply = false;
    this.persistSession();
    this.cdr.markForCheck();
  }

  openAssistantToolsHelpModal(): void {
    this.assistantToolsHelpFullscreen = false;
    const ref = this.modalService.open(this.assistantToolsHelpModal, {
      centered: true,
      scrollable: true,
      size: 'xl',
      windowClass: 'assistant-tools-help-modal',
      fullscreen: false
    });
    this.toolsHelpModalRef = ref;
    void ref.result.finally(() => {
      this.toolsHelpModalRef = null;
      this.assistantToolsHelpFullscreen = false;
    });
  }

  openAssistantDraftExpandModal(): void {
    this.resetDraftExpandSearchUi();
    this.draftExpandModalOpen = true;
    this.draftExpandVisualLineCount = 0;
    const ref = this.modalService.open(this.assistantDraftExpandModal, {
      centered: true,
      scrollable: true,
      size: 'xl',
      windowClass: 'assistant-draft-expand-modal'
    });
    void ref.result.finally(() => {
      this.draftExpandModalOpen = false;
      this.draftExpandVisualLineCount = 0;
      this.onDraftDebouncedPersist();
      this.cdr.markForCheck();
      queueMicrotask(() => this.draftInputEl?.nativeElement?.focus());
    });
    queueMicrotask(() =>
      setTimeout(() => {
        this.draftExpandTextareaModalEl?.nativeElement?.focus();
        this.scheduleRefreshDraftExpandVisualLineCount();
      }, 120)
    );
    setTimeout(() => this.scheduleRefreshDraftExpandVisualLineCount(), 400);
  }

  /** Saisie dans la modale : persistance + numéros de lignes (wrapping). */
  onDraftExpandContentChange(): void {
    this.onDraftDebouncedPersist();
    this.scheduleRefreshDraftExpandVisualLineCount();
    this.rebuildDraftExpandSearchMatches();
  }

  private resetDraftExpandSearchUi(): void {
    this.draftExpandSearchPattern = '';
    this.draftExpandSearchAsRegex = false;
    this.draftExpandSearchIgnoreCase = true;
    this.draftExpandSearchMatches = [];
    this.draftExpandSearchMatchCount = 0;
    this.draftExpandSearchActiveIdx = -1;
    this.draftExpandSearchInvalid = false;
  }

  onDraftExpandSearchControlsChange(): void {
    this.rebuildDraftExpandSearchMatches();
    this.cdr.markForCheck();
  }

  private escapeDraftExpandRegExpChars(s: string): string {
    return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }

  private rebuildDraftExpandSearchMatches(): void {
    const raw = typeof this.draft === 'string' ? this.draft : '';
    const trimmed = this.draftExpandSearchPattern.trim();
    this.draftExpandSearchMatches = [];
    this.draftExpandSearchActiveIdx = -1;
    this.draftExpandSearchInvalid = false;
    if (!trimmed) {
      this.draftExpandSearchMatchCount = 0;
      return;
    }
    try {
      const flags = `g${this.draftExpandSearchIgnoreCase ? 'i' : ''}`;
      const re = this.draftExpandSearchAsRegex
        ? new RegExp(trimmed, flags)
        : new RegExp(this.escapeDraftExpandRegExpChars(trimmed), flags);
      let guard = 0;
      const maxIter = 500_000;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null && guard < maxIter) {
        guard++;
        const start = m.index;
        const len = m[0].length;
        if (len === 0) {
          const bump = start + 1;
          if (bump > raw.length) {
            break;
          }
          re.lastIndex = bump;
          continue;
        }
        this.draftExpandSearchMatches.push({ start, end: start + len });
      }
      this.draftExpandSearchMatchCount = this.draftExpandSearchMatches.length;
    } catch {
      this.draftExpandSearchInvalid = true;
      this.draftExpandSearchMatchCount = 0;
      this.draftExpandSearchMatches = [];
    }
  }

  draftExpandSearchNext(ev?: Event): void {
    ev?.preventDefault();
    const hits = this.draftExpandSearchMatches;
    if (!hits.length || this.draftExpandSearchInvalid) {
      return;
    }
    const next =
      this.draftExpandSearchActiveIdx < 0
        ? 0
        : (this.draftExpandSearchActiveIdx + 1) % hits.length;
    this.draftExpandSearchActiveIdx = next;
    this.draftExpandApplySearchHit(next);
  }

  draftExpandSearchPrev(ev?: Event): void {
    ev?.preventDefault();
    const hits = this.draftExpandSearchMatches;
    if (!hits.length || this.draftExpandSearchInvalid) {
      return;
    }
    const prev =
      this.draftExpandSearchActiveIdx <= 0
        ? hits.length - 1
        : this.draftExpandSearchActiveIdx - 1;
    this.draftExpandSearchActiveIdx = prev;
    this.draftExpandApplySearchHit(prev);
  }

  /** @param gutterEl passer le bloc gouttière si connu pour synchroniser le scroll (évite drift). */
  private draftExpandScrollToHitWithGutter(
    ta: HTMLTextAreaElement,
    gutterEl: HTMLElement | null,
    hit: { start: number; end: number }
  ): void {
    const before = ta.value.slice(0, hit.start);
    const lh = this.resolveTextareaLineHeightPx(ta);
    const lineStarts = before.split(/\n/).length - 1;
    const rough = Math.max(0, lineStarts * lh * 0.85 - ta.clientHeight * 0.35);
    ta.scrollTop = Math.min(rough, Math.max(0, ta.scrollHeight - ta.clientHeight));
    try {
      ta.setSelectionRange(hit.start, hit.end);
    } catch {
      /* ignore */
    }
    if (gutterEl) {
      gutterEl.scrollTop = ta.scrollTop;
    }
  }

  private draftExpandApplySearchHit(idx: number): void {
    const hit = this.draftExpandSearchMatches[idx];
    const ta = this.draftExpandTextareaModalEl?.nativeElement;
    if (!hit || !ta) {
      return;
    }
    const gutter = ta.closest('.pat-assistant-draft-expand-editor')?.querySelector(
      '.pat-assistant-draft-expand-gutter'
    ) as HTMLElement | null;
    ta.focus({ preventScroll: false });
    queueMicrotask(() => this.draftExpandScrollToHitWithGutter(ta, gutter, hit));
  }

  private scheduleRefreshDraftExpandVisualLineCount(): void {
    if (this.draftExpandGutterResizeRaf !== null) {
      cancelAnimationFrame(this.draftExpandGutterResizeRaf);
    }
    this.draftExpandGutterResizeRaf = requestAnimationFrame(() => {
      this.draftExpandGutterResizeRaf = null;
      this.refreshDraftExpandVisualLineCount();
      requestAnimationFrame(() => this.refreshDraftExpandVisualLineCount());
    });
  }

  private resolveTextareaLineHeightPx(el: HTMLTextAreaElement): number {
    const lhStr = getComputedStyle(el).lineHeight;
    if (lhStr === 'normal') {
      const fz = parseFloat(getComputedStyle(el).fontSize) || 14;
      return fz * 1.5715;
    }
    const lh = parseFloat(lhStr);
    const fz = parseFloat(getComputedStyle(el).fontSize) || 14;
    return Number.isFinite(lh) && lh > 0 ? lh : fz * 1.5715;
  }

  private getOrCreateDraftExpandMeasureDiv(): HTMLDivElement {
    if (this.draftExpandMeasureDiv) {
      return this.draftExpandMeasureDiv;
    }
    const d = document.createElement('div');
    d.setAttribute('aria-hidden', 'true');
    d.style.cssText =
      'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;overflow:hidden;height:auto;';
    document.body.appendChild(d);
    this.draftExpandMeasureDiv = d;
    return d;
  }

  /** Met à jour {@link draftExpandVisualLineCount} (lignes après retour automatique dans le textarea). */
  private refreshDraftExpandVisualLineCount(): void {
    const ta = this.draftExpandTextareaModalEl?.nativeElement;
    if (!ta) {
      return;
    }
    const d = this.getOrCreateDraftExpandMeasureDiv();
    const cs = getComputedStyle(ta);
    d.style.width = `${ta.clientWidth}px`;
    d.style.boxSizing = cs.boxSizing;
    d.style.fontFamily = cs.fontFamily;
    d.style.fontSize = cs.fontSize;
    d.style.fontWeight = cs.fontWeight;
    d.style.fontStyle = cs.fontStyle;
    d.style.letterSpacing = cs.letterSpacing;
    d.style.textTransform = cs.textTransform;
    d.style.lineHeight = cs.lineHeight;
    d.style.padding = cs.padding;
    d.style.border = cs.border;
    d.style.whiteSpace = 'pre-wrap';
    d.style.overflowWrap = cs.overflowWrap;
    d.style.wordBreak = cs.wordBreak;
    d.style.tabSize = cs.tabSize || '2';
    d.textContent = ta.value;
    const lh = this.resolveTextareaLineHeightPx(ta);
    const h = Math.max(lh, d.scrollHeight);
    const n = Math.max(1, Math.ceil(h / lh - 1e-9));
    if (this.draftExpandVisualLineCount !== n) {
      this.draftExpandVisualLineCount = n;
      this.cdr.markForCheck();
    }
  }

  onDraftExpandTextareaScroll(gutterEl: HTMLElement, ev: Event): void {
    const ta = ev.target;
    if (gutterEl && ta instanceof HTMLTextAreaElement) {
      gutterEl.scrollTop = ta.scrollTop;
    }
  }

  /** Texte lignes « 1 », « 2 », … : max(lignes `\n`, lignes visuelles mesurées avec wrapping). */
  get draftExpandLineNumbersText(): string {
    const text = typeof this.draft === 'string' ? this.draft : '';
    const logicalLines = Math.max(1, text.split('\n').length);
    const n = Math.max(logicalLines, this.draftExpandVisualLineCount);
    return Array.from({ length: n }, (_, i) => String(i + 1)).join('\n');
  }

  /** Nombre de lignes délimitées par des sauts de ligne (affichage pied de modale). */
  get draftExpandLogicalLineCount(): number {
    const t = typeof this.draft === 'string' ? this.draft : '';
    return Math.max(1, t.split('\n').length);
  }

  /** Lignes à l’écran (après wrap), pour le pied de modale ; si pas encore mesuré (0), on retombe sur les lignes logiques. */
  get draftExpandWrappedLineCountForFooter(): number {
    const logical = this.draftExpandLogicalLineCount;
    const vis = this.draftExpandVisualLineCount;
    return vis > 0 ? Math.max(logical, vis) : logical;
  }

  get draftExpandSearchPositionLabel(): string {
    if (this.draftExpandSearchInvalid || !this.draftExpandSearchPattern.trim()) {
      return '';
    }
    const total = this.draftExpandSearchMatchCount;
    if (total <= 0) {
      return '';
    }
    if (this.draftExpandSearchActiveIdx >= 0) {
      return `${this.draftExpandSearchActiveIdx + 1} / ${total}`;
    }
    return `— / ${total}`;
  }

  toggleAssistantToolsHelpFullscreen(): void {
    if (!this.toolsHelpModalRef) {
      return;
    }
    this.assistantToolsHelpFullscreen = !this.assistantToolsHelpFullscreen;
    this.toolsHelpModalRef.update({ fullscreen: this.assistantToolsHelpFullscreen });
  }

  openAssistantHistoryModal(): void {
    if (!this.isAuthenticated()) {
      return;
    }
    this.historyConversationFilter = '';
    this.historyErrorKey = null;
    this.historyLoading = true;
    this.historyItems = [];
    this.historyListSub?.unsubscribe();
    const ref = this.modalService.open(this.assistantHistoryModal, {
      centered: true,
      scrollable: false,
      windowClass: 'assistant-history-modal'
    });
    this.assistantHistoryModalRef = ref;
    const clearRef = (): void => {
      this.assistantHistoryModalRef = null;
      this.historyListSub?.unsubscribe();
    };
    ref.closed.subscribe(clearRef);
    ref.dismissed.subscribe(clearRef);
    this.historyListSub = this.assistant
      .listConversations()
      .pipe(
        finalize(() => {
          this.historyLoading = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (rows) => {
          this.historyItems = rows ?? [];
        },
        error: () => {
          this.historyErrorKey = 'ASSISTANT.HISTORY_LOAD_ERR';
        }
      });
    this.cdr.markForCheck();
  }

  /** Nom affiché du propriétaire : login stocké / JWT (ses lignes), sans retomber sur le `sub` opaque si possible. */
  historyOwnerDisplay(row: AssistantConversationSummary): string {
    const fromApi = (row.ownerPreferredUsername ?? '').trim();
    if (fromApi.length > 0) {
      return fromApi;
    }
    const ownerSub = (row.ownerSubject ?? '').trim();
    const mySub = this.keycloak.getJwtSubject();
    const isMine = !!(mySub && ownerSub === mySub);
    if (isMine) {
      const selfLabel = (this.keycloak.getUsernameForDisplay() ?? '').trim();
      if (selfLabel.length > 0) {
        return selfLabel;
      }
    }
    if (!isMine && ownerSub.length > 0 && this.looksLikeOpaqueSubjectId(ownerSub)) {
      return this.translate.instant('ASSISTANT.HISTORY_OWNER_UNKNOWN');
    }
    return ownerSub;
  }

  /** Évite d’afficher un UUID Keycloak (ou id opaque) comme « nom » pour les conversations des autres. */
  private looksLikeOpaqueSubjectId(sub: string): boolean {
    const t = sub.trim();
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)
    ) {
      return true;
    }
    return /^\d{16,}$/.test(t);
  }

  /** Liste historique filtrée selon {@link historyConversationFilter}. */
  filteredAssistantHistoryItems(): AssistantConversationSummary[] {
    const rows = this.historyItems;
    const q = (this.historyConversationFilter ?? '').trim().toLowerCase();
    if (!q) {
      return rows;
    }
    return rows.filter((row) => {
      const hay = [
        row.preview,
        row.providerLabel,
        row.model,
        row.routingProvider,
        row.id,
        row.createdAt,
        row.updatedAt,
        row.ownerSubject,
        row.ownerPreferredUsername
      ]
        .map((x) => (typeof x === 'string' ? x : ''))
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  loadConversationFromHistory(id: string): void {
    if (!this.isAuthenticated()) {
      return;
    }
    this.historyDetailLoading = true;
    this.historyErrorKey = null;
    this.assistant
      .getConversation(id)
      .pipe(
        switchMap((detail) => this.hydrateAssistantConversationDetail(detail)),
        finalize(() => {
          this.historyDetailLoading = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (detail) => {
          this.applyLoadedAssistantConversation(detail);
          this.assistantHistoryModalRef?.close();
        },
        error: () => {
          this.historyErrorKey = 'ASSISTANT.HISTORY_DETAIL_ERR';
        }
      });
  }

  deleteAssistantConversationFromHistory(id: string, ev: Event): void {
    ev.stopPropagation();
    ev.preventDefault();
    const msg = this.translate.instant('ASSISTANT.HISTORY_DELETE_CONFIRM');
    if (!globalThis.confirm(msg)) {
      return;
    }
    this.assistant
      .deleteConversation(id)
      .pipe(take(1))
      .subscribe({
        next: () => {
          this.historyItems = this.historyItems.filter((h) => h.id !== id);
          if (this.persistedRemoteConversationId === id) {
            this.persistedRemoteConversationId = null;
          }
          this.cdr.markForCheck();
        },
        error: () => {
          this.historyErrorKey = 'ASSISTANT.HISTORY_DELETE_ERR';
          this.cdr.markForCheck();
        }
      });
  }

  /**
   * Copie la première question utilisateur dans le presse-papiers et dans le champ de composition ;
   * ferme la modale d’historique. Texte complet via le détail (l’aperçu liste est tronqué côté serveur).
   */
  copyAssistantHistoryQuestion(row: AssistantConversationSummary, ev: MouseEvent): void {
    ev.stopPropagation();
    ev.preventDefault();
    if (this.assistantHistoryCopyingId != null) {
      return;
    }
    this.assistantHistoryCopyingId = row.id;
    this.cdr.markForCheck();
    this.assistant
      .getConversation(row.id)
      .pipe(
        take(1),
        finalize(() => {
          this.assistantHistoryCopyingId = null;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (detail) => {
          const text = this.extractFirstUserQuestionFromConversationDetail(detail);
          if (text) {
            copyPlainTextToClipboard(text);
            this.putQuestionTextInAssistantDraft(text);
            this.assistantHistoryModalRef?.close();
            this.showAssistantTransientBanner(
              'ASSISTANT.HISTORY_COPY_QUESTION_OK',
              'success',
              2200
            );
            return;
          }
          const fallback = this.previewPlainFallback(row.preview);
          if (fallback) {
            copyPlainTextToClipboard(fallback);
            this.putQuestionTextInAssistantDraft(fallback);
            this.assistantHistoryModalRef?.close();
            this.showAssistantTransientBanner(
              'ASSISTANT.HISTORY_COPY_QUESTION_OK',
              'success',
              2200
            );
          } else {
            this.showAssistantTransientBanner(
              'ASSISTANT.HISTORY_COPY_QUESTION_EMPTY',
              'error',
              2800
            );
          }
        },
        error: () => {
          const fallback = this.previewPlainFallback(row.preview);
          if (fallback) {
            copyPlainTextToClipboard(fallback);
            this.putQuestionTextInAssistantDraft(fallback);
            this.assistantHistoryModalRef?.close();
            this.showAssistantTransientBanner(
              'ASSISTANT.HISTORY_COPY_QUESTION_OK',
              'success',
              2200
            );
          } else {
            this.showAssistantTransientBanner(
              'ASSISTANT.HISTORY_COPY_QUESTION_ERR',
              'error',
              2800
            );
          }
        }
      });
  }

  private extractFirstUserQuestionFromConversationDetail(
    detail: AssistantConversationDetail
  ): string {
    for (const t of detail.turns ?? []) {
      if (t.role === 'user' && typeof t.content === 'string') {
        const c = t.content.trim();
        if (c) {
          return c;
        }
      }
    }
    return '';
  }

  private previewPlainFallback(preview: string | null | undefined): string {
    const s = typeof preview === 'string' ? preview.trim() : '';
    if (!s) {
      return '';
    }
    return s.replace(/\u2026\s*$/, '').replace(/\.\.\.\s*$/, '').trim();
  }

  private applyLoadedAssistantConversation(detail: AssistantConversationDetail): void {
    this.persistedRemoteConversationId = detail.id;
    const providerBefore = this.routingProvider;
    if (
      detail.routingProvider === 'openai' ||
      detail.routingProvider === 'anthropic' ||
      detail.routingProvider === 'gemini'
    ) {
      this.routingProvider = detail.routingProvider;
      this.routingProviderLockedAgainstConfigDefault = true;
    }
    if (providerBefore !== this.routingProvider) {
      this.remoteCatalogModelIds = [];
    }
    this.rebuildModelOptionsList();
    /** Le Mongo historique garde l’id exact du modèle (ex. gpt-5.5-2026-04-23), absent des presets courts → éviter « personnalisé » si on peut l’aligner sur une entrée liste. */
    const persistedModel = (detail.model ?? '').trim();
    if (persistedModel && !this.routingModelOptions.includes(persistedModel)) {
      this.routingModelOptions = [...this.routingModelOptions, persistedModel];
    }
    this.syncModelPresetFromServer(detail.model ?? '');
    this.refreshProviderModelCatalog();
    this.messages = detail.turns.map((t) => this.mapPersistedTurnToChatTurn(t));
    this.fabUnreadReply = false;
    this.persistSession();
    if (this.lastAssistantMessageIndex() >= 0) {
      this.requestAlignLastAssistantTop();
    } else {
      this.requestAlignLastQuestionTop();
    }
    this.cdr.markForCheck();
    queueMicrotask(() => this.fitGeneratedImagesInChat());
  }

  /**
   * Reconstruit le markdown affichable pour les tours assistant dont les images
   * sont stockées en assets (IDs), sans gonfler le JSON de conversation.
   */
  private hydrateAssistantConversationDetail(
    detail: AssistantConversationDetail
  ): Observable<AssistantConversationDetail> {
    /** Libère les blobs de la conversation précédemment chargée ; pas après hydrate (sinon les URLs du détail courant sont mortes). */
    this.revokeAssistantHydratedBlobs();
    const turnObservables = detail.turns.map((t) => {
      if (t.role !== 'assistant' || !t.generatedImageAssetIds?.length) {
        return of(t);
      }
      const ids = t.generatedImageAssetIds;
      return forkJoin(
        ids.map((aid) =>
          this.assistant.getConversationAssetBlob(aid).pipe(catchError(() => of(null)))
        )
      ).pipe(
        map((blobs) => {
          let content = typeof t.content === 'string' ? t.content : '';
          for (const blob of blobs) {
            if (!blob || blob.size === 0) {
              continue;
            }
            const u = URL.createObjectURL(blob);
            this.assistantHydratedBlobUrls.push(u);
            content += `\n\n![Generated](${u})\n`;
          }
          return { ...t, content };
        })
      );
    });
    return forkJoin(turnObservables).pipe(map((turns) => ({ ...detail, turns })));
  }

  private mapPersistedTurnToChatTurn(t: AssistantConversationTurnPersist): AssistantChatTurn {
    const base: AssistantChatTurn = {
      role: t.role,
      content: typeof t.content === 'string' ? t.content : ''
    };
    if (t.role === 'user' && t.hasImage === true) {
      base.hasImage = true;
    }
    if (t.role === 'user' && t.imageDataUrl?.trim()) {
      base.imageDataUrl = t.imageDataUrl.trim();
    }
    if (t.role === 'assistant' && t.generatedImageAssetIds?.length) {
      base.generatedImageAssetIds = [...t.generatedImageAssetIds];
    }
    if (t.role === 'assistant' && t.meta) {
      const m = t.meta;
      const meta: AssistantChatMeta = {};
      if (m.elapsedMs != null && Number.isFinite(m.elapsedMs)) {
        meta.elapsedMs = Math.round(m.elapsedMs);
      }
      if (m.inputTokens != null) {
        meta.inputTokens = m.inputTokens;
      }
      if (m.outputTokens != null) {
        meta.outputTokens = m.outputTokens;
      }
      if (m.provider?.trim()) {
        meta.provider = m.provider.trim();
      }
      if (m.model?.trim()) {
        meta.model = m.model.trim();
      }
      if (Object.keys(meta).length) {
        base.meta = meta;
      }
    }
    return base;
  }

  private revokeAssistantHydratedBlobs(): void {
    for (const u of this.assistantHydratedBlobUrls) {
      try {
        URL.revokeObjectURL(u);
      } catch {
        /* ignore */
      }
    }
    this.assistantHydratedBlobUrls = [];
  }

  private prepareAssistantConversationSaveBodyWithAssets(): Observable<AssistantConversationSaveBody> {
    const labels = this.conversationPersistLabels();
    return forkJoin(this.messages.map((m) => this.messageToPersistTurn$(m))).pipe(
      map((turns) => ({
        routingProvider: this.routingProvider,
        providerLabel: labels.providerLabel,
        model: labels.model,
        turns
      }))
    );
  }

  private messageToPersistTurn$(
    m: AssistantChatTurn
  ): Observable<AssistantConversationTurnPersist> {
    if (m.role === 'user') {
      return of(this.userMessageToPersistTurn(m));
    }
    const content = typeof m.content === 'string' ? m.content : '';
    const persistText = this.persistableAssistantText(content);
    const dataUrls = this.extractGeneratedImageDataUrls(content);
    if (dataUrls.length > 0) {
      return forkJoin(
        dataUrls.map((u) => this.uploadGeneratedImageDataUrl$(u))
      ).pipe(
        map((ids) => this.assistantMessageToPersistTurn(m, ids, persistText))
      );
    }
    const existingIds = m.generatedImageAssetIds?.filter((id) => id?.trim()) ?? [];
    if (existingIds.length > 0) {
      return of(this.assistantMessageToPersistTurn(m, existingIds, persistText));
    }
    return of(this.assistantMessageToPersistTurn(m, undefined, persistText));
  }

  private userMessageToPersistTurn(m: AssistantChatTurn): AssistantConversationTurnPersist {
    const row: AssistantConversationTurnPersist = {
      role: 'user',
      content: typeof m.content === 'string' ? m.content : ''
    };
    if (m.hasImage === true) {
      row.hasImage = true;
    }
    if (m.imageDataUrl?.trim()) {
      row.imageDataUrl = m.imageDataUrl.trim();
    }
    return row;
  }

  private assistantMessageToPersistTurn(
    m: AssistantChatTurn,
    generatedImageAssetIds: string[] | undefined,
    persistText: string
  ): AssistantConversationTurnPersist {
    const row: AssistantConversationTurnPersist = {
      role: 'assistant',
      content: persistText,
      ...(generatedImageAssetIds?.length
        ? { generatedImageAssetIds: [...generatedImageAssetIds] }
        : {})
    };
    if (m.meta) {
      row.meta = {
        ...(m.meta.elapsedMs != null ? { elapsedMs: m.meta.elapsedMs } : {}),
        ...(m.meta.inputTokens != null ? { inputTokens: m.meta.inputTokens } : {}),
        ...(m.meta.outputTokens != null ? { outputTokens: m.meta.outputTokens } : {}),
        ...(m.meta.provider?.trim() ? { provider: m.meta.provider.trim() } : {}),
        ...(m.meta.model?.trim() ? { model: m.meta.model.trim() } : {})
      };
    }
    return row;
  }

  private uploadGeneratedImageDataUrl$(dataUrl: string): Observable<string> {
    const trimmed = dataUrl.trim();
    const match = /^data:([^;]+);base64,(.+)$/is.exec(trimmed);
    if (!match?.[1] || !match[2]) {
      return throwError(() => new Error('invalid assistant generated image data URL'));
    }
    const mimeType = match[1].trim().toLowerCase();
    const base64 = match[2].replace(/\s+/g, '');
    return this.assistant
      .uploadConversationAsset({ mimeType, base64 })
      .pipe(map((r) => r.id));
  }

  /** Texte assistant persisté : sans data URLs ni blob URLs locales (images → assets séparés). */
  private persistableAssistantText(raw: string): string {
    const base = typeof raw === 'string' ? raw : '';
    const withoutData = this.stripGeneratedImagesFromContent(base);
    return this.stripBlobGeneratedImagesFromContent(withoutData).trim();
  }

  private stripBlobGeneratedImagesFromContent(content: string): string {
    if (!content) {
      return '';
    }
    let out = content.replace(/!\[[^\]]*\]\((blob:[^)\s]+)\)/g, '');
    out = out.replace(/<img[^>]*\ssrc=["']blob:[^"']+["'][^>]*\/?>(\s*<\/img>)?/gi, '');
    return out.replace(/\n{3,}/g, '\n\n').trim();
  }

  private conversationPersistLabels(): { providerLabel: string; model: string } {
    const model = this.resolvedModelIdForNextChatRequest();
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === 'assistant' && m.meta?.provider?.trim()) {
        return {
          providerLabel: m.meta.provider!.trim(),
          model
        };
      }
    }
    const fallbackProv =
      this.routingProvider === 'openai'
        ? this.translate.instant('ASSISTANT.PROVIDER_OPENAI_SHORT')
        : this.routingProvider === 'gemini'
          ? this.translate.instant('ASSISTANT.PROVIDER_GEMINI_SHORT')
          : this.translate.instant('ASSISTANT.PROVIDER_ANTHROPIC_SHORT');
    return { providerLabel: fallbackProv, model };
  }

  private persistRemoteConversationOnce(): Observable<void> {
    if (!this.isAuthenticated()) {
      return EMPTY;
    }
    return defer(() =>
      this.prepareAssistantConversationSaveBodyWithAssets().pipe(
        switchMap((body) => {
          if (!body.turns.length) {
            return EMPTY;
          }
          const id = this.persistedRemoteConversationId;
          if (id) {
            return this.assistant.updateConversation(id, body).pipe(
              tap(() => {
                this.historyPersistErrorKey = null;
              }),
              catchError(() => {
                this.historyPersistErrorKey = 'ASSISTANT.HISTORY_SAVE_ERR';
                this.cdr.markForCheck();
                return EMPTY;
              })
            );
          }
          return this.assistant.createConversation(body).pipe(
            tap((res) => {
              if (res?.id) {
                this.persistedRemoteConversationId = res.id;
              }
              this.historyPersistErrorKey = null;
            }),
            catchError(() => {
              this.historyPersistErrorKey = 'ASSISTANT.HISTORY_SAVE_ERR';
              this.cdr.markForCheck();
              return EMPTY;
            }),
            map(() => undefined)
          );
        })
      )
    );
  }

  private scheduleRemoteConversationPersist(): void {
    if (!this.isAuthenticated()) {
      return;
    }
    this.remotePersistTrigger.next();
  }

  /** Bouton actif tant qu’il y a un historique de messages à effacer (le brouillon reste intact). */
  hasAnythingToReset(): boolean {
    return this.messages.length > 0;
  }

  clearPendingImage(): void {
    this.pendingImage = null;
    this.imageAttachError = null;
    this.cdr.markForCheck();
  }

  private endImageAttachSpinner(): void {
    this.imageAttachProcessing = false;
    this.cdr.markForCheck();
  }

  async onImageFileChange(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    this.imageAttachError = null;
    if (!file) {
      return;
    }
    this.imageAttachProcessing = true;
    this.cdr.markForCheck();

    let fileForRead: File = file;
    const mimeNorm = AssistantDrawerComponent.normalizePickMime(file);
    const isHeic =
      mimeNorm === 'image/heic' ||
      mimeNorm === 'image/heif' ||
      /\.hei[cfs]?$/i.test(file.name);
    if (isHeic) {
      try {
        const { default: heic2any } = await import('heic2any');
        const converted = await heic2any({
          blob: file,
          toType: 'image/jpeg',
          quality: 0.92
        });
        const blob = Array.isArray(converted) ? converted[0] : converted;
        if (!blob?.size) {
          throw new Error('empty');
        }
        const baseName = file.name.replace(/\.(heic|heif|heics)$/i, '') || 'image';
        fileForRead = new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
      } catch {
        this.ngZone.run(() => {
          this.imageAttachError = 'ASSISTANT.IMAGE_READ_ERROR';
          this.pendingImage = null;
          this.endImageAttachSpinner();
        });
        return;
      }
    }
    const effectiveMime = AssistantDrawerComponent.normalizePickMime(fileForRead);
    if (!AssistantDrawerComponent.IMAGE_ACCEPT_RE.test(effectiveMime)) {
      this.imageAttachError = 'ASSISTANT.IMAGE_TYPE_REJECTED';
      this.endImageAttachSpinner();
      return;
    }
    if (fileForRead.size > AssistantDrawerComponent.IMAGE_MAX_BYTES) {
      this.imageAttachError = 'ASSISTANT.IMAGE_TOO_LARGE';
      this.endImageAttachSpinner();
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      this.ngZone.run(() => {
        try {
          const dataUrl = reader.result as string;
          const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
          if (!m?.[1] || !m[2]) {
            this.imageAttachError = 'ASSISTANT.IMAGE_READ_ERROR';
            this.pendingImage = null;
            return;
          }
          let storedMime = m[1].trim().toLowerCase().split(';')[0].trim();
          if (storedMime === 'image/jpg') {
            storedMime = 'image/jpeg';
          }
          if (!AssistantDrawerComponent.IMAGE_ACCEPT_RE.test(storedMime)) {
            storedMime = effectiveMime;
          }
          if (!AssistantDrawerComponent.IMAGE_ACCEPT_RE.test(storedMime)) {
            this.imageAttachError = 'ASSISTANT.IMAGE_TYPE_REJECTED';
            this.pendingImage = null;
            return;
          }
          this.pendingImage = {
            mimeType: storedMime,
            base64: m[2].replace(/\s+/g, ''),
            dataUrl
          };
          this.imageAttachError = null;
          this.toolWebSearch = false;
          this.toolImageGeneration = false;
          this.toolMcp = false;
          this.applyAssistantLaunchRouting(ASSISTANT_VISION_IMAGE_LAUNCH_ROUTING);
        } finally {
          this.endImageAttachSpinner();
        }
      });
    };
    reader.onerror = () => {
      this.ngZone.run(() => {
        try {
          this.imageAttachError = 'ASSISTANT.IMAGE_READ_ERROR';
          this.pendingImage = null;
        } finally {
          this.endImageAttachSpinner();
        }
      });
    };
    reader.readAsDataURL(fileForRead);
  }

  trustedImageSrc(url: string): SafeUrl {
    return this.sanitizer.bypassSecurityTrustUrl(url);
  }

  /**
   * Après un lancement avec {@link AssistantLaunchPayload.autoSend}, envoie le brouillon
   * comme un message utilisateur (nouvelle conversation déjà préparée par le subscriber).
   */
  private tryAutoSendAfterLaunchFromPayload(): void {
    queueMicrotask(() => {
      if (this.loading || !this.isAuthenticated()) {
        return;
      }
      const t = this.draft?.trim() ?? '';
      if (!t) {
        return;
      }
      if (this.pendingImage != null) {
        return;
      }
      this.send();
    });
  }

  send(): void {
    if (this.loading || this.imageAttachProcessing || !this.isAuthenticated()) {
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
    this.startLoadingElapsedTimer();

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
        attached,
        {
          provider: this.routingProvider,
          model: this.resolvedModelIdForNextChatRequest()
        }
      )
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          // Évite NG0100 si la réponse arrive de façon synchrone : finalize sinon dans le même tick que detectChanges() du next.
          queueMicrotask(() => {
            this.stopLoadingElapsedTimer();
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
    this.requestAlignLastAssistantTop();
    this.persistSession();
    this.scheduleRemoteConversationPersist();
    this.cdr.detectChanges();
  }

  private requestAlignLastQuestionTop(): void {
    this.shouldAlignLastQuestionTop = true;
  }

  /** Place le haut de la dernière bulle assistant dans la zone visible du fil (après réception de la réponse). */
  private requestAlignLastAssistantTop(): void {
    this.shouldAlignLastAssistantTop = true;
  }

  /** Ouvert uniquement avec au moins un message dans l’historique. */
  canShareAssistantWhatsApp(): boolean {
    return this.messages.length > 0 && !this.loading && !this.pdfExporting;
  }

  /**
   * Vrai si la bulle assistant contient au moins une image générée
   * (data URL, blob URL locale après rechargement historique, ou IDs d’assets serveur).
   */
  hasGeneratedImage(m: AssistantChatTurn): boolean {
    if (m.role !== 'assistant') {
      return false;
    }
    if ((m.generatedImageAssetIds?.length ?? 0) > 0) {
      return true;
    }
    const c = m.content ?? '';
    return (
      this.extractGeneratedImageDataUrls(c).length > 0 ||
      this.extractGeneratedImageBlobUrls(c).length > 0
    );
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

  /** URLs blob locales (`blob:`) provenant de l’hydratation des assets sauvegardés. */
  private extractGeneratedImageBlobUrls(content: string | null | undefined): string[] {
    if (content == null || content === '') {
      return [];
    }
    const out: string[] = [];
    const seen = new Set<string>();
    const mdRe = /!\[[^\]]*\]\((blob:[^)\s]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = mdRe.exec(content)) !== null) {
      const url = m[1];
      if (url && !seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    }
    const imgRe = /<img[^>]*\ssrc=["'](blob:[^"']+)["']/gi;
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

    const dataUrlList = await this.assistantGeneratedImagesAsDataUrls(m);
    const files: File[] = [];
    let i = 0;
    for (const url of dataUrlList) {
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
    const pm = this.replyProviderModelLine(m).trim();
    if (pm.length > 0) {
      const line = this.shareProviderModelLineForWhatsApp(pm);
      if (line.length > 0) {
        message += `\n\n${line}`;
      }
    }

    const replyPlain = this.persistableAssistantText(
      typeof m.content === 'string' ? m.content : ''
    ).trim();
    if (replyPlain.length > 0) {
      const max = 1200;
      const excerpt =
        replyPlain.length <= max ? replyPlain : `${replyPlain.slice(0, max)}…`;
      const aiLabel = this.translate.instant('ASSISTANT.AI');
      message += `\n\n*${aiLabel}*\n${excerpt}`;
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
        /**
         * WhatsApp (entre autres) ignore souvent {@link ShareData.text} lorsqu’il y a des fichiers :
         * on copie donc le bloc texte dans le presse-papiers pour collage manuel après envoi de l’image.
         */
        if (message.trim()) {
          copyPlainTextToClipboard(message);
        }
        try {
          await nav.share({ title, text: message, files });
          if (message.trim()) {
            this.showAssistantTransientBanner(
              'ASSISTANT.SHARE_GENERATED_IMG_WHATSAPP_CAPTION_HINT',
              'success',
              6500
            );
          }
          return;
        } catch (err: unknown) {
          if (aborted(err)) {
            return;
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
  async openInsertImageInEventModal(m: AssistantChatTurn, ev: Event): Promise<void> {
    ev.stopPropagation();
    ev.preventDefault();
    if (!this.hasGeneratedImage(m)) {
      return;
    }
    this.revokeInsertImagePickObjectUrl();
    const dataUrls = this.extractGeneratedImageDataUrls(m.content);
    const blobUrls = this.extractGeneratedImageBlobUrls(m.content);
    let picked = dataUrls[0]?.trim() || blobUrls[0]?.trim() || '';
    if (!picked && m.generatedImageAssetIds?.length) {
      const id = m.generatedImageAssetIds.map((x) => x?.trim()).find(Boolean);
      if (id) {
        try {
          const b = await firstValueFrom(this.assistant.getConversationAssetBlob(id));
          if (b && b.size > 0) {
            picked = URL.createObjectURL(b);
            this.insertImagePickObjectUrl = picked;
          }
        } catch {
          picked = '';
        }
      }
    }
    if (!picked) {
      return;
    }
    if (picked.startsWith('blob:')) {
      const wasTrackedPick = this.insertImagePickObjectUrl === picked;
      try {
        const file = await this.blobUrlToFile(picked, 'pat-insert');
        const du = await this.readBlobAsDataUrl(file);
        if (du?.startsWith('data:image/')) {
          if (wasTrackedPick && this.insertImagePickObjectUrl) {
            URL.revokeObjectURL(this.insertImagePickObjectUrl);
            this.insertImagePickObjectUrl = null;
          }
          picked = du;
        }
      } catch {
        /* conserve blob: si conversion impossible */
      }
    }
    this.insertMode = 'image';
    this.insertImageDataUrl = picked;
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
    void this.prepareInsertCommentInEventModal(m);
  }

  private async prepareInsertCommentInEventModal(m: AssistantChatTurn): Promise<void> {
    this.revokeInsertImagePickObjectUrl();
    this.insertMode = 'comment';
    this.insertImageDataUrl = null;
    let imgs: string[] = [];
    try {
      imgs = await this.assistantGeneratedImagesAsDataUrls(m);
    } catch {
      imgs = [];
    }
    this.insertCommentText = this.buildDefaultCommentText(m, imgs);
    this.openInsertEventModal();
    this.cdr.markForCheck();
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
   * Les images sont passées en data URLs ({@code embeddedImageDataUrls}) pour éviter
   * les `blob:` (souvent perdus par Quill ou par la chaîne de sauvegarde).
   *
   * Compatible avec l'éditeur Quill et l'affichage HTML des commentaires.
   */
  private buildDefaultCommentText(m: AssistantChatTurn, embeddedImageDataUrls: string[]): string {
    const promptRaw = this.findPromptingUserText(m);
    const replyRaw = typeof m.content === 'string' ? m.content : '';
    const replyTextOnly = this.stripBlobGeneratedImagesFromContent(
      this.stripGeneratedImagesFromContent(replyRaw)
    ).trim();

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

    if (embeddedImageDataUrls.length > 0) {
      /**
       * On encapsule chaque image dans un `<a target="_blank">` pointant vers
       * la même data URL : le rendu HTML du commentaire (commentary-editor)
       * la limite en taille (max-height en CSS), mais un click sur l'image
       * l'ouvre alors en plein dans un nouvel onglet du navigateur.
       */
      const imagesHtml = embeddedImageDataUrls
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
     * On affiche toujours le modal de compression :
     *  - Si l'image est ≤ `app.imagemaxsizekb` (lu côté backend), le modal
     *    est en mode "info-only" : pas de switch, juste un message
     *    expliquant qu'aucune compression ne sera appliquée. Confirmation
     *    → `allowOriginal=true`.
     *  - Sinon, modal classique avec switch.
     */
    const choice = await this.askForInsertImageCompression(file.size);
    if (choice == null) {
      // Modal fermé/annulé : on annule l'insertion silencieusement.
      return;
    }
    // choice === true → compresser ; allowOriginal est l'inverse.
    const allowOriginal = !choice;

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
   * Ouvre le modal "Compresser l'image ?" pour une image générée que l'on
   * souhaite insérer dans un évènement. Réutilise les libellés
   * `EVENTELEM.IMAGE_COMPRESSION_*` déjà traduits pour le formulaire
   * d'évènement, afin de ne pas dupliquer de chaînes.
   *
   * Comportement :
   *  - Si `fileSizeBytes` ≤ `app.imagemaxsizekb` (paramètre backend lu via
   *    `UploadConfigService`), le modal est en mode "info-only" : pas de
   *    switch, juste un message expliquant qu'aucune compression ne sera
   *    appliquée et pourquoi. La résolution se fait via le bouton OK qui
   *    renvoie `false` (= ne pas compresser → `allowOriginal=true`).
   *  - Sinon, modal classique avec switch (mode 'normal').
   *
   * Retourne :
   *  - `true`  → l'utilisateur souhaite compresser (allowOriginal=false)
   *  - `false` → l'utilisateur veut envoyer en taille originale
   *  - `null`  → modal fermé/annulé : appelant doit interrompre l'envoi
   */
  private async askForInsertImageCompression(fileSizeBytes: number): Promise<boolean | null> {
    const thresholdKb = await this.uploadConfigService.resolveImageMaxSizeKb();
    this.compressInsertImage = true;
    this.insertImageSizeKb = Math.max(1, Math.round(fileSizeBytes / 1024));
    this.insertImageMaxSizeKb = thresholdKb;
    const thresholdBytes = thresholdKb * 1024;
    this.insertImageCompressionMode =
      Number.isFinite(fileSizeBytes) && fileSizeBytes <= thresholdBytes ? 'allUnder' : 'normal';

    return await new Promise<boolean | null>((resolve) => {
      if (!this.imageCompressionModal) {
        if (this.insertImageCompressionMode === 'allUnder') {
          resolve(false);
          return;
        }
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

  /** Confirme le choix de compression (bouton "Confirmer" du mode normal). */
  confirmInsertImageCompression(): void {
    if (this.imageCompressionModalRef) {
      this.imageCompressionModalRef.close(this.compressInsertImage);
    }
  }

  /**
   * Bouton « OK » du mode info-only (image déjà ≤ `app.imagemaxsizekb`) :
   * ferme avec « ne pas compresser » → `allowOriginal=true` côté backend.
   */
  confirmInsertImageCompressionInfoOnly(): void {
    if (this.imageCompressionModalRef) {
      this.imageCompressionModalRef.close(false);
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

  private revokeInsertImagePickObjectUrl(): void {
    if (!this.insertImagePickObjectUrl) {
      return;
    }
    try {
      URL.revokeObjectURL(this.insertImagePickObjectUrl);
    } catch {
      /* ignore */
    }
    this.insertImagePickObjectUrl = null;
  }

  private onInsertImageModalClosed(): void {
    this.revokeInsertImagePickObjectUrl();
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

  /**
   * Exporte l’historique visible en PDF : génération côté serveur (OpenHTMLToPDF + Markdown).
   */
  exportAssistantThreadPdf(ev?: MouseEvent): void {
    ev?.stopPropagation();
    if (!this.canShareAssistantWhatsApp()) {
      return;
    }
    this.runAssistantThreadPdfExport();
  }

  private runAssistantThreadPdfExport(): void {
    this.pdfExporting = true;
    this.cdr.markForCheck();
    this.buildAssistantPdfExportRequest$()
      .pipe(
        switchMap((payload) => this.assistant.exportThreadPdf(payload)),
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.pdfExporting = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (blob) => {
          const fname = this.buildAssistantPdfFilename();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = fname;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        },
        error: (err) => {
          console.error('assistant PDF export', err);
          window.alert(this.translate.instant('ASSISTANT.EXPORT_PDF_ERROR'));
        }
      });
  }

  private buildAssistantPdfFilename(): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const d = new Date();
    return `pat-assistant-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
      d.getHours()
    )}${pad(d.getMinutes())}.pdf`;
  }

  private buildAssistantPdfExportRequest$(): Observable<AssistantPdfExportRequest> {
    const youRaw = (this.chatUserLabel() || '').trim();
    const you = youRaw || this.translate.instant('ASSISTANT.YOU');
    const assistant = this.translate.instant('ASSISTANT.AI');
    return forkJoin(this.messages.map((m) => this.pdfExportTurn$(m))).pipe(
      map((turns) => ({
        title: this.translate.instant('ASSISTANT.TITLE'),
        exportedAt: new Date().toLocaleString(),
        youLabel: you,
        assistantLabel: assistant,
        turns
      }))
    );
  }

  /**
   * Même chaîne que WhatsApp / insertion évènement : garantit les images (blob + assets serveur).
   */
  private pdfEmbeddedImagesForAssistantTurn$(m: AssistantChatTurn): Observable<string[]> {
    return defer(() => from(this.assistantGeneratedImagesAsDataUrls(m)));
  }

  private pdfExportTurn$(m: AssistantChatTurn): Observable<AssistantPdfExportTurn> {
    if (m.role === 'user') {
      return of(this.buildUserTurnForPdfExport(m));
    }
    const pm = this.replyProviderModelLine(m).trim();
    let providerModelLine: string | undefined;
    if (pm.length > 0) {
      const line = this.translate
        .instant('ASSISTANT.SHARE_PROVIDER_MODEL_LINE', { providerModel: pm })
        .trim();
      if (line.length > 0) {
        providerModelLine = line;
      }
    }
    const stats = this.replyStatsLine(m).trim();
    let assistantBody = typeof m.content === 'string' ? m.content : '';
    const hasGenImg =
      this.extractGeneratedImageDataUrls(assistantBody).length > 0 ||
      this.extractGeneratedImageBlobUrls(assistantBody).length > 0 ||
      (m.generatedImageAssetIds?.length ?? 0) > 0;
    if (hasGenImg) {
      assistantBody = this.persistableAssistantText(assistantBody);
    }

    return this.pdfEmbeddedImagesForAssistantTurn$(m).pipe(
      map((embedded) => {
        let content = assistantBody;
        if (hasGenImg && embedded.length === 0) {
          const photoLine = this.translate.instant('ASSISTANT.TRANSCRIPT_PHOTO_LINE').trim();
          if (photoLine.length > 0) {
            content = content ? `${content}\n${photoLine}` : photoLine;
          }
        }
        const row: AssistantPdfExportTurn = {
          role: 'assistant',
          content,
          ...(providerModelLine ? { providerModelLine } : {}),
          ...(stats ? { statsLine: stats } : {}),
          ...(embedded.length > 0 ? { embeddedImageDataUrls: embedded } : {})
        };
        return row;
      })
    );
  }

  private buildUserTurnForPdfExport(m: AssistantChatTurn): AssistantPdfExportTurn {
    let body = typeof m.content === 'string' ? m.content.trim() : '';
    const embedded: string[] = [];
    if (m.imageDataUrl?.trim()) {
      embedded.push(m.imageDataUrl.trim());
    }
    if (m.hasImage && embedded.length === 0) {
      const imageNote = this.translate.instant('ASSISTANT.IMAGE_SENT_NOTE');
      body = body ? `${body}\n${imageNote}` : imageNote;
    }
    return {
      role: 'user',
      content: body,
      ...(m.hasImage ? { hasImage: true } : {}),
      ...(embedded.length > 0 ? { embeddedImageDataUrls: embedded } : {})
    };
  }

  openWhatsAppShareModal(): void {
    if (!this.canShareAssistantWhatsApp()) {
      return;
    }
    this.whatsappShareMessage = '';
    this.whatsappShareTranscriptMode = 'full';
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

  /** Ligne « fournisseur / modèle » pour partage WhatsApp : italique (`_…_`). */
  private shareProviderModelLineForWhatsApp(providerModel: string): string {
    const trimmed = (providerModel ?? '').trim();
    if (!trimmed) {
      return '';
    }
    const line = this.translate
      .instant('ASSISTANT.SHARE_PROVIDER_MODEL_LINE', { providerModel: trimmed })
      .trim();
    if (!line) {
      return '';
    }
    return `_${line}_`;
  }

  /**
   * Corps du message de partage : historique selon {@link whatsappShareTranscriptMode}.
   * Les images sont envoyées en pièces jointes via {@link confirmAssistantWhatsAppShare} en parallèle.
   */
  private suggestWhatsAppShareBodyRaw(): string {
    return this.buildAssistantTranscriptPlain(this.whatsappShareTranscriptMode === 'full');
  }

  private buildAssistantTranscriptPlain(includeUserMessages: boolean): string {
    const you = this.translate.instant('ASSISTANT.YOU');
    const ai = this.translate.instant('ASSISTANT.AI');
    const imageNote = this.translate.instant('ASSISTANT.IMAGE_SENT_NOTE');
    const photoInShare = this.translate.instant('ASSISTANT.TRANSCRIPT_PHOTO_LINE');
    const chunks: string[] = [];
    for (const m of this.messages) {
      if (!includeUserMessages && m.role === 'user') {
        continue;
      }
      const label = m.role === 'user' ? you : ai;
      let body = typeof m.content === 'string' ? m.content.trim() : '';
      if (m.role === 'user' && m.hasImage && !m.imageDataUrl) {
        body = body ? `${body}\n${imageNote}` : imageNote;
      } else if (m.role === 'user' && m.imageDataUrl?.trim()) {
        const line = photoInShare.trim();
        if (line.length > 0) {
          body = body ? `${body}\n${line}` : line;
        }
      } else if (m.role === 'assistant') {
        const hasEmbedded =
          this.extractGeneratedImageDataUrls(body).length > 0 ||
          this.extractGeneratedImageBlobUrls(body).length > 0 ||
          (m.generatedImageAssetIds?.length ?? 0) > 0;
        if (hasEmbedded) {
          body = this.stripBlobGeneratedImagesFromContent(
            this.stripGeneratedImagesFromContent(body)
          ).trim();
          const line = photoInShare.trim();
          if (line.length > 0) {
            body = body ? `${body}\n${line}` : line;
          }
        }
        const pm = this.replyProviderModelLine(m).trim();
        if (pm.length > 0) {
          const suffix = this.shareProviderModelLineForWhatsApp(pm);
          body = body ? `${body}\n\n${suffix}` : suffix;
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
    this.whatsappShareTranscriptMode = 'full';
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
        for (const u of this.extractGeneratedImageDataUrls(m.content)) {
          if (!seen.has(u)) {
            seen.add(u);
            out.push(u);
          }
        }
        for (const u of this.extractGeneratedImageBlobUrls(m.content)) {
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

  private async blobUrlToFile(blobUrl: string, fileName: string): Promise<File | null> {
    const u = blobUrl.trim();
    if (!u.startsWith('blob:')) {
      return null;
    }
    try {
      const resp = await fetch(u);
      const blob = await resp.blob();
      const type =
        blob.type && blob.type !== 'application/octet-stream'
          ? blob.type
          : 'image/png';
      return new File([blob], fileName, { type });
    } catch {
      return null;
    }
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

  /** Blob → data URL (fiable pour HTML commentaire / fichiers {@link File}). */
  private readBlobAsDataUrl(blob: Blob | null | undefined): Promise<string | null> {
    return new Promise((resolve) => {
      if (!blob || blob.size === 0) {
        resolve(null);
        return;
      }
      const fr = new FileReader();
      fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  }

  /**
   * Images générées d’un tour assistant en data URLs (WhatsApp, PDF, évènement, commentaire).
   * Ordre : data URLs dans le markdown → conversion des blob: locaux → **toujours** les assets
   * serveur ({@link generatedImageAssetIds}) en complément / secours (blob révoqué ou fetch raté).
   * Déduplication par chaîne data URL complète.
   */
  private async assistantGeneratedImagesAsDataUrls(m: AssistantChatTurn): Promise<string[]> {
    if (m.role !== 'assistant') {
      return [];
    }
    const raw = typeof m.content === 'string' ? m.content : '';
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (du: string | null | undefined): void => {
      const t = (du ?? '').trim();
      if (!t.startsWith('data:image/') || seen.has(t)) {
        return;
      }
      seen.add(t);
      out.push(t);
    };

    for (const u of this.extractGeneratedImageDataUrls(raw)) {
      add(u);
    }

    const blobUrls = this.extractGeneratedImageBlobUrls(raw);
    for (const u of blobUrls) {
      const file = await this.blobUrlToFile(u.trim(), 'pat-asst-img');
      if (!file) {
        continue;
      }
      add(await this.readBlobAsDataUrl(file));
    }

    for (const aid of m.generatedImageAssetIds ?? []) {
      const id = aid?.trim();
      if (!id) {
        continue;
      }
      try {
        const blob = await firstValueFrom(this.assistant.getConversationAssetBlob(id));
        add(await this.readBlobAsDataUrl(blob));
      } catch {
        /* ignore */
      }
    }

    return out;
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

    const includeUserContent = this.whatsappShareTranscriptMode === 'full';
    const imageFiles: File[] = [];
    const seenImageKeys = new Set<string>();
    let imgIdx = 0;
    for (const m of this.messages) {
      if (m.role === 'user' && includeUserContent && m.imageDataUrl?.trim()) {
        const url = m.imageDataUrl.trim();
        if (seenImageKeys.has(url)) {
          continue;
        }
        seenImageKeys.add(url);
        const file = await this.dataUrlToFile(url, `pat-assistant-photo-${imgIdx++}`);
        if (file) {
          imageFiles.push(file);
        }
      } else if (m.role === 'assistant') {
        const urls = await this.assistantGeneratedImagesAsDataUrls(m);
        for (const url of urls) {
          if (seenImageKeys.has(url)) {
            continue;
          }
          seenImageKeys.add(url);
          const file = await this.dataUrlToFile(url, `pat-assistant-generated-${imgIdx++}`);
          if (file) {
            imageFiles.push(file);
          }
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
        try {
          await nav.share({ title, text: message, files: imageFiles });
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
    this.whatsappShareTranscriptMode = 'full';
    window.open(`https://wa.me/?text=${encodeURIComponent(waText)}`, '_blank');
    this.cdr.markForCheck();
  }
}

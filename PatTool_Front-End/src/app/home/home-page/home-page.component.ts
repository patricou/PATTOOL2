import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostListener, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MonoTypeOperatorFunction, Subscription, forkJoin, from, of } from 'rxjs';
import { catchError, map, switchMap, take, tap } from 'rxjs/operators';

import { Body, Observer, SearchRiseSet } from 'astronomy-engine';

import { environment } from '../../../environments/environment';
import { CalendarEntry, CalendarService } from '../../calendar/calendar.service';
import { CLOCK_FACES, ClockComponent } from '../../clock/clock.component';
import { isMediaSkin, MEDIA_SKIN_IDS, MediaSkinId, readMediaSkin, writeMediaSkin } from '../../services/media-skin';
import { secureAssetUrl } from '../../radio-watcher/radio-pip.util';
import { DeezerKeepAliveService } from '../../deezer-watcher/deezer-keep-alive.service';
import { ApiService, NewsSourcePreference, RadioStation, TvChannel } from '../../services/api.service';
import { MembersService } from '../../services/members.service';
import { FileService } from '../../services/file.service';
import { PositionService } from '../../services/position.service';
import { RadioPlayerService } from '../../services/radio-player.service';
import { TvPlayerService } from '../../services/tv-player.service';
import { YoutubePlayerService } from '../../services/youtube-player.service';
import { NewsTickerService } from '../../services/news-ticker.service';
import { TodoDashboardList, TodoListService } from '../../todolists/todolist.service';
import { HomeDashboardCacheService } from '../home-dashboard-cache.service';
import { UserInfoModalService } from '../../services/user-info-modal.service';
import { WeatherPointTimelineComponent } from '../../shared/weather-point-timeline/weather-point-timeline.component';
import { TraceViewerModalComponent } from '../../shared/trace-viewer-modal/trace-viewer-modal.component';
import { resolveWeatherStationProvider } from '../../shared/weather-station-map.util';

type CardState = 'loading' | 'ready' | 'empty' | 'error';

interface DashAgendaItem {
	title: string;
	when: string;
	owner: string;
	kindLabel: string;
	route: string[];
	queryParams: Record<string, string> | null;
	thumbId: string;
	thumb: string;
	/** Days until the activity starts. Negative means it has already started. */
	daysLeft: number | null;
}

interface DashTaskItem {
	title: string;
	listName: string;
	listId: string;
	itemId: string;
	when: string;
	assignee: string;
	owner: string;
	overdue: boolean;
}

interface DashNewsItem {
	title: string;
	url: string;
	source: string;
	image: string;
	when: string;
}

interface DashPlaying {
	sourceKey: string;
	title: string;
	detail: string;
	route: string;
	logo: string;
}

const CLOCK_PREFS_KEY = 'pattool.clock.prefs';
const NEWS_FILTERS_KEY = 'pat.news.filters.v6';
const NEWS_FILTERS_LEGACY_KEY = 'pat.news.filters.v5';
type NewsProviderId = 'newsdata' | 'newsapi' | 'rss';
const AGENDA_DAYS = 369;
const APPOINTMENT_LIMIT = 10;
const TASK_LIMIT = 24;
const NEWS_LIMIT = 24;

const ILLUSION_SKINS: readonly MediaSkinId[] = [
	'kanizsa', 'cafewall', 'penrose', 'scintille', 'barber',
	'ebbinghaus', 'zollner', 'necker', 'ouchi', 'ehrenstein'
];

const SCENE_SKINS: readonly MediaSkinId[] = [
	'atelier', 'glacier', 'encre', 'chaux', 'abysse'
];

const LANG_FLAGS: Record<string, string> = {
	fr: 'fr',
	en: 'gb',
	es: 'es',
	de: 'de',
	it: 'it',
	ar: 'sa',
	cn: 'cn',
	ru: 'ru',
	jp: 'jp',
	he: 'il',
	el: 'gr',
	in: 'in'
};

@Component({
	selector: 'app-home-page',
	standalone: true,
	imports: [CommonModule, TranslateModule, RouterLink, ClockComponent, WeatherPointTimelineComponent, TraceViewerModalComponent],
	templateUrl: './home-page.component.html',
	styleUrls: ['../../radio-watcher/radio-skins.css', './home-page.component.css'],
	host: {
		'[class.radio-skin--classic]': 'radioSkin === "classic"',
		'[class.radio-skin--artdeco]': 'radioSkin === "artdeco"',
		'[class.radio-skin--synthwave]': 'radioSkin === "synthwave"',
		'[class.radio-skin--spaceage]': 'radioSkin === "spaceage"',
		'[class.radio-skin--military]': 'radioSkin === "military"',
		'[class.radio-skin--steampunk]': 'radioSkin === "steampunk"',
		'[class.radio-skin--aurora]': 'radioSkin === "aurora"',
		'[class.radio-skin--noir]': 'radioSkin === "noir"',
		'[class.radio-skin--bamboo]': 'radioSkin === "bamboo"',
		'[class.radio-skin--porcelain]': 'radioSkin === "porcelain"',
		'[class.radio-skin--carbon]': 'radioSkin === "carbon"',
		'[class.radio-skin--candy]': 'radioSkin === "candy"',
		'[class.radio-skin--espace]': 'radioSkin === "espace"',
		'[class.radio-skin--jazz]': 'radioSkin === "jazz"',
		'[class.radio-skin--sakura]': 'radioSkin === "sakura"',
		'[class.radio-skin--dune]': 'radioSkin === "dune"',
		'[class.radio-skin--lagoon]': 'radioSkin === "lagoon"',
		'[class.radio-skin--ember]': 'radioSkin === "ember"',
		'[class.radio-skin--atelier]': 'radioSkin === "atelier"',
		'[class.radio-skin--glacier]': 'radioSkin === "glacier"',
		'[class.radio-skin--encre]': 'radioSkin === "encre"',
		'[class.radio-skin--chaux]': 'radioSkin === "chaux"',
		'[class.radio-skin--abysse]': 'radioSkin === "abysse"',
		'[class.radio-skin--kanizsa]': 'radioSkin === "kanizsa"',
		'[class.radio-skin--cafewall]': 'radioSkin === "cafewall"',
		'[class.radio-skin--penrose]': 'radioSkin === "penrose"',
		'[class.radio-skin--scintille]': 'radioSkin === "scintille"',
		'[class.radio-skin--barber]': 'radioSkin === "barber"',
		'[class.radio-skin--ebbinghaus]': 'radioSkin === "ebbinghaus"',
		'[class.radio-skin--zollner]': 'radioSkin === "zollner"',
		'[class.radio-skin--necker]': 'radioSkin === "necker"',
		'[class.radio-skin--ouchi]': 'radioSkin === "ouchi"',
		'[class.radio-skin--ehrenstein]': 'radioSkin === "ehrenstein"'
	}
})
export class HomePageComponent implements OnInit, AfterViewInit, OnDestroy {

	@ViewChild('dashNow') dashNow?: ElementRef<HTMLElement>;
	@ViewChild('dashRefresh') dashRefresh?: ElementRef<HTMLButtonElement>;
	@ViewChild(TraceViewerModalComponent) mapViewer?: TraceViewerModalComponent;

	langOpen = false;
	skinMenuOpen = false;
	radioSkin: MediaSkinId = 'classic';
	readonly langs = environment.langs;
	readonly illusionSkins = ILLUSION_SKINS;
	readonly sceneSkins = SCENE_SKINS;
	clockFace = 'classic';

	weatherState: CardState = 'loading';
	weatherTemp = '';
	weatherPlace = '';
	weatherDesc = '';
	weatherFeels = '';
	weatherHumidity = '';
	weatherLat: number | null = null;
	weatherLon: number | null = null;
	weatherAltitude: number | null = null;
	weatherRegion: 'france' | 'switzerland' = 'france';
	weatherClim = false;
	weatherTempC: number | null = null;
	weatherObservedAt = '';
	weatherSunriseAt: Date | null = null;
	weatherSunsetAt: Date | null = null;
	private sunKey = '';
	userLabel = '';
	userLogin = '';
	userSeen = '';
	/** Street address from the device GPS, or the postal place when only the network location is known. */
	userAddress = '';
	private weatherFromGps = false;
	private weatherFix = 0;

	agendaState: CardState = 'loading';
	activities: DashAgendaItem[] = [];
	appointments: DashAgendaItem[] = [];
	agendaExtra = 0;

	taskState: CardState = 'loading';
	tasks: DashTaskItem[] = [];

	playing: DashPlaying | null = null;
	tvLogo = '';

	newsState: CardState = 'loading';
	/** Bound in the template. Updated after the current check so a late news result cannot throw NG0100. */
	newsViewState: CardState = 'loading';
	news: DashNewsItem[] = [];
	readonly newsProviders: NewsProviderId[] = ['newsdata', 'newsapi', 'rss'];
	newsProvider: NewsProviderId = 'newsdata';
	newsRefreshing = false;
	weatherRefreshing = false;
	agendaRefreshing = false;
	taskRefreshing = false;
	playingRefreshing = false;
	private newsProviderPinned: NewsProviderId | null = null;
	private newsRequest = 0;

	private loadGen = 0;
	private inflight = 0;
	private skinChosen = false;
	private clockLocked = false;
	private skinLoadSub?: Subscription;
	private radioTrackKey = '';
	private radioNowSub?: Subscription;
	private clockTimer: ReturnType<typeof setTimeout> | null = null;
	private destroyed = false;
	private scrollGripPointer = -1;
	private scrollGripLastY = 0;
	private scrollGripShift = 0;
	private readonly subs = new Subscription();
	private cacheEpoch = 0;

	private get activityThumbs(): Map<string, string> {
		return this.cache.activityThumbs;
	}

	constructor(
		private api: ApiService,
		private position: PositionService,
		private members: MembersService,
		private files: FileService,
		private calendar: CalendarService,
		private todos: TodoListService,
		private radio: RadioPlayerService,
		private tv: TvPlayerService,
		private youtube: YoutubePlayerService,
		private deezer: DeezerKeepAliveService,
		private translate: TranslateService,
		private ticker: NewsTickerService,
		private cache: HomeDashboardCacheService,
		private zone: NgZone,
		private userInfoModal: UserInfoModalService,
		private hostEl: ElementRef<HTMLElement>,
		private cdr: ChangeDetectorRef
	) { }

	/**
	 * Asks Angular to re-check the view with each async result, so the page does not depend on
	 * zone.js to notice a late update. Without either one, the next dev-mode verification throws NG0100.
	 */
	private checked<T>(): MonoTypeOperatorFunction<T> {
		const mark = () => this.cdr.markForCheck();
		return tap({ next: mark, error: mark });
	}

	get weatherCoordsLabel(): string {
		if (this.weatherLat == null || this.weatherLon == null) {
			return '';
		}
		const fmt = (value: number) => value.toLocaleString(this.localeTag(), {
			minimumFractionDigits: 5,
			maximumFractionDigits: 5
		});
		return `${fmt(this.weatherLat)}°, ${fmt(this.weatherLon)}°`;
	}

	/** Local clock time of sunrise or sunset at the weather GPS position. */
	sunClock(date: Date | null): string {
		if (!date || Number.isNaN(date.getTime())) {
			return '';
		}
		const hours = date.getHours().toString().padStart(2, '0');
		const minutes = date.getMinutes().toString().padStart(2, '0');
		return `${hours}:${minutes}`;
	}

	/** Map viewer centered on the same position as the weather. */
	openUserMap(): void {
		const lat = this.weatherLat;
		const lon = this.weatherLon;
		if (lat == null || lon == null || !this.mapViewer) {
			return;
		}
		const label = this.userAddress || this.weatherPlace;
		this.mapViewer.openAtLocation(lat, lon, label, undefined, false, false, { zoom: 14 });
		this.mapViewer.applyHostSkin(this.hostEl.nativeElement);
	}

	/** Same dialog as the surname in the navbar. */
	openUserInfo(): void {
		this.userInfoModal.open();
	}

	ngOnInit(): void {
		this.subs.add(this.radio.state$.pipe(this.checked()).subscribe(() => this.applyPlayback()));
		this.subs.add(this.youtube.state$.pipe(this.checked()).subscribe(() => this.applyPlayback()));
		this.subs.add(this.tv.state$.pipe(this.checked()).subscribe(() => this.applyPlayback()));
		this.subs.add(this.translate.onLangChange.pipe(this.checked()).subscribe(() => {
			this.writeNowLabel();
			this.refresh(false);
		}));
		this.restoreClock();
		this.restoreSkin();
		window.addEventListener('patradiolook', this.onSharedSkin);
		if (this.restoreFromCache()) {
			this.fillMissing();
		} else {
			this.refresh(false);
		}
	}

	@HostListener('document:click', ['$event'])
	onDocumentClick(event: MouseEvent): void {
		const target = event.target as HTMLElement | null;
		if (this.langOpen && !target?.closest('.home-lang')) {
			this.langOpen = false;
		}
		if (this.skinMenuOpen && !target?.closest('.radio-skin-picker')) {
			this.skinMenuOpen = false;
		}
	}

	get currentLang(): string {
		return (this.translate.currentLang || this.translate.getDefaultLang() || 'fr').toLowerCase();
	}

	get newsProviderKey(): string {
		return this.newsProvider === 'newsapi'
			? 'NEWS.PROVIDER_NEWSAPI'
			: this.newsProvider === 'rss'
				? 'NEWS.PROVIDER_RSS'
				: 'NEWS.PROVIDER_NEWSDATA';
	}

	newsProviderLabel(provider: NewsProviderId): string {
		return provider === 'newsapi'
			? 'NEWS.PROVIDER_NEWSAPI'
			: provider === 'rss'
				? 'NEWS.PROVIDER_RSS'
				: 'NEWS.PROVIDER_NEWSDATA';
	}

	chooseNewsProvider(provider: NewsProviderId): void {
		this.newsProvider = provider;
		this.newsProviderPinned = provider;
		const local = this.readNewsFilters();
		this.writeNewsProvider(provider);
		const feed = provider === 'rss' ? (local.feeds[0] || '') : '';
		this.subs.add(this.api.setNewsSourcePreference({
			provider,
			rssFeedUrl: feed
		}).pipe(take(1)).subscribe({ error: () => undefined }));
		this.ticker.notifyFiltersChanged();
		this.loadNews(this.loadGen, false, provider);
	}

	get clockLabelKey(): string {
		return CLOCK_FACES.find((face) => face.id === this.clockFace)?.labelKey || 'CLOCK.TITLE';
	}

	flagCode(lang: string): string {
		return LANG_FLAGS[lang.toLowerCase()] || lang.toLowerCase();
	}

	toggleLang(event: Event): void {
		event.stopPropagation();
		this.skinMenuOpen = false;
		this.langOpen = !this.langOpen;
	}

	get sortedSkins(): MediaSkinId[] {
		const pinned = new Set<string>([...ILLUSION_SKINS, ...SCENE_SKINS]);
		const lang = this.translate.currentLang || this.translate.getDefaultLang() || 'fr';
		return MEDIA_SKIN_IDS.filter((skin) => !pinned.has(skin)).sort((a, b) =>
			this.translate.instant(this.skinNameKey(a)).localeCompare(
				this.translate.instant(this.skinNameKey(b)),
				lang,
				{ sensitivity: 'base' }
			)
		);
	}

	trackSkin(_index: number, skin: MediaSkinId): string {
		return skin;
	}

	skinNameKey(skin: string): string {
		return 'RADIO.SKIN_' + skin.toUpperCase();
	}

	skinDescKey(skin: string): string {
		return 'RADIO.SKIN_' + skin.toUpperCase() + '_DESC';
	}

	toggleSkinMenu(event: Event): void {
		event.stopPropagation();
		this.langOpen = false;
		this.skinMenuOpen = !this.skinMenuOpen;
	}

	setSkin(skin: MediaSkinId): void {
		this.radioSkin = skin;
		this.skinMenuOpen = false;
		this.skinChosen = true;
		writeMediaSkin(skin);
		this.skinLoadSub?.unsubscribe();
		this.skinLoadSub = this.api.saveRadioSkin(skin).pipe(catchError(() => of(null))).subscribe();
	}

	chooseLang(lang: string): void {
		this.langOpen = false;
		if (lang !== this.currentLang) {
			this.translate.use(lang);
		}
	}

	/** Side grip: drag scrolls the page, then the grip springs back to mid-screen. */
	onScrollGripDown(event: PointerEvent): void {
		if (event.pointerType === 'mouse' && event.button !== 0) {
			return;
		}
		event.preventDefault();
		const grip = event.currentTarget as HTMLElement;
		grip.setPointerCapture(event.pointerId);
		this.scrollGripPointer = event.pointerId;
		this.scrollGripLastY = event.clientY;
		this.scrollGripShift = 0;
		grip.classList.add('is-dragging');
	}

	onScrollGripMove(event: PointerEvent): void {
		if (event.pointerId !== this.scrollGripPointer) {
			return;
		}
		event.preventDefault();
		const dy = event.clientY - this.scrollGripLastY;
		this.scrollGripLastY = event.clientY;
		const limit = Math.min(window.innerHeight * 0.34, 200);
		this.scrollGripShift = Math.max(-limit, Math.min(limit, this.scrollGripShift + dy));
		this.scrollFromGrip(dy * 2.6);
		(event.currentTarget as HTMLElement).style.setProperty('--grip-shift', `${this.scrollGripShift}px`);
	}

	/** Scrolls the home page. The phone ignores window scrolling while a finger is down. */
	private scrollFromGrip(dy: number): void {
		const host = this.hostEl.nativeElement;
		const before = host.scrollTop;
		host.scrollTop = before + dy;
		if (host.scrollTop !== before) {
			return;
		}
		const root = (document.scrollingElement || document.documentElement) as HTMLElement;
		const rootBefore = root.scrollTop;
		root.scrollTop = rootBefore + dy;
		if (root.scrollTop === rootBefore) {
			window.scrollBy(0, dy);
		}
	}

	onScrollGripUp(event: PointerEvent): void {
		if (event.pointerId !== this.scrollGripPointer) {
			return;
		}
		this.scrollGripPointer = -1;
		this.scrollGripShift = 0;
		const grip = event.currentTarget as HTMLElement;
		grip.classList.remove('is-dragging');
		grip.style.setProperty('--grip-shift', '0px');
	}

	ngOnDestroy(): void {
		this.destroyed = true;
		if (this.clockTimer) {
			clearTimeout(this.clockTimer);
		}
		window.removeEventListener('patradiolook', this.onSharedSkin);
		this.skinLoadSub?.unsubscribe();
		this.radioNowSub?.unsubscribe();
		this.subs.unsubscribe();
	}

	private readonly onSharedSkin = (): void => {
		const next = readMediaSkin();
		if (!next || next === this.radioSkin) {
			return;
		}
		this.radioSkin = next;
		this.skinChosen = true;
		this.cdr.markForCheck();
	};

	private restoreSkin(): void {
		const local = readMediaSkin();
		this.radioSkin = local ?? 'classic';
		this.skinLoadSub = this.api.getRadioSkin().pipe(catchError(() => of(null)), this.checked()).subscribe((remote) => {
			if (this.skinChosen) {
				return;
			}
			if (isMediaSkin(remote)) {
				this.radioSkin = remote;
				writeMediaSkin(remote);
			} else if (local) {
				writeMediaSkin(local);
				this.subs.add(this.api.saveRadioSkin(local).pipe(catchError(() => of(null))).subscribe());
			}
		});
	}

	refresh(shuffleClock = true): void {
		if (shuffleClock) {
			this.clockLocked = true;
			this.pickClock();
		}
		const gen = ++this.loadGen;
		this.cacheEpoch = ++this.cache.epoch;
		this.inflight = 0;
		this.paintRefreshing();
		this.writeNowLabel();
		this.loadWeather(gen);
		this.loadUser();
		this.loadAgenda(gen);
		this.loadTasks(gen);
		this.loadNews(gen);
		this.applyPlayback();
	}

	/** Reload only the headlines. The title-bar refresh still reloads the whole page from the server. */
	refreshNews(): void {
		if (this.newsRefreshing) {
			return;
		}
		this.loadNews(this.loadGen, false);
	}

	refreshWeather(): void {
		if (this.weatherRefreshing) {
			return;
		}
		this.loadUser();
		this.loadWeather(this.loadGen, true);
	}

	refreshAgenda(): void {
		if (this.agendaRefreshing) {
			return;
		}
		this.loadAgenda(this.loadGen, true);
	}

	refreshTasks(): void {
		if (this.taskRefreshing) {
			return;
		}
		this.loadTasks(this.loadGen, true);
	}

	refreshPlaying(): void {
		if (this.playingRefreshing) {
			return;
		}
		this.playingRefreshing = true;
		this.radioTrackKey = '';
		this.radioNowSub?.unsubscribe();
		this.radioNowSub = undefined;
		this.applyPlayback();
		if (!this.radioNowSub) {
			this.playingRefreshing = false;
		}
	}

	hideNewsImage(item: DashNewsItem): void {
		item.image = '';
	}

	onClockClick(event: MouseEvent): void {
		const host = event.currentTarget as HTMLElement | null;
		const face = host?.querySelector('app-clock') as HTMLElement | null;
		const rect = (face ?? host)?.getBoundingClientRect();
		if (!rect || rect.width <= 0) {
			return;
		}
		const fromKeyboard = event.detail === 0;
		const step = fromKeyboard || event.clientX >= rect.left + rect.width / 2 ? 1 : -1;
		this.stepClock(step);
	}

	private stepClock(delta: number): void {
		const ids = CLOCK_FACES.map((face) => face.id);
		if (!ids.length) {
			return;
		}
		this.clockLocked = true;
		const index = Math.max(0, ids.indexOf(this.clockFace));
		this.clockFace = ids[(index + delta + ids.length) % ids.length];
		this.persistClockFace();
	}

	private restoreClock(): void {
		const local = this.knownFace(this.readStoredFace());
		if (local) {
			this.clockFace = local;
		}
		this.subs.add(this.api.getClockPreferences().pipe(take(1), this.checked()).subscribe((prefs) => {
			if (this.clockLocked) {
				return;
			}
			const remote = this.knownFace(prefs?.faceId);
			if (remote) {
				this.clockFace = remote;
				this.writeStoredFace(remote);
			}
		}));
	}

	private persistClockFace(): void {
		const face = this.knownFace(this.clockFace);
		if (!face) {
			return;
		}
		this.writeStoredFace(face);
		this.subs.add(this.api.saveClockFace(face).pipe(catchError(() => of(null)), take(1)).subscribe());
	}

	private knownFace(id: string | null | undefined): string {
		const face = (id || '').trim();
		return CLOCK_FACES.some((item) => item.id === face) ? face : '';
	}

	private readStoredFace(): string {
		try {
			const raw = localStorage.getItem(CLOCK_PREFS_KEY);
			if (!raw) {
				return '';
			}
			const prefs = JSON.parse(raw) as { faceId?: string };
			return prefs?.faceId || '';
		} catch {
			return '';
		}
	}

	private writeStoredFace(face: string): void {
		try {
			const raw = localStorage.getItem(CLOCK_PREFS_KEY);
			const prefs = raw ? JSON.parse(raw) as Record<string, unknown> : {};
			localStorage.setItem(CLOCK_PREFS_KEY, JSON.stringify({ ...(prefs || {}), faceId: face }));
		} catch {
			/* private mode */
		}
	}

	private pickClock(): void {
		const ids = CLOCK_FACES.map((face) => face.id);
		if (!ids.length) {
			return;
		}
		let next = ids[Math.floor(Math.random() * ids.length)];
		if (ids.length > 1 && next === this.clockFace) {
			next = ids[(ids.indexOf(next) + 1) % ids.length];
		}
		this.clockFace = next;
	}

	ngAfterViewInit(): void {
		this.writeNowLabel();
		this.paintRefreshing();
		this.zone.runOutsideAngular(() => this.armNowLabel());
	}

	/** The minute string is written on the node. A template binding changes during the dev-mode check and throws NG0100. */
	private writeNowLabel(): void {
		const el = this.dashNow?.nativeElement;
		if (!el || this.destroyed) {
			return;
		}
		const next = new Intl.DateTimeFormat(this.localeTag(), {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			hour: '2-digit',
			minute: '2-digit'
		}).format(new Date());
		if (el.textContent !== next) {
			el.textContent = next;
		}
		const day = new Date().toDateString();
		if (this.sunKey && !this.sunKey.endsWith(`|${day}`)) {
			this.zone.run(() => this.refreshSunTimes());
			this.cdr.markForCheck();
		}
	}

	private armNowLabel(): void {
		const wait = 60_000 - (Date.now() % 60_000) + 50;
		this.clockTimer = setTimeout(() => {
			this.clockTimer = null;
			if (this.destroyed) {
				return;
			}
			this.writeNowLabel();
			this.armNowLabel();
		}, wait);
	}

	private loadUser(): void {
		this.subs.add(this.members.getUserId({ skipGeolocation: true }).pipe(take(1), this.checked()).subscribe((member) => {
			const name = `${member?.firstName || ''} ${member?.lastName || ''}`.trim();
			const login = (member?.userName || '').trim();
			this.userLabel = name || login;
			this.userLogin = login && login !== this.userLabel ? login : '';
			const seen = member?.lastConnectionDate;
			this.userSeen = seen instanceof Date && !Number.isNaN(seen.getTime())
				? this.formatWhen(seen.toISOString(), true)
				: '';
			this.store();
		}));
	}

	private weatherQuiet = false;

	private loadWeather(gen: number, quiet = false): void {
		this.weatherQuiet = quiet;
		this.weatherRefreshing = quiet;
		this.weatherFromGps = false;
		if (this.weatherState === 'loading') {
			this.userAddress = '';
		}
		if (!quiet) {
			this.begin();
		}
		this.subs.add(this.weatherPosition().pipe(take(1), this.checked()).subscribe({
			next: (pos) => this.applyWeatherAt(gen, pos, false, quiet),
			error: () => {
				if (gen !== this.loadGen) {
					if (quiet) {
						this.weatherRefreshing = false;
					}
					return;
				}
				if (this.weatherState === 'loading') {
					this.weatherState = 'error';
				}
				this.finish(quiet ? 'weather' : false);
			}
		}));
		this.refineAddressFromDeviceGps(gen);
	}

	/** Ask the browser for GPS when it has not been decided yet, then replace the place with that fix. */
	private refineAddressFromDeviceGps(gen: number): void {
		this.subs.add(from(this.gpsPermissionState()).pipe(take(1)).subscribe((state) => {
			if (gen !== this.loadGen || state === 'granted' || state === 'denied') {
				return;
			}
			this.subs.add(this.position.getGpsPosition().pipe(take(1), this.checked()).subscribe((gps) => {
				if (!gps || gen !== this.loadGen) {
					return;
				}
				this.weatherFromGps = true;
				this.applyWeatherAt(gen, { ...gps, gps: true }, true, this.weatherQuiet);
			}));
		}));
	}

	private applyWeatherAt(
		gen: number,
		pos: { latitude: number; longitude: number; gps: boolean } | null,
		fromGps: boolean,
		quiet = false
	): void {
		if (gen !== this.loadGen) {
			if (quiet) {
				this.weatherRefreshing = false;
			}
			return;
		}
		if (fromGps) {
			this.weatherFromGps = true;
		} else if (this.weatherFromGps) {
			this.finish(quiet ? 'weather' : false);
			return;
		}
		if (!pos) {
			if (!fromGps) {
				if (this.weatherState === 'loading') {
					this.weatherState = 'empty';
					this.userAddress = '';
				}
				this.finish(quiet ? 'weather' : false);
			}
			return;
		}
		const lang = (this.translate.currentLang || 'fr').split('-')[0];
		this.subs.add(forkJoin({
			weather: this.api.getCurrentWeatherByCoordinates(pos.latitude, pos.longitude, null, 'open-meteo').pipe(
				catchError(() => of(null))
			),
			place: this.api.geocodeReverse(pos.latitude, pos.longitude, lang).pipe(
				catchError(() => of(null))
			)
		}).pipe(take(1), this.checked()).subscribe({
			next: ({ weather, place }) => {
				if (gen !== this.loadGen) {
					if (quiet) {
						this.weatherRefreshing = false;
					}
					return;
				}
				if (!fromGps && this.weatherFromGps) {
					this.finish(quiet ? 'weather' : false);
					return;
				}
				const city = this.cityLabel(place);
				const street = this.streetAddressLabel(place);
				if (city || street) {
					this.userAddress = street && street.toLowerCase() !== city.toLowerCase() ? street : '';
				}
				const res = weather as any;
				const temp = Number(res?.main?.temp);
				if (!res || res.error || !Number.isFinite(temp)) {
					if (!fromGps) {
						if (this.weatherState === 'loading') {
							this.weatherState = 'error';
						}
						this.finish(quiet ? 'weather' : false);
					} else if (quiet) {
						this.weatherRefreshing = false;
					}
					return;
				}
				const feels = Number(res?.main?.feels_like);
				const humidity = Number(res?.main?.humidity);
				const provider = this.weatherProvider(place, pos.latitude, pos.longitude);
				this.weatherTemp = this.formatDegrees(temp);
				this.weatherTempC = temp;
				this.weatherObservedAt = this.weatherObservedAtOf(res);
				this.weatherLat = pos.latitude;
				this.weatherLon = pos.longitude;
				this.weatherRegion = provider === 'ms' ? 'switzerland' : 'france';
				this.weatherClim = provider === 'mf';
				this.weatherPlace = city || street || this.coordLabel(pos.latitude, pos.longitude);
				this.loadWeatherAltitude(pos.latitude, pos.longitude);
				this.weatherDesc = String(res?.weather?.[0]?.description || '').trim();
				this.weatherFeels = Number.isFinite(feels)
					? this.translate.instant('HOME.DASHBOARD.FEELS', { temp: this.formatDegrees(feels) })
					: '';
				this.weatherHumidity = Number.isFinite(humidity)
					? this.translate.instant('HOME.DASHBOARD.HUMIDITY', {
						value: Math.round(humidity).toLocaleString(this.localeTag())
					})
					: '';
				this.refreshSunTimes();
				this.weatherState = 'ready';
				if (quiet) {
					this.weatherRefreshing = false;
				}
				if (!fromGps) {
					this.finish(quiet ? 'weather' : false);
				} else {
					this.store();
				}
			},
			error: () => {
				if (gen !== this.loadGen || fromGps) {
					if (quiet) {
						this.weatherRefreshing = false;
					}
					return;
				}
				if (this.weatherFromGps) {
					this.finish(quiet ? 'weather' : false);
					return;
				}
				if (this.weatherState === 'loading') {
					this.weatherState = 'error';
				}
				this.finish(quiet ? 'weather' : false);
			}
		}));
	}

	private loadAgenda(gen: number, quiet = false): void {
		const visible = this.agendaState !== 'loading';
		this.agendaRefreshing = quiet;
		if (!quiet) {
			this.begin();
		}
		const from = startOfToday();
		const to = new Date(from.getTime() + AGENDA_DAYS * 24 * 60 * 60 * 1000);
		this.calendar.invalidateEntriesCache();
		this.subs.add(this.calendar.getEntries(from, to).pipe(take(1), this.checked()).subscribe({
			next: (entries) => {
				if (gen !== this.loadGen) {
					if (quiet) {
						this.agendaRefreshing = false;
					}
					return;
				}
				const now = Date.now();
				const upcoming = (entries || [])
					.filter((entry) => this.entryIsUpcoming(entry, now))
					.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
				const activities = upcoming.filter((entry) => entry.kind === 'ACTIVITY');
				const appointments = upcoming.filter((entry) => entry.kind !== 'ACTIVITY');
				this.activities = activities.map((entry) => this.toAgendaItem(entry));
				this.appointments = appointments.slice(0, APPOINTMENT_LIMIT).map((entry) => this.toAgendaItem(entry));
				this.loadActivityThumbs();
				this.agendaExtra = Math.max(0, appointments.length - APPOINTMENT_LIMIT);
				this.agendaState = this.activities.length || this.appointments.length ? 'ready' : 'empty';
				this.agendaRefreshing = false;
				this.finish(quiet ? 'agenda' : false);
			},
			error: () => {
				if (gen !== this.loadGen) {
					if (quiet) {
						this.agendaRefreshing = false;
					}
					return;
				}
				if (!visible) {
					this.activities = [];
					this.appointments = [];
					this.loadActivityThumbs();
					this.agendaExtra = 0;
					this.agendaState = 'error';
				}
				this.agendaRefreshing = false;
				this.finish(quiet ? 'agenda' : false);
			}
		}));
	}

	private loadTasks(gen: number, quiet = false): void {
		const visible = this.taskState !== 'loading';
		this.taskRefreshing = quiet;
		if (!quiet) {
			this.begin();
		}
		this.subs.add(this.todos.listDashboard().pipe(
			take(1),
			catchError(() => of([] as TodoDashboardList[])),
			this.checked()
		).subscribe({
			next: (lists) => {
				if (gen !== this.loadGen) {
					if (quiet) {
						this.taskRefreshing = false;
					}
					return;
				}
				const today = startOfToday().getTime();
				const rows = this.openTasks(lists || [], today);
				this.tasks = rows.slice(0, TASK_LIMIT);
				this.taskState = this.tasks.length ? 'ready' : 'empty';
				this.taskRefreshing = false;
				this.finish(quiet ? 'tasks' : false);
			},
			error: () => {
				if (gen !== this.loadGen) {
					if (quiet) {
						this.taskRefreshing = false;
					}
					return;
				}
				if (!visible) {
					this.tasks = [];
					this.taskState = 'error';
				}
				this.taskRefreshing = false;
				this.finish(quiet ? 'tasks' : false);
			}
		}));
	}

	private loadNews(gen: number, replace = true, forcedProvider?: NewsProviderId): void {
		const request = ++this.newsRequest;
		const switching = !!forcedProvider;
		const visible = !switching && this.newsState !== 'loading';
		if (switching) {
			this.newsRefreshing = true;
			this.publishNewsState('loading', true);
			this.news = [];
		} else if (replace) {
			this.begin();
		} else {
			this.newsRefreshing = true;
		}
		const local = this.readNewsFilters();
		let choice = local;
		this.subs.add(this.api.getNewsSourcePreference().pipe(
			take(1),
			catchError(() => of(null)),
			switchMap((remote) => {
				choice = this.mergeNewsChoice(local, remote);
				if (forcedProvider) {
					const feeds = forcedProvider === 'rss' ? (choice.feeds.length ? choice.feeds : local.feeds) : [];
					choice = { ...choice, provider: forcedProvider, feeds };
				} else if (this.newsProviderPinned) {
					choice = { ...choice, provider: this.newsProviderPinned };
					this.newsProviderPinned = null;
				}
				if (request !== this.newsRequest) {
					return of(null);
				}
				this.newsProvider = choice.provider;
				this.cdr.markForCheck();
				const feeds = choice.provider === 'rss' ? choice.feeds : undefined;
				if (choice.mode === 'search' && choice.query) {
					return this.api.getEverything({
						provider: choice.provider,
						q: choice.query,
						language: choice.language,
						sortBy: choice.sortBy,
						pageSize: NEWS_LIMIT,
						feeds
					});
				}
				return this.api.getTopHeadlines({
					provider: choice.provider,
					country: choice.provider === 'rss' ? undefined : choice.country,
					category: choice.provider === 'rss' ? undefined : choice.category,
					q: choice.query,
					pageSize: NEWS_LIMIT,
					feeds
				});
			}),
			switchMap((resp: any) => {
				const articles = Array.isArray(resp?.articles) ? resp.articles : [];
				if (articles.length || choice.provider === 'rss' || choice.mode === 'search' || !choice.country) {
					return of(resp);
				}
				return this.api.getEverything({
					provider: choice.provider,
					q: this.headlineFallbackQuery(choice.country, choice.category, choice.query),
					language: choice.language || undefined,
					sortBy: 'publishedAt',
					pageSize: NEWS_LIMIT
				});
			}),
			this.checked()
		).subscribe({
			next: (resp: any) => {
				if (request !== this.newsRequest) {
					return;
				}
				this.newsRefreshing = false;
				if (!switching && gen !== this.loadGen) {
					return;
				}
				const articles = Array.isArray(resp?.articles) ? resp.articles : [];
				this.news = articles.slice(0, NEWS_LIMIT).map((article: any) => {
					const rawImage = String(article?.urlToImage || '').trim();
					return {
						title: String(article?.title || '').trim(),
						url: String(article?.url || '').trim(),
						source: this.shortSource(String(article?.source?.name || '')),
						image: rawImage ? environment.API_URL + 'external/news/image?u=' + encodeURIComponent(rawImage) : '',
						when: this.formatWhen(article?.publishedAt, true)
					};
				}).filter((item: DashNewsItem) => item.title && item.url);
				this.publishNewsState(this.news.length ? 'ready' : 'empty', false);
				if (replace && !switching) {
					this.end();
				} else {
					this.store();
				}
			},
			error: () => {
				if (request !== this.newsRequest) {
					return;
				}
				this.newsRefreshing = false;
				if (switching) {
					this.news = [];
					this.publishNewsState('error', false);
					this.store();
					return;
				}
				if (visible) {
					if (replace) {
						this.end();
					}
					return;
				}
				if (!replace || gen !== this.loadGen) {
					return;
				}
				this.news = [];
				this.publishNewsState('error', false);
				this.end();
			}
		}));
	}

	/** `immediate` is only for updates that happen before the view is checked. */
	private publishNewsState(state: CardState, immediate: boolean): void {
		this.newsState = state;
		if (immediate || this.newsViewState === state) {
			this.newsViewState = state;
			return;
		}
		this.zone.run(() => {
			setTimeout(() => {
				if (!this.destroyed) {
					this.newsViewState = this.newsState;
					this.cdr.markForCheck();
				}
			});
		});
	}

	private writeNewsProvider(provider: NewsProviderId): void {
		try {
			const raw = localStorage.getItem(NEWS_FILTERS_KEY) || localStorage.getItem(NEWS_FILTERS_LEGACY_KEY);
			const saved = raw ? JSON.parse(raw) : {};
			const next = saved && typeof saved === 'object' ? saved : {};
			next.provider = provider;
			localStorage.setItem(NEWS_FILTERS_KEY, JSON.stringify(next));
		} catch {
			/* localStorage indisponible */
		}
	}

	private headlineFallbackQuery(country: string, category: string, query: string): string {
		const typed = (query || '').trim();
		if (typed) {
			return typed;
		}
		const code = (country || '').trim().toUpperCase();
		let name = code;
		try {
			const label = new Intl.DisplayNames(['en'], { type: 'region' }).of(code);
			if (label && label.toUpperCase() !== code) {
				name = label;
			}
		} catch {
			name = code;
		}
		return category ? `${name} ${category}`.trim() : name;
	}

	private readNewsFilters(): {
		provider: NewsProviderId;
		country: string;
		category: string;
		language: string;
		query: string;
		mode: string;
		sortBy: 'publishedAt' | 'relevancy' | 'popularity';
		feeds: string[];
	} {
		const fallback = {
			provider: 'newsdata' as NewsProviderId,
			country: 'fr',
			category: '',
			language: 'fr',
			query: '',
			mode: 'headlines',
			sortBy: 'publishedAt' as const,
			feeds: [] as string[]
		};
		try {
			const raw = localStorage.getItem(NEWS_FILTERS_KEY) || localStorage.getItem(NEWS_FILTERS_LEGACY_KEY);
			if (!raw) {
				return fallback;
			}
			const saved = JSON.parse(raw);
			if (!saved || typeof saved !== 'object') {
				return fallback;
			}
			const provider: NewsProviderId = saved.provider === 'newsapi' || saved.provider === 'rss' || saved.provider === 'newsdata'
				? saved.provider
				: fallback.provider;
			const sortBy = saved.sortBy === 'relevancy' || saved.sortBy === 'popularity' || saved.sortBy === 'publishedAt'
				? saved.sortBy
				: fallback.sortBy;
			const feeds = Array.isArray(saved.rssFeedUrls)
				? saved.rssFeedUrls.map((url: unknown) => String(url || '').trim()).filter(Boolean)
				: [];
			return {
				provider,
				country: typeof saved.country === 'string' ? saved.country : fallback.country,
				category: typeof saved.category === 'string' ? saved.category : '',
				language: typeof saved.language === 'string' ? saved.language : fallback.language,
				query: typeof saved.query === 'string' ? saved.query.trim() : '',
				mode: saved.mode === 'search' ? 'search' : 'headlines',
				sortBy,
				feeds
			};
		} catch {
			return fallback;
		}
	}

	private mergeNewsChoice(
		local: ReturnType<HomePageComponent['readNewsFilters']>,
		remote: NewsSourcePreference | null
	): ReturnType<HomePageComponent['readNewsFilters']> {
		const provider: NewsProviderId = remote?.provider === 'newsapi' || remote?.provider === 'rss' || remote?.provider === 'newsdata'
			? remote.provider
			: local.provider;
		const remoteFeed = (remote?.rssFeedUrl || '').trim();
		const feeds = provider === 'rss'
			? (remoteFeed ? [remoteFeed] : local.feeds)
			: [];
		return { ...local, provider, feeds };
	}

	private applyPlayback(): void {
		const channel = this.liveTvChannel();
		this.tvLogo = channel ? this.httpLogo(channel.logo) : '';
		const track = this.deezer.currentTrack();
		if (track) {
			const videoThumb = this.api.youtubeVideoThumbUrl(track.videoId);
			const cover = secureAssetUrl(track.coverUrl);
			this.playing = {
				sourceKey: 'HOME.DASHBOARD.SOURCE_DEEZER',
				title: track.title,
				detail: track.artist,
				route: '/tools/deezer',
				logo: videoThumb || (cover.startsWith('http://') || cover.startsWith('https://') ? cover : '')
			};
			return;
		}
		const youtube = this.youtube.snapshot;
		const videoTitle = (youtube.item?.title || '').trim();
		if (youtube.open && videoTitle) {
			this.playing = {
				sourceKey: 'HOME.DASHBOARD.SOURCE_YOUTUBE',
				title: videoTitle,
				detail: (youtube.item?.channelTitle || '').trim(),
				route: '/tools/youtube',
				logo: ''
			};
			return;
		}
		if (channel?.name) {
			this.playing = {
				sourceKey: 'HOME.DASHBOARD.SOURCE_TV',
				title: channel.name,
				detail: (channel.group || '').trim(),
				route: '/tools/tv-watcher',
				logo: this.tvLogo
			};
			return;
		}
		const radio = this.radio.snapshot;
		const station = radio.open ? radio.station : null;
		if (station?.name) {
			const same = this.playing?.sourceKey === 'HOME.DASHBOARD.SOURCE_RADIO'
				&& this.playing.detail === station.name;
			const logo = this.radioLogo(station);
			this.playing = {
				sourceKey: 'HOME.DASHBOARD.SOURCE_RADIO',
				title: same ? this.playing!.title : station.name,
				detail: station.name,
				route: '/tools/radio-watcher',
				logo: same ? (this.playing!.logo || logo) : logo
			};
			this.fetchRadioTrack(station);
			return;
		}
		this.playing = null;
	}

	private liveTvChannel(): TvChannel | null {
		const state = this.tv.snapshot;
		const channel = state.channel || this.tv.osPipChannel;
		if (!channel?.name) {
			return null;
		}
		return state.open || this.tv.isOsPipActive() ? channel : null;
	}

	private httpLogo(raw: string | undefined): string {
		const logo = secureAssetUrl(raw);
		return logo.startsWith('https://') || logo.startsWith('http://') ? logo : '';
	}

	hidePlayingLogo(): void {
		if (this.playing) {
			this.playing = { ...this.playing, logo: '' };
		}
	}

	private radioLogo(station: RadioStation): string {
		return this.httpLogo(station.logo);
	}

	private fetchRadioTrack(station: RadioStation): void {
		const key = (station.streamUrl || station.id || '').trim();
		if (!key || (this.radioTrackKey === key && this.radioNowSub)) {
			return;
		}
		this.radioTrackKey = key;
		this.radioNowSub?.unsubscribe();
		this.radioNowSub = this.api.getRadioNowPlaying(station).pipe(take(1), this.checked()).subscribe({
			next: (res) => {
				this.playingRefreshing = false;
				if ((this.radio.snapshot.station?.streamUrl || '') !== (station.streamUrl || '')) {
					return;
				}
				const title = [res?.artist, res?.title].filter((part) => !!part && part.trim()).join(' — ')
					|| (res?.label || '').trim()
					|| station.name;
				this.playing = {
					sourceKey: 'HOME.DASHBOARD.SOURCE_RADIO',
					title,
					detail: station.name || '',
					route: '/tools/radio-watcher',
					logo: this.radioLogo(station)
				};
			},
			error: () => {
				this.playingRefreshing = false;
			}
		});
	}

	/** Device GPS when the browser already allows it. Otherwise the network location, so the page still opens immediately. */
	private weatherPosition() {
		return from(this.gpsAlreadyGranted()).pipe(
			switchMap((granted) => {
				const ip = this.position.getIpPosition().pipe(
					map((coords) => coords ? { ...coords, gps: false } : null),
					catchError(() => of(null))
				);
				if (!granted) {
					return ip;
				}
				return this.position.getGpsPosition().pipe(
					switchMap((coords) => coords ? of({ ...coords, gps: true }) : ip)
				);
			}),
			catchError(() => this.position.getIpPosition().pipe(
				map((coords) => coords ? { ...coords, gps: false } : null),
				catchError(() => of(null))
			))
		);
	}

	private async gpsAlreadyGranted(): Promise<boolean> {
		return (await this.gpsPermissionState()) === 'granted';
	}

	/** `unknown` when the browser has no Permissions API (typical on mobile Safari). */
	private async gpsPermissionState(): Promise<'granted' | 'prompt' | 'denied' | 'unknown'> {
		const query = navigator.permissions?.query;
		if (!query) {
			return 'unknown';
		}
		try {
			const status = await query.call(navigator.permissions, { name: 'geolocation' });
			if (status.state === 'granted' || status.state === 'prompt' || status.state === 'denied') {
				return status.state;
			}
			return 'unknown';
		} catch {
			return 'unknown';
		}
	}

	private entryIsUpcoming(entry: CalendarEntry, now: number): boolean {
		const end = Date.parse(entry.end || entry.start || '');
		const start = Date.parse(entry.start || '');
		if (Number.isFinite(end)) {
			return end >= now;
		}
		return Number.isFinite(start) && start >= now;
	}

	private toAgendaItem(entry: CalendarEntry): DashAgendaItem {
		const activity = entry.kind === 'ACTIVITY' && !!entry.id;
		return {
			title: (entry.title || '').trim() || '—',
			when: this.formatWhen(entry.start, false),
			owner: (entry.ownerName || '').trim(),
			kindLabel: this.translate.instant(activity ? 'CALENDAR.KIND_ACTIVITY' : 'CALENDAR.KIND_APPOINTMENT'),
			route: activity ? ['/photos'] : ['/calendrier'],
			queryParams: activity && entry.id ? { eventId: entry.id } : null,
			thumbId: activity ? (entry.thumbnailFileId || '').trim() : '',
			thumb: '',
			daysLeft: this.daysUntil(entry.start)
		};
	}

	private daysUntil(iso: string | null | undefined): number | null {
		const start = new Date(iso || '');
		if (Number.isNaN(start.getTime())) {
			return null;
		}
		const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
		return Math.round((startDay - startOfToday().getTime()) / 86_400_000);
	}

	private loadActivityThumbs(): void {
		const needed = new Set(this.activities.map((item) => item.thumbId).filter((id) => id));
		for (const [id, url] of this.activityThumbs) {
			if (!needed.has(id)) {
				URL.revokeObjectURL(url);
				this.activityThumbs.delete(id);
			}
		}
		for (const item of this.activities) {
			const cached = item.thumbId ? this.activityThumbs.get(item.thumbId) : '';
			if (cached) {
				item.thumb = cached;
			}
		}
		for (const id of needed) {
			if (this.activityThumbs.has(id)) {
				continue;
			}
			this.subs.add(this.files.getFileWallPreview(id, 128).pipe(
				take(1),
				catchError(() => of(null)),
				this.checked()
			).subscribe((res) => {
				if (!res) {
					return;
				}
				const url = URL.createObjectURL(new Blob([res], { type: 'image/jpeg' }));
				const previous = this.activityThumbs.get(id);
				if (previous) {
					URL.revokeObjectURL(previous);
				}
				this.activityThumbs.set(id, url);
				for (const item of this.activities) {
					if (item.thumbId === id) {
						item.thumb = url;
					}
				}
			}));
		}
	}

	private openTasks(lists: TodoDashboardList[], today: number): DashTaskItem[] {
		const rows: Array<DashTaskItem & { due: number | null }> = [];
		for (const list of lists) {
			if (list.status === 'done' || list.status === 'archived') {
				continue;
			}
			const owner = (list.ownerName || '').trim();
			for (const item of list.items || []) {
				if (!item || item.status === 'done' || item.status === 'archived') {
					continue;
				}
				const title = (item.title || '').trim();
				if (!title) {
					continue;
				}
				const due = this.dueStamp(item.dueDate);
				const overdue = due != null && due < today;
				rows.push({
					title,
					listName: (list.name || '').trim(),
					listId: (list.id || '').trim(),
					itemId: (item.id || '').trim(),
					when: due == null ? '' : this.formatDue(item.dueDate || ''),
					assignee: (item.assigneeName || '').trim(),
					owner,
					overdue,
					due
				});
			}
		}
		rows.sort((a, b) => {
			if (a.overdue !== b.overdue) {
				return a.overdue ? -1 : 1;
			}
			if (a.due == null && b.due == null) {
				return 0;
			}
			if (a.due == null) {
				return 1;
			}
			if (b.due == null) {
				return -1;
			}
			return a.due - b.due;
		});
		return rows;
	}

	private dueStamp(raw: string | null | undefined): number | null {
		if (!raw) {
			return null;
		}
		const day = /^\d{4}-\d{2}-\d{2}$/.test(raw);
		const parsed = new Date(day ? `${raw}T00:00:00` : raw).getTime();
		return Number.isNaN(parsed) ? null : parsed;
	}

	private formatDue(raw: string): string {
		const day = /^\d{4}-\d{2}-\d{2}$/.test(raw);
		const date = new Date(day ? `${raw}T12:00:00` : raw);
		if (Number.isNaN(date.getTime())) {
			return '';
		}
		const midnight = !day && date.getHours() === 0 && date.getMinutes() === 0;
		return new Intl.DateTimeFormat(this.localeTag(), day || midnight
			? { day: 'numeric', month: 'short' }
			: { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
		).format(date);
	}

	private formatWhen(iso: string | null | undefined, keepMidnight: boolean): string {
		const date = new Date(iso || '');
		if (Number.isNaN(date.getTime())) {
			return '';
		}
		const midnight = date.getHours() === 0 && date.getMinutes() === 0;
		const options: Intl.DateTimeFormatOptions = {
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			year: 'numeric'
		};
		if (keepMidnight || !midnight) {
			options.hour = '2-digit';
			options.minute = '2-digit';
		}
		return new Intl.DateTimeFormat(this.localeTag(), options).format(date);
	}

	private formatDegrees(value: number): string {
		return `${value.toLocaleString(this.localeTag(), { maximumFractionDigits: 1 })}°`;
	}

	/** City name shown beside the temperature. */
	private cityLabel(body: any): string {
		const address = body?.address && typeof body.address === 'object' ? body.address : {};
		const locality = this.firstAddressText(address, [
			'city', 'town', 'village', 'municipality', 'hamlet', 'suburb', 'locality'
		]);
		if (locality) {
			return locality;
		}
		const display = String(body?.displayName || body?.display_name || '').trim();
		const part = display.split(',')
			.map((item) => item.trim())
			.find((item) => item.length > 0 && !/^\d/.test(item));
		return part || '';
	}

	/** Number, street, postcode and city for the profile line. */
	private streetAddressLabel(body: any): string {
		const address = body?.address && typeof body.address === 'object' ? body.address : {};
		const house = this.firstAddressText(address, ['house_number', 'housenumber']);
		const road = this.firstAddressText(address, ['road', 'street', 'pedestrian', 'footway', 'path', 'residential']);
		const postcode = this.firstAddressText(address, ['postcode', 'postcodes']);
		const locality = this.cityLabel(body);
		const street = [house, road].filter((part) => part.length > 0).join(' ');
		const city = [postcode, locality].filter((part) => part.length > 0).join(' ');
		return [street, city].filter((part, index, all) =>
			part.length > 0 && all.findIndex((other) => other.toLowerCase() === part.toLowerCase()) === index
		).join(', ');
	}

	private firstAddressText(address: any, keys: string[]): string {
		for (const key of keys) {
			const raw = address?.[key];
			const value = Array.isArray(raw) ? raw[0] : raw;
			const text = String(value || '').trim();
			if (text) {
				return text;
			}
		}
		return '';
	}

	private weatherProvider(place: any, lat: number, lon: number): 'mf' | 'ms' | null {
		const address = place?.address && typeof place.address === 'object' ? place.address : {};
		let code = String(
			address.country_code ?? address.countryCode ?? place?.country_code ?? place?.countryCode ?? ''
		).trim().toUpperCase();
		if (code === 'CHE') {
			code = 'CH';
		} else if (code === 'FRA') {
			code = 'FR';
		}
		if (!code) {
			const country = String(address.country || '').trim().toLowerCase();
			if (/suisse|switzerland|schweiz|svizzera/.test(country)) {
				code = 'CH';
			} else if (country === 'france' || country.startsWith('france ')) {
				code = 'FR';
			}
		}
		return resolveWeatherStationProvider(lat, lon, code);
	}

	/** Today's sunrise and sunset for the GPS fix, including elevation once it is known. */
	private refreshSunTimes(): void {
		const lat = this.weatherLat;
		const lon = this.weatherLon;
		if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
			this.weatherSunriseAt = null;
			this.weatherSunsetAt = null;
			this.sunKey = '';
			return;
		}
		const alt = this.weatherAltitude != null && Number.isFinite(this.weatherAltitude) ? this.weatherAltitude : 0;
		const now = new Date();
		const key = `${lat.toFixed(5)}|${lon.toFixed(5)}|${Math.round(alt)}|${now.toDateString()}`;
		if (key === this.sunKey) {
			return;
		}
		this.sunKey = key;
		const observer = new Observer(lat, lon, alt);
		const dayStart = this.solarMidnight(now, lon);
		try {
			this.weatherSunriseAt = SearchRiseSet(Body.Sun, observer, +1, dayStart, 1.5)?.date ?? null;
			this.weatherSunsetAt = SearchRiseSet(Body.Sun, observer, -1, dayStart, 1.5)?.date ?? null;
		} catch {
			this.weatherSunriseAt = null;
			this.weatherSunsetAt = null;
		}
	}

	/** Approximate local solar midnight at the observer longitude. */
	private solarMidnight(date: Date, lon: number): Date {
		const lonMs = (lon / 15) * 3_600_000;
		const solar = new Date(date.getTime() + lonMs);
		const startUtc = Date.UTC(solar.getUTCFullYear(), solar.getUTCMonth(), solar.getUTCDate());
		return new Date(startUtc - lonMs);
	}

	private weatherObservedAtOf(weather: any): string {
		const raw = weather?.dt ?? weather?.time ?? weather?.current?.time;
		if (raw == null || raw === '') {
			return '';
		}
		return String(raw);
	}

	private loadWeatherAltitude(lat: number, lon: number): void {
		const fix = ++this.weatherFix;
		this.subs.add(this.api.getStationElevation(lat, lon).pipe(
			take(1),
			catchError(() => of(null)),
			this.checked()
		).subscribe((res) => {
			if (fix !== this.weatherFix) {
				return;
			}
			const alt = Number(res?.altitudeM);
			this.weatherAltitude = Number.isFinite(alt) ? alt : null;
			this.refreshSunTimes();
			this.store();
		}));
	}

	private coordLabel(lat: number, lon: number): string {
		const fmt = (value: number) => value.toLocaleString(this.localeTag(), { maximumFractionDigits: 2 });
		return `${fmt(lat)}°, ${fmt(lon)}°`;
	}

	private shortSource(name: string): string {
		const cut = name.split(/\s+[—–-]\s+/)[0].trim();
		return cut.length > 32 ? `${cut.slice(0, 31)}…` : cut;
	}

	private localeTag(): string {
		const lang = (this.translate.currentLang || this.translate.getDefaultLang() || 'fr').toLowerCase();
		const map: Record<string, string> = {
			fr: 'fr-FR',
			en: 'en-GB',
			de: 'de-DE',
			es: 'es-ES',
			it: 'it-IT',
			ar: 'ar',
			cn: 'zh-CN',
			jp: 'ja-JP',
			ru: 'ru-RU',
			he: 'he',
			el: 'el-GR',
			in: 'hi-IN'
		};
		return map[lang] || 'fr-FR';
	}

	private begin(): void {
		this.inflight++;
		this.paintRefreshing();
	}

	private end(): void {
		this.inflight = Math.max(0, this.inflight - 1);
		this.paintRefreshing();
		this.store();
	}

	/** The refresh button is updated on the node. A template binding changes during the dev-mode check and throws NG0100. */
	private paintRefreshing(): void {
		if (this.destroyed) {
			return;
		}
		const spinning = this.inflight > 0;
		const button = this.dashRefresh?.nativeElement;
		if (!button) {
			return;
		}
		button.disabled = spinning;
		button.querySelector('i')?.classList.toggle('fa-spin', spinning);
	}

	/** A card refresh updates the cache without spinning the title-bar button. */
	private finish(quiet: false | 'weather' | 'agenda' | 'tasks'): void {
		if (quiet === 'weather') {
			this.weatherRefreshing = false;
		} else if (quiet === 'agenda') {
			this.agendaRefreshing = false;
		} else if (quiet === 'tasks') {
			this.taskRefreshing = false;
		}
		if (quiet) {
			this.store();
			return;
		}
		this.end();
	}

	/** Show the previous visit immediately. Returns false when this language has never been loaded. */
	private restoreFromCache(): boolean {
		const snap = this.cache.snapshot;
		if (!snap || snap.lang !== this.currentLang) {
			return false;
		}
		const settled = [snap.weatherState, snap.agendaState, snap.taskState, snap.newsState]
			.some((state) => state !== 'loading');
		if (!settled && !snap.userLabel) {
			return false;
		}
		this.cacheEpoch = this.cache.epoch;
		this.weatherState = snap.weatherState;
		this.weatherTemp = snap.weatherTemp;
		this.weatherPlace = snap.weatherPlace;
		this.weatherDesc = snap.weatherDesc;
		this.weatherFeels = snap.weatherFeels;
		this.weatherHumidity = snap.weatherHumidity;
		this.weatherLat = snap.weatherLat ?? null;
		this.weatherLon = snap.weatherLon ?? null;
		this.weatherAltitude = snap.weatherAltitude ?? null;
		this.weatherRegion = snap.weatherRegion === 'switzerland' ? 'switzerland' : 'france';
		this.weatherClim = snap.weatherClim === true;
		this.weatherTempC = snap.weatherTempC ?? null;
		this.weatherObservedAt = snap.weatherObservedAt ?? '';
		this.refreshSunTimes();
		this.userAddress = snap.userAddress;
		this.userLabel = snap.userLabel;
		this.userLogin = snap.userLogin;
		this.userSeen = snap.userSeen;
		this.agendaState = snap.agendaState;
		this.activities = snap.activities;
		this.appointments = snap.appointments;
		this.agendaExtra = snap.agendaExtra;
		for (const item of this.activities) {
			if (item.thumbId) {
				item.thumb = this.activityThumbs.get(item.thumbId) || item.thumb;
			}
		}
		this.taskState = snap.taskState;
		this.tasks = snap.tasks;
		this.publishNewsState(snap.newsState, true);
		this.news = snap.news;
		this.newsProvider = snap.newsProvider;
		this.paintRefreshing();
		return true;
	}

	/** Finish any section that was still in flight when the page was left. */
	private fillMissing(): void {
		const gen = this.loadGen;
		if (this.weatherState === 'loading') {
			this.loadWeather(gen);
		}
		if (this.agendaState === 'loading') {
			this.loadAgenda(gen);
		}
		if (this.taskState === 'loading') {
			this.loadTasks(gen);
		}
		if (this.newsState === 'loading') {
			this.loadNews(gen);
		}
		if (!this.userLabel) {
			this.loadUser();
		}
	}

	private store(): void {
		if (this.cacheEpoch !== this.cache.epoch) {
			return;
		}
		const prev = this.cache.snapshot?.lang === this.currentLang ? this.cache.snapshot : null;
		const weatherReady = this.weatherState !== 'loading';
		const agendaReady = this.agendaState !== 'loading';
		const tasksReady = this.taskState !== 'loading';
		const newsReady = this.newsState !== 'loading';
		this.cache.snapshot = {
			lang: this.currentLang,
			weatherState: weatherReady ? this.weatherState : (prev?.weatherState ?? 'loading'),
			weatherTemp: weatherReady ? this.weatherTemp : (prev?.weatherTemp ?? ''),
			weatherPlace: weatherReady ? this.weatherPlace : (prev?.weatherPlace ?? ''),
			weatherDesc: weatherReady ? this.weatherDesc : (prev?.weatherDesc ?? ''),
			weatherFeels: weatherReady ? this.weatherFeels : (prev?.weatherFeels ?? ''),
			weatherHumidity: weatherReady ? this.weatherHumidity : (prev?.weatherHumidity ?? ''),
			weatherLat: weatherReady ? this.weatherLat : (prev?.weatherLat ?? null),
			weatherLon: weatherReady ? this.weatherLon : (prev?.weatherLon ?? null),
			weatherAltitude: weatherReady ? this.weatherAltitude : (prev?.weatherAltitude ?? null),
			weatherRegion: weatherReady ? this.weatherRegion : (prev?.weatherRegion ?? 'france'),
			weatherClim: weatherReady ? this.weatherClim : (prev?.weatherClim ?? false),
			weatherTempC: weatherReady ? this.weatherTempC : (prev?.weatherTempC ?? null),
			weatherObservedAt: weatherReady ? this.weatherObservedAt : (prev?.weatherObservedAt ?? ''),
			userAddress: weatherReady ? this.userAddress : (prev?.userAddress ?? ''),
			userLabel: this.userLabel || prev?.userLabel || '',
			userLogin: this.userLabel ? this.userLogin : (prev?.userLogin ?? ''),
			userSeen: this.userLabel ? this.userSeen : (prev?.userSeen ?? ''),
			agendaState: agendaReady ? this.agendaState : (prev?.agendaState ?? 'loading'),
			activities: agendaReady ? this.activities : (prev?.activities ?? []),
			appointments: agendaReady ? this.appointments : (prev?.appointments ?? []),
			agendaExtra: agendaReady ? this.agendaExtra : (prev?.agendaExtra ?? 0),
			taskState: tasksReady ? this.taskState : (prev?.taskState ?? 'loading'),
			tasks: tasksReady ? this.tasks : (prev?.tasks ?? []),
			newsState: newsReady ? this.newsState : (prev?.newsState ?? 'loading'),
			news: newsReady ? this.news : (prev?.news ?? []),
			newsProvider: newsReady ? this.newsProvider : (prev?.newsProvider ?? this.newsProvider)
		};
	}
}

function startOfToday(): Date {
	const date = new Date();
	date.setHours(0, 0, 0, 0);
	return date;
}

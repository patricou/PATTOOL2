import { Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription, forkJoin, from, of } from 'rxjs';
import { catchError, switchMap, take } from 'rxjs/operators';

import { environment } from '../../../environments/environment';
import { CalendarEntry, CalendarService } from '../../calendar/calendar.service';
import { CLOCK_FACES, ClockComponent } from '../../clock/clock.component';
import { isMediaSkin, MEDIA_SKIN_IDS, MediaSkinId, readMediaSkin, writeMediaSkin } from '../../services/media-skin';
import { secureAssetUrl } from '../../radio-watcher/radio-pip.util';
import { DeezerKeepAliveService } from '../../deezer-watcher/deezer-keep-alive.service';
import { ApiService, NewsSourcePreference, RadioStation, TvChannel } from '../../services/api.service';
import { Member } from '../../model/member';
import { MembersService } from '../../services/members.service';
import { FileService } from '../../services/file.service';
import { PositionService } from '../../services/position.service';
import { RadioPlayerService } from '../../services/radio-player.service';
import { TvPlayerService } from '../../services/tv-player.service';
import { YoutubePlayerService } from '../../services/youtube-player.service';
import { NewsTickerService } from '../../services/news-ticker.service';
import { TodoList, TodoListService } from '../../todolists/todolist.service';

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

const ILLUSION_SKINS: readonly MediaSkinId[] = ['kanizsa', 'cafewall', 'penrose', 'scintille', 'barber'];

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
	imports: [CommonModule, TranslateModule, RouterLink, ClockComponent],
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
		'[class.radio-skin--kanizsa]': 'radioSkin === "kanizsa"',
		'[class.radio-skin--cafewall]': 'radioSkin === "cafewall"',
		'[class.radio-skin--penrose]': 'radioSkin === "penrose"',
		'[class.radio-skin--scintille]': 'radioSkin === "scintille"',
		'[class.radio-skin--barber]': 'radioSkin === "barber"'
	}
})
export class HomePageComponent implements OnInit, OnDestroy {

	nowLabel = '';
	refreshing = false;
	langOpen = false;
	skinMenuOpen = false;
	radioSkin: MediaSkinId = 'classic';
	readonly langs = environment.langs;
	readonly illusionSkins = ILLUSION_SKINS;
	clockFace = 'classic';

	weatherState: CardState = 'loading';
	weatherTemp = '';
	weatherPlace = '';
	weatherDesc = '';
	weatherFeels = '';
	weatherHumidity = '';
	userLabel = '';
	userLogin = '';
	userSeen = '';

	agendaState: CardState = 'loading';
	activities: DashAgendaItem[] = [];
	appointments: DashAgendaItem[] = [];
	agendaExtra = 0;

	taskState: CardState = 'loading';
	tasks: DashTaskItem[] = [];

	playing: DashPlaying | null = null;
	tvLogo = '';

	newsState: CardState = 'loading';
	news: DashNewsItem[] = [];
	readonly newsProviders: NewsProviderId[] = ['newsdata', 'newsapi', 'rss'];
	newsProvider: NewsProviderId = 'newsdata';
	private newsProviderPinned: NewsProviderId | null = null;

	private loadGen = 0;
	private inflight = 0;
	private skinChosen = false;
	private clockLocked = false;
	private skinLoadSub?: Subscription;
	private radioTrackKey = '';
	private radioNowSub?: Subscription;
	private clockTimer: ReturnType<typeof setInterval> | null = null;
	private readonly subs = new Subscription();
	private readonly activityThumbs = new Map<string, string>();

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
		private ticker: NewsTickerService
	) { }

	ngOnInit(): void {
		this.tick();
		this.clockTimer = setInterval(() => this.tick(), 30_000);
		this.subs.add(this.radio.state$.subscribe(() => this.applyPlayback()));
		this.subs.add(this.youtube.state$.subscribe(() => this.applyPlayback()));
		this.subs.add(this.tv.state$.subscribe(() => this.applyPlayback()));
		this.subs.add(this.translate.onLangChange.subscribe(() => {
			this.tick();
			this.refresh(false);
		}));
		this.restoreClock();
		this.restoreSkin();
		window.addEventListener('patradiolook', this.onSharedSkin);
		this.refresh(false);
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
		if (provider === this.newsProvider) {
			return;
		}
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
		this.loadNews(this.loadGen);
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
		const pinned = new Set<string>(ILLUSION_SKINS);
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

	ngOnDestroy(): void {
		if (this.clockTimer) {
			clearInterval(this.clockTimer);
		}
		window.removeEventListener('patradiolook', this.onSharedSkin);
		this.skinLoadSub?.unsubscribe();
		this.radioNowSub?.unsubscribe();
		this.subs.unsubscribe();
		for (const url of this.activityThumbs.values()) {
			URL.revokeObjectURL(url);
		}
		this.activityThumbs.clear();
	}

	private readonly onSharedSkin = (): void => {
		if (this.skinChosen) {
			return;
		}
		const next = readMediaSkin();
		if (next && next !== this.radioSkin) {
			this.radioSkin = next;
		}
	};

	private restoreSkin(): void {
		const local = readMediaSkin();
		this.radioSkin = local ?? 'classic';
		this.skinLoadSub = this.api.getRadioSkin().pipe(catchError(() => of(null))).subscribe((remote) => {
			if (this.skinChosen) {
				return;
			}
			if (isMediaSkin(remote)) {
				this.radioSkin = remote;
				writeMediaSkin(remote);
			} else if (local) {
				writeMediaSkin(local);
				this.api.saveRadioSkin(local).pipe(catchError(() => of(null))).subscribe();
			}
		});
	}

	refresh(shuffleClock = true): void {
		if (shuffleClock) {
			this.clockLocked = true;
			this.pickClock();
		}
		const gen = ++this.loadGen;
		this.inflight = 0;
		this.refreshing = true;
		this.tick();
		this.loadWeather(gen);
		this.loadUser();
		this.loadAgenda(gen);
		this.loadTasks(gen);
		this.loadNews(gen);
		this.applyPlayback();
	}

	hideNewsImage(item: DashNewsItem): void {
		item.image = '';
	}

	nextClock(): void {
		this.clockLocked = true;
		this.pickClock();
		this.persistClockFace();
	}

	private restoreClock(): void {
		const local = this.knownFace(this.readStoredFace());
		if (local) {
			this.clockFace = local;
		}
		this.subs.add(this.api.getClockPreferences().pipe(take(1)).subscribe((prefs) => {
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

	private tick(): void {
		this.nowLabel = new Intl.DateTimeFormat(this.localeTag(), {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			hour: '2-digit',
			minute: '2-digit'
		}).format(new Date());
	}

	private loadUser(): void {
		this.members.getUserId({ skipGeolocation: true }).pipe(take(1)).subscribe((member) => {
			const name = `${member?.firstName || ''} ${member?.lastName || ''}`.trim();
			const login = (member?.userName || '').trim();
			this.userLabel = name || login;
			this.userLogin = login && login !== this.userLabel ? login : '';
			const seen = member?.lastConnectionDate;
			this.userSeen = seen instanceof Date && !Number.isNaN(seen.getTime())
				? this.formatWhen(seen.toISOString(), true)
				: '';
		});
	}

	private loadWeather(gen: number): void {
		this.weatherState = 'loading';
		this.begin();
		this.weatherPosition().pipe(take(1)).subscribe({
			next: (pos) => {
				if (gen !== this.loadGen) {
					return;
				}
				if (!pos) {
					this.weatherState = 'empty';
					this.end();
					return;
				}
				const lang = (this.translate.currentLang || 'fr').split('-')[0];
				forkJoin({
					weather: this.api.getCurrentWeatherByCoordinates(pos.latitude, pos.longitude, null, 'open-meteo').pipe(
						catchError(() => of(null))
					),
					place: this.api.geocodeReverse(pos.latitude, pos.longitude, lang).pipe(
						catchError(() => of(null))
					)
				}).pipe(take(1)).subscribe({
						next: ({ weather, place }) => {
							if (gen !== this.loadGen) {
								return;
							}
							const res = weather as any;
							const temp = Number(res?.main?.temp);
							if (!res || res.error || !Number.isFinite(temp)) {
								this.weatherState = 'error';
								this.end();
								return;
							}
							const feels = Number(res?.main?.feels_like);
							const humidity = Number(res?.main?.humidity);
							this.weatherTemp = this.formatDegrees(temp);
							this.weatherPlace = this.placeLabel(place) || this.coordLabel(pos.latitude, pos.longitude);
							this.weatherDesc = String(res?.weather?.[0]?.description || '').trim();
							this.weatherFeels = Number.isFinite(feels)
								? this.translate.instant('HOME.DASHBOARD.FEELS', { temp: this.formatDegrees(feels) })
								: '';
							this.weatherHumidity = Number.isFinite(humidity)
								? this.translate.instant('HOME.DASHBOARD.HUMIDITY', {
									value: Math.round(humidity).toLocaleString(this.localeTag())
								})
								: '';
							this.weatherState = 'ready';
							this.end();
						},
						error: () => {
							if (gen !== this.loadGen) {
								return;
							}
							this.weatherState = 'error';
							this.end();
						}
					});
			},
			error: () => {
				if (gen !== this.loadGen) {
					return;
				}
				this.weatherState = 'error';
				this.end();
			}
		});
	}

	private loadAgenda(gen: number): void {
		this.agendaState = 'loading';
		this.begin();
		const from = startOfToday();
		const to = new Date(from.getTime() + AGENDA_DAYS * 24 * 60 * 60 * 1000);
		this.calendar.invalidateEntriesCache();
		this.calendar.getEntries(from, to).pipe(take(1)).subscribe({
			next: (entries) => {
				if (gen !== this.loadGen) {
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
				this.end();
			},
			error: () => {
				if (gen !== this.loadGen) {
					return;
				}
				this.activities = [];
				this.appointments = [];
				this.loadActivityThumbs();
				this.agendaExtra = 0;
				this.agendaState = 'error';
				this.end();
			}
		});
	}

	private loadTasks(gen: number): void {
		this.taskState = 'loading';
		this.begin();
		forkJoin({
			lists: this.todos.listAccessible().pipe(catchError(() => of([] as TodoList[]))),
			members: this.members.getListMembers().pipe(catchError(() => of([] as Member[])))
		}).pipe(take(1)).subscribe({
			next: ({ lists, members }) => {
				if (gen !== this.loadGen) {
					return;
				}
				const today = startOfToday().getTime();
				const rows = this.openTasks(lists || [], today, this.memberNames(members || []));
				this.tasks = rows.slice(0, TASK_LIMIT);
				this.taskState = this.tasks.length ? 'ready' : 'empty';
				this.end();
			},
			error: () => {
				if (gen !== this.loadGen) {
					return;
				}
				this.tasks = [];
				this.taskState = 'error';
				this.end();
			}
		});
	}

	private loadNews(gen: number): void {
		this.newsState = 'loading';
		this.begin();
		const local = this.readNewsFilters();
		let choice = local;
		this.api.getNewsSourcePreference().pipe(
			take(1),
			catchError(() => of(null)),
			switchMap((remote) => {
				choice = this.mergeNewsChoice(local, remote);
				if (this.newsProviderPinned) {
					choice = { ...choice, provider: this.newsProviderPinned };
					this.newsProviderPinned = null;
				}
				this.newsProvider = choice.provider;
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
			})
		).subscribe({
			next: (resp: any) => {
				if (gen !== this.loadGen) {
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
				this.newsState = this.news.length ? 'ready' : 'empty';
				this.end();
			},
			error: () => {
				if (gen !== this.loadGen) {
					return;
				}
				this.news = [];
				this.newsState = 'error';
				this.end();
			}
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
		this.radioNowSub = this.api.getRadioNowPlaying(station).pipe(take(1)).subscribe({
			next: (res) => {
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
			error: () => { /* the station name already fills the card */ }
		});
	}

	/** GPS only when already allowed, so opening the home page does not raise a permission prompt. */
	private weatherPosition() {
		return from(this.gpsAlreadyGranted()).pipe(
			switchMap((granted) => granted ? this.position.getGpsPosition() : of(null)),
			switchMap((gps) => gps ? of(gps) : this.position.getIpPosition()),
			catchError(() => this.position.getIpPosition())
		);
	}

	private async gpsAlreadyGranted(): Promise<boolean> {
		const query = navigator.permissions?.query;
		if (!query) {
			return false;
		}
		try {
			const status = await query.call(navigator.permissions, { name: 'geolocation' });
			return status.state === 'granted';
		} catch {
			return false;
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
				catchError(() => of(null))
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

	private memberNames(members: Member[]): Map<string, string> {
		const names = new Map<string, string>();
		for (const member of members) {
			const id = (member?.id || '').trim();
			if (!id) {
				continue;
			}
			const full = `${member.firstName || ''} ${member.lastName || ''}`.trim();
			names.set(id, full || (member.userName || '').trim());
		}
		return names;
	}

	private openTasks(lists: TodoList[], today: number, names: Map<string, string>): DashTaskItem[] {
		const rows: Array<DashTaskItem & { due: number | null }> = [];
		const label = (id: string | null | undefined) => names.get((id || '').trim()) || '';
		for (const list of lists) {
			if (list.status === 'done' || list.status === 'archived') {
				continue;
			}
			const owner = label(list.ownerMemberId);
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
					assignee: label(item.assigneeMemberId),
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

	private placeLabel(body: any): string {
		const address = body?.address && typeof body.address === 'object' ? body.address : {};
		const locality = ['city', 'town', 'village', 'municipality', 'hamlet', 'suburb']
			.map((key) => String(address[key] || '').trim())
			.find((value) => value.length > 0) || '';
		const area = String(address.county || address.state || address.country || '').trim();
		if (locality && area && locality.toLowerCase() !== area.toLowerCase()) {
			return `${locality}, ${area}`;
		}
		if (locality) {
			return locality;
		}
		const display = String(body?.displayName || body?.display_name || '').trim();
		const parts = display.split(',').map((part) => part.trim()).filter((part) => part && !/^\d+$/.test(part));
		return parts.slice(0, 2).join(', ');
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
		this.refreshing = true;
	}

	private end(): void {
		this.inflight = Math.max(0, this.inflight - 1);
		this.refreshing = this.inflight > 0;
	}
}

function startOfToday(): Date {
	const date = new Date();
	date.setHours(0, 0, 0, 0);
	return date;
}

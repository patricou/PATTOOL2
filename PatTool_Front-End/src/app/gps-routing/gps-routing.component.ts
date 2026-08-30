import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  TemplateRef,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { ActivatedRoute, ParamMap, Router } from '@angular/router';
import { Subject, Subscription } from 'rxjs';
import { debounceTime } from 'rxjs/operators';

import { isValidGeoCoordinate } from '../shared/geo-coordinates.util';

import { L } from '../shared/leaflet-rotate-setup';
import { LeafletBasemapOption, LeafletBasemapService } from '../shared/leaflet-basemap.service';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';
import { GpsNav3dComponent } from './gps-nav-3d.component';
import { GpsMapOrientation } from '../shared/gps-map-orientation';
import { KeycloakService } from '../keycloak/keycloak.service';
import { FriendsService } from '../services/friends.service';
import { Friend } from '../model/friend';
import { Member } from '../model/member';
import {
  ApiService,
  GpsItinerary,
  OpenRouteDirections,
  OpenRouteProfile,
  OpenRouteStep
} from '../services/api.service';
interface PlacePoint {
  lat: number;
  lon: number;
  label: string;
}

interface GeocodeHit {
  lat: number;
  lon: number;
  displayName: string;
}

interface ViaStop {
  id: string;
  query: string;
  point: PlacePoint | null;
  results: GeocodeHit[];
  activeIndex: number;
  searching: boolean;
}

interface GpsHistoryEntry {
  id: string;
  profile: OpenRouteProfile;
  from: PlacePoint;
  to: PlacePoint;
  vias?: PlacePoint[];
  distanceMeters?: number;
  durationSeconds?: number;
  savedAt: number;
  /** Login Keycloak (ou libellé affiché) au moment de la sauvegarde. */
  ownerUsername?: string;
  /** Mongo id when persisted on the server. */
  serverId?: string;
  sharedWithMe?: boolean;
  sharedWithMemberIds?: string[];
  sharedWithUsernames?: string[];
  coordinates?: number[][];
}

type PickTarget = 'from' | 'to' | `via:${string}` | null;

type RotatableMap = L.Map & {
  setBearing?: (bearing: number) => void;
  getBearing?: () => number;
};

/**
 * GPS routing page (Monde) — OpenRouteService via PatTool backend proxy.
 */
@Component({
  selector: 'app-gps-routing',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, TraceViewerModalComponent, GpsNav3dComponent],
  templateUrl: './gps-routing.component.html',
  styleUrls: ['./gps-routing.component.css']
})
export class GpsRoutingComponent implements OnInit, AfterViewInit, OnDestroy {

  private static readonly DRAFT_STORAGE_KEY = 'pattool.gps.draft.v1';
  private static readonly HISTORY_STORAGE_KEY = 'pattool.gps.history.v1';
  private static readonly ORIENTATION_STORAGE_KEY = 'pattool.gps.orientation.v1';
  private static readonly FOLLOW_STORAGE_KEY = 'pattool.gps.followUser.v1';
  private static readonly HISTORY_MAX = 12;
  private static readonly FOLLOW_INTERVAL_MS = 5000;
  static readonly MAX_VIA_POINTS = 8;

  @ViewChild('mapHost') mapHost?: ElementRef<HTMLDivElement>;
  @ViewChild('mapShell') mapShell?: ElementRef<HTMLElement>;
  @ViewChild(TraceViewerModalComponent) traceViewerModal?: TraceViewerModalComponent;
  @ViewChild('routeDetailsModal') routeDetailsModal?: TemplateRef<unknown>;
  @ViewChild('shareItineraryModal') shareItineraryModal?: TemplateRef<unknown>;

  readonly profiles: { id: OpenRouteProfile; labelKey: string; icon: string }[] = [
    { id: 'driving-car', labelKey: 'GPS_ROUTING.MODE_CAR', icon: 'fa-car' },
    { id: 'cycling-regular', labelKey: 'GPS_ROUTING.MODE_BIKE', icon: 'fa-bicycle' },
    { id: 'foot-walking', labelKey: 'GPS_ROUTING.MODE_WALK', icon: 'fa-male' }
  ];

  readonly orientations: { id: GpsMapOrientation; labelKey: string; icon: string }[] = [
    { id: 'north', labelKey: 'GPS_ROUTING.ORIENT_NORTH', icon: 'fa-compass' },
    { id: 'heading', labelKey: 'GPS_ROUTING.ORIENT_HEADING', icon: 'fa-location-arrow' },
    { id: 'route', labelKey: 'GPS_ROUTING.ORIENT_ROUTE', icon: 'fa-road' }
  ];

  profile: OpenRouteProfile = 'driving-car';
  mapOrientation: GpsMapOrientation = 'north';
  fromQuery = '';
  toQuery = '';
  fromResults: GeocodeHit[] = [];
  toResults: GeocodeHit[] = [];
  fromActiveIndex = -1;
  toActiveIndex = -1;
  fromPoint: PlacePoint | null = null;
  toPoint: PlacePoint | null = null;
  vias: ViaStop[] = [];
  pickTarget: PickTarget = null;
  recentSearches: GpsHistoryEntry[] = [];
  readonly maxViaPoints = GpsRoutingComponent.MAX_VIA_POINTS;

  route: OpenRouteDirections | null = null;
  steps: OpenRouteStep[] = [];
  isConfigured: boolean | null = null;
  isRouting = false;
  isLocating = false;
  isSearchingFrom = false;
  isSearchingTo = false;
  errorMessage = '';

  mapBaseLayerId = 'osm-standard';
  mapFullscreen = false;
  nav3dActive = false;
  historyOpen = false;
  /** Recenter 2D/3D maps on user GPS every 5s (default off, persisted per user). */
  followUserPosition = false;
  shareBusy = false;
  shareError = '';
  shareFriends: { member: Member; selected: boolean }[] = [];
  shareTarget: GpsHistoryEntry | null = null;

  private map?: RotatableMap;
  private baseLayer: L.TileLayer | L.LayerGroup | null = null;
  private routeLayer?: L.FeatureGroup;
  private fromSearch$ = new Subject<string>();
  private toSearch$ = new Subject<string>();
  private viaSearch$ = new Subject<{ id: string; query: string }>();
  private subs: Subscription[] = [];
  private detailsModalRef?: NgbModalRef;
  private shareModalRef?: NgbModalRef;
  private orientationWatchId: number | null = null;
  private followWatchId: number | null = null;
  private followIntervalId: ReturnType<typeof setInterval> | null = null;
  private lastUserLat: number | null = null;
  private lastUserLon: number | null = null;
  private deviceHeadingDeg: number | null = null;
  private routeHeadingDeg = 0;

  constructor(
    private readonly api: ApiService,
    private readonly basemap: LeafletBasemapService,
    private readonly translate: TranslateService,
    private readonly cdr: ChangeDetectorRef,
    private readonly ngZone: NgZone,
    private readonly modalService: NgbModal,
    private readonly keycloak: KeycloakService,
    private readonly friendsService: FriendsService,
    private readonly activatedRoute: ActivatedRoute,
    private readonly router: Router
  ) {}

  ngOnInit(): void {
    this.recentSearches = this.loadHistory();
    this.stampMissingOwners();
    this.historyOpen = this.recentSearches.length > 0;
    this.restoreDraft();
    this.restoreOrientation();
    this.restoreFollowUserLocal();
    this.loadFollowUserPreference();
    this.syncFollowTracking();
    this.refreshServerItineraries();

    this.api.getOpenRouteStatus().subscribe({
      next: (status) => {
        this.isConfigured = !!status?.configured;
        if (!this.isConfigured) {
          this.errorMessage = 'GPS_ROUTING.NOT_CONFIGURED';
        }
        this.cdr.detectChanges();
      },
      error: () => {
        this.isConfigured = false;
        this.errorMessage = 'GPS_ROUTING.NOT_CONFIGURED';
        this.cdr.detectChanges();
      }
    });

    this.subs.push(
      this.fromSearch$.pipe(debounceTime(350)).subscribe((q) => this.runGeocode('from', q)),
      this.toSearch$.pipe(debounceTime(350)).subscribe((q) => this.runGeocode('to', q)),
      this.viaSearch$.pipe(debounceTime(350)).subscribe(({ id, query }) => this.runGeocodeVia(id, query)),
      this.activatedRoute.queryParamMap.subscribe((params: ParamMap) => this.consumeIncomingRouteParams(params))
    );
  }

  ngAfterViewInit(): void {
    this.ensureMap();
    if (this.fromPoint || this.toPoint || this.resolvedViaPoints().length) {
      setTimeout(() => this.refreshMarkers(true), 60);
    }
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.stopOrientationWatch();
    this.stopFollowTracking();
    this.closeRouteDetails();
    this.dismissShareModal();
    this.nav3dActive = false;
    this.map?.remove();
    this.map = undefined;
  }

  onFromQueryChange(): void {
    this.fromPoint = null;
    this.fromActiveIndex = -1;
    this.fromSearch$.next(this.fromQuery);
  }

  onToQueryChange(): void {
    this.toPoint = null;
    this.toActiveIndex = -1;
    this.toSearch$.next(this.toQuery);
  }

  onFromKeydown(event: KeyboardEvent): void {
    this.handleResultsKeydown(event, 'from');
  }

  onToKeydown(event: KeyboardEvent): void {
    this.handleResultsKeydown(event, 'to');
  }

  onViaQueryChange(via: ViaStop): void {
    via.point = null;
    via.activeIndex = -1;
    this.viaSearch$.next({ id: via.id, query: via.query });
  }

  onViaKeydown(event: KeyboardEvent, via: ViaStop): void {
    this.handleViaResultsKeydown(event, via);
  }

  selectFrom(hit: GeocodeHit): void {
    this.fromPoint = { lat: hit.lat, lon: hit.lon, label: hit.displayName };
    this.fromQuery = hit.displayName;
    this.fromResults = [];
    this.fromActiveIndex = -1;
    this.persistDraft();
    this.refreshMarkers();
    this.cdr.detectChanges();
  }

  selectTo(hit: GeocodeHit): void {
    this.toPoint = { lat: hit.lat, lon: hit.lon, label: hit.displayName };
    this.toQuery = hit.displayName;
    this.toResults = [];
    this.toActiveIndex = -1;
    this.persistDraft();
    this.refreshMarkers();
    this.cdr.detectChanges();
  }

  selectVia(via: ViaStop, hit: GeocodeHit): void {
    via.point = { lat: hit.lat, lon: hit.lon, label: hit.displayName };
    via.query = hit.displayName;
    via.results = [];
    via.activeIndex = -1;
    via.searching = false;
    this.persistDraft();
    this.refreshMarkers();
    this.cdr.detectChanges();
  }

  get canAddVia(): boolean {
    return this.vias.length < this.maxViaPoints;
  }

  get hasAnyPlace(): boolean {
    return !!(this.fromPoint || this.toPoint || this.vias.some((v) => v.point || v.query));
  }

  trackByViaId(_index: number, via: ViaStop): string {
    return via.id;
  }

  addVia(): void {
    if (!this.canAddVia) {
      return;
    }
    const via = this.newViaStop();
    this.vias = [...this.vias, via];
    this.pickTarget = `via:${via.id}`;
    this.persistDraft();
    this.cdr.detectChanges();
  }

  removeVia(index: number): void {
    const removed = this.vias[index];
    if (!removed) {
      return;
    }
    if (this.pickTarget === `via:${removed.id}`) {
      this.pickTarget = null;
    }
    this.vias = this.vias.filter((_, i) => i !== index);
    this.persistDraft();
    this.refreshMarkers();
    this.cdr.detectChanges();
  }

  moveVia(index: number, delta: number): void {
    const next = index + delta;
    if (next < 0 || next >= this.vias.length) {
      return;
    }
    const copy = this.vias.slice();
    const [item] = copy.splice(index, 1);
    copy.splice(next, 0, item);
    this.vias = copy;
    this.persistDraft();
    this.refreshMarkers();
    this.cdr.detectChanges();
  }

  isPickVia(via: ViaStop): boolean {
    return this.pickTarget === `via:${via.id}`;
  }

  setPickVia(via: ViaStop): void {
    const key: PickTarget = `via:${via.id}`;
    this.pickTarget = this.pickTarget === key ? null : key;
  }

  useMyPositionAsFrom(): void {
    void this.locateUserAsFrom();
  }

  private consumeIncomingRouteParams(params: ParamMap): void {
    const dest = this.readQueryLatLon(params, 'toLat', 'toLon');
    if (!dest) {
      return;
    }
    const rawLabel = (params.get('toLabel') || '').trim();
    const label = rawLabel || `${dest.lat.toFixed(5)}, ${dest.lon.toFixed(5)}`;
    this.toPoint = { lat: dest.lat, lon: dest.lon, label };
    this.toQuery = label;
    this.toResults = [];
    this.vias = [];
    this.pickTarget = null;
    const origin = this.readQueryLatLon(params, 'fromLat', 'fromLon');
    if (origin) {
      this.applyFromCoords(origin.lat, origin.lon, false);
    }
    this.persistDraft();
    this.refreshMarkers();
    this.clearIncomingRouteParams();
    void this.locateUserAsFrom().then((ok) => {
      if ((ok || this.fromPoint) && this.toPoint) {
        this.calculateRoute();
      }
      this.cdr.detectChanges();
    });
  }

  private readQueryLatLon(
    params: ParamMap,
    latKey: string,
    lonKey: string
  ): { lat: number; lon: number } | null {
    const rawLat = params.get(latKey);
    const rawLon = params.get(lonKey);
    if (rawLat == null || rawLon == null || rawLat === '' || rawLon === '') {
      return null;
    }
    const lat = Number(rawLat);
    const lon = Number(rawLon);
    if (!isValidGeoCoordinate(lat, lon)) {
      return null;
    }
    return { lat, lon };
  }

  private clearIncomingRouteParams(): void {
    void this.router.navigate([], {
      relativeTo: this.activatedRoute,
      queryParams: { toLat: null, toLon: null, toLabel: null, fromLat: null, fromLon: null },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  private applyFromCoords(lat: number, lon: number, reverseGeocode: boolean): void {
    this.lastUserLat = lat;
    this.lastUserLon = lon;
    this.fromPoint = {
      lat,
      lon,
      label: this.translate.instant('GPS_ROUTING.MY_POSITION')
    };
    this.fromQuery = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    this.fromResults = [];
    this.persistDraft();
    this.refreshMarkers();
    if (!reverseGeocode) {
      return;
    }
    this.api.geocodeReverse(lat, lon).subscribe({
      next: (data: any) => {
        const name = data?.display_name || data?.displayName;
        if (name && this.fromPoint) {
          this.fromPoint = { ...this.fromPoint, label: name };
          this.fromQuery = name;
          this.persistDraft();
          this.cdr.detectChanges();
        }
      },
      error: () => { /* keep coords label */ }
    });
  }

  private locateUserAsFrom(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        this.errorMessage = 'GPS_ROUTING.GEOLOCATION_UNSUPPORTED';
        resolve(false);
        return;
      }
      this.isLocating = true;
      this.errorMessage = '';
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this.ngZone.run(() => {
            this.applyFromCoords(pos.coords.latitude, pos.coords.longitude, true);
            this.isLocating = false;
            this.cdr.detectChanges();
            resolve(true);
          });
        },
        () => {
          this.ngZone.run(() => {
            this.isLocating = false;
            if (!this.fromPoint) {
              this.errorMessage = 'GPS_ROUTING.GEOLOCATION_ERROR';
            }
            this.cdr.detectChanges();
            resolve(false);
          });
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
      );
    });
  }

  swapEnds(): void {
    const chain: { point: PlacePoint | null; query: string }[] = [
      { point: this.fromPoint, query: this.fromQuery },
      ...this.vias.map((v) => ({ point: v.point, query: v.query })),
      { point: this.toPoint, query: this.toQuery }
    ].reverse();
    this.fromPoint = chain[0].point;
    this.fromQuery = chain[0].query;
    this.toPoint = chain[chain.length - 1].point;
    this.toQuery = chain[chain.length - 1].query;
    this.vias = chain.slice(1, -1).map((item) => this.newViaStop(item.point, item.query));
    this.fromResults = [];
    this.toResults = [];
    this.persistDraft();
    this.refreshMarkers();
  }

  setPickTarget(target: PickTarget): void {
    this.pickTarget = this.pickTarget === target ? null : target;
  }

  setProfile(profile: OpenRouteProfile): void {
    this.profile = profile;
    this.persistDraft();
  }

  setMapOrientation(orientation: GpsMapOrientation): void {
    if (this.mapOrientation === orientation) {
      return;
    }
    this.mapOrientation = orientation;
    this.persistOrientation();
    this.syncOrientationWatch();
    this.applyMapBearing();
    this.cdr.detectChanges();
  }

  onFollowUserChange(): void {
    this.persistFollowUserLocal();
    this.persistFollowUserRemote();
    this.syncFollowTracking();
    if (this.followUserPosition) {
      this.recenterMapOnUser();
    }
    this.cdr.detectChanges();
  }

  calculateRoute(openDetails = false): void {
    if (!this.fromPoint || !this.toPoint) {
      this.errorMessage = 'GPS_ROUTING.POINTS_REQUIRED';
      return;
    }
    if (this.isConfigured === false) {
      this.errorMessage = 'GPS_ROUTING.NOT_CONFIGURED';
      return;
    }

    this.isRouting = true;
    this.errorMessage = '';
    this.closeRouteDetails();
    this.route = null;
    this.steps = [];
    this.persistDraft();

    const lang = this.translate.currentLang || this.translate.defaultLang || 'en';
    const vias = this.resolvedViaPoints();
    this.api.getOpenRouteDirections(
      this.profile,
      this.fromPoint.lat,
      this.fromPoint.lon,
      this.toPoint.lat,
      this.toPoint.lon,
      lang,
      vias
    ).subscribe({
      next: (data) => {
        this.route = data;
        this.steps = data?.steps || [];
        this.isRouting = false;
        this.saveSuccessfulSearch(data);
        this.updateRouteHeadingFromPath();
        this.drawRoute();
        this.applyMapBearing();
        this.cdr.detectChanges();
        if (openDetails) {
          this.openRouteDetails();
        }
      },
      error: (err) => {
        this.isRouting = false;
        const code = err?.error?.error;
        if (err?.status === 503 || code === 'not_configured') {
          this.isConfigured = false;
          this.errorMessage = 'GPS_ROUTING.NOT_CONFIGURED';
        } else if (err?.status === 404 || code === 'no_route') {
          this.errorMessage = 'GPS_ROUTING.NO_ROUTE';
        } else {
          this.errorMessage = 'GPS_ROUTING.ROUTE_ERROR';
        }
        this.clearRouteLine();
        this.cdr.detectChanges();
      }
    });
  }

  clearRoute(): void {
    this.route = null;
    this.steps = [];
    this.errorMessage = '';
    this.nav3dActive = false;
    this.fromPoint = null;
    this.toPoint = null;
    this.fromQuery = '';
    this.toQuery = '';
    this.fromResults = [];
    this.toResults = [];
    this.vias = [];
    this.pickTarget = null;
    this.closeRouteDetails();
    this.persistDraft();
    this.clearRouteLine();
  }

  openRouteDetails(): void {
    if (!this.route || !this.routeDetailsModal) {
      return;
    }
    if (this.detailsModalRef) {
      return;
    }
    this.detailsModalRef = this.modalService.open(this.routeDetailsModal, {
      size: 'lg',
      scrollable: true,
      centered: true,
      backdrop: true,
      keyboard: true,
      animation: true,
      windowClass: 'modal-smooth-animation gps-route-details-modal'
    });
    this.detailsModalRef.result.finally(() => {
      this.detailsModalRef = undefined;
    });
  }

  closeRouteDetails(): void {
    if (this.detailsModalRef) {
      this.detailsModalRef.close();
      this.detailsModalRef = undefined;
    }
  }

  applyHistoryEntry(entry: GpsHistoryEntry, openDetails = false): void {
    if (!entry?.from || !entry?.to) {
      return;
    }
    this.profile = entry.profile || 'driving-car';
    this.fromPoint = { ...entry.from };
    this.toPoint = { ...entry.to };
    this.fromQuery = entry.from.label || '';
    this.toQuery = entry.to.label || '';
    this.fromResults = [];
    this.toResults = [];
    this.vias = (entry.vias || []).filter((p) => this.isValidPoint(p)).map((p) => this.newViaStop({
      lat: Number(p.lat),
      lon: Number(p.lon),
      label: String(p.label || '')
    }));
    this.persistDraft();
    this.refreshMarkers();
    this.calculateRoute(openDetails);
  }

  openHistoryEntryDetails(entry: GpsHistoryEntry, event?: Event): void {
    event?.stopPropagation();
    this.applyHistoryEntry(entry, true);
  }

  removeHistoryEntry(entry: GpsHistoryEntry, event?: Event): void {
    event?.stopPropagation();
    const serverId = entry.serverId;
    this.recentSearches = this.recentSearches.filter((e) => e.id !== entry.id);
    this.persistLocalOnlyHistory();
    if (serverId && !entry.sharedWithMe) {
      this.api.deleteGpsItinerary(serverId).subscribe({
        error: () => { /* keep UI optimistic */ }
      });
    }
    this.cdr.detectChanges();
  }

  clearHistory(): void {
    const ownedServerIds = this.recentSearches
      .filter((e) => e.serverId && !e.sharedWithMe)
      .map((e) => e.serverId!);
    // Keep itineraries shared by others; clear mine (local + server).
    this.recentSearches = this.recentSearches.filter((e) => !!e.sharedWithMe);
    this.persistLocalOnlyHistory();
    ownedServerIds.forEach((id) => {
      this.api.deleteGpsItinerary(id).subscribe({ error: () => { /* ignore */ } });
    });
    this.cdr.detectChanges();
  }

  openShareItinerary(entry: GpsHistoryEntry, event?: Event): void {
    event?.stopPropagation();
    if (!entry.serverId || entry.sharedWithMe) {
      // Persist on server first, then open share.
      if (!entry.serverId && !entry.sharedWithMe) {
        this.persistEntryToServer(entry, (saved) => this.openShareModalFor(saved));
        return;
      }
      return;
    }
    this.openShareModalFor(entry);
  }

  canShareEntry(entry: GpsHistoryEntry): boolean {
    return !entry.sharedWithMe;
  }

  friendDisplayName(member: Member): string {
    const user = (member.userName || '').trim();
    if (user) {
      return user;
    }
    const full = `${member.firstName || ''} ${member.lastName || ''}`.trim();
    return full || member.id || '—';
  }

  confirmShareItinerary(): void {
    const entry = this.shareTarget;
    if (!entry?.serverId || this.shareBusy) {
      return;
    }
    const memberIds = this.shareFriends.filter((f) => f.selected).map((f) => f.member.id);
    this.shareBusy = true;
    this.shareError = '';
    this.api.shareGpsItinerary(entry.serverId, memberIds).subscribe({
      next: (it) => {
        this.mergeServerItinerary(it);
        this.shareBusy = false;
        this.shareModalRef?.close();
        this.shareModalRef = undefined;
        this.shareTarget = null;
        this.cdr.detectChanges();
      },
      error: () => {
        this.shareBusy = false;
        this.shareError = 'GPS_ROUTING.SHARE_ERROR';
        this.cdr.detectChanges();
      }
    });
  }

  dismissShareModal(): void {
    this.shareModalRef?.dismiss();
    this.shareModalRef = undefined;
    this.shareTarget = null;
    this.shareError = '';
  }

  private openShareModalFor(entry: GpsHistoryEntry): void {
    if (!this.shareItineraryModal) {
      return;
    }
    this.shareTarget = entry;
    this.shareError = '';
    this.shareBusy = true;
    this.shareFriends = [];
    this.shareModalRef = this.modalService.open(this.shareItineraryModal, {
      centered: true,
      size: 'md'
    });
    this.shareModalRef.result.finally(() => {
      this.shareModalRef = undefined;
      this.shareBusy = false;
    });
    this.friendsService.getFriends().subscribe({
      next: (friends: Friend[]) => {
        const selected = new Set(entry.sharedWithMemberIds || []);
        const myName = (this.keycloak.getUsernameForDisplay() || '').trim().toLowerCase();
        const rows: { member: Member; selected: boolean }[] = [];
        for (const f of friends || []) {
          const other = this.otherFriendMember(f, myName);
          if (!other?.id) {
            continue;
          }
          rows.push({ member: other, selected: selected.has(other.id) });
        }
        rows.sort((a, b) => this.friendDisplayName(a.member).localeCompare(this.friendDisplayName(b.member)));
        this.shareFriends = rows;
        this.shareBusy = false;
        this.cdr.detectChanges();
      },
      error: () => {
        this.shareBusy = false;
        this.shareError = 'GPS_ROUTING.SHARE_FRIENDS_ERROR';
        this.cdr.detectChanges();
      }
    });
  }

  private otherFriendMember(friend: Friend, myNameLower: string): Member | null {
    const u1 = friend.user1;
    const u2 = friend.user2;
    if (myNameLower) {
      if (u1?.userName && u1.userName.trim().toLowerCase() === myNameLower) {
        return u2 || null;
      }
      if (u2?.userName && u2.userName.trim().toLowerCase() === myNameLower) {
        return u1 || null;
      }
    }
    return u2 || u1 || null;
  }

  toggleHistory(): void {
    this.historyOpen = !this.historyOpen;
  }

  saveCurrentSearch(): void {
    if (!this.fromPoint || !this.toPoint) {
      this.errorMessage = 'GPS_ROUTING.POINTS_REQUIRED';
      return;
    }
    this.persistDraft();
    this.saveSuccessfulSearch(this.route, true);
    this.historyOpen = true;
    this.errorMessage = '';
    this.cdr.detectChanges();
  }

  historyRouteLabels(entry: GpsHistoryEntry): string[] {
    const vias = entry.vias || [];
    return [
      entry.from?.label || '',
      ...vias.map((v) => v.label || ''),
      entry.to?.label || ''
    ];
  }

  historyRouteText(entry: GpsHistoryEntry, max = 24): string {
    return this.historyRouteLabels(entry).map((label) => this.shortLabel(label, max)).join(' → ');
  }

  shortLabel(label: string | undefined, max = 42): string {
    const text = (label || '').trim();
    if (text.length <= max) {
      return text || '—';
    }
    return `${text.slice(0, max - 1)}…`;
  }

  historyOwnerLabel(entry: GpsHistoryEntry): string {
    const stored = (entry.ownerUsername || '').trim();
    if (stored) {
      return stored;
    }
    return this.translate.instant('GPS_ROUTING.HISTORY_OWNER_UNKNOWN');
  }

  private currentOwnerUsername(): string | undefined {
    const name = (this.keycloak.getUsernameForDisplay() || '').trim();
    return name.length > 0 ? name : undefined;
  }

  /** Anciennes entrées sans owner : rattacher au login courant (historique local). */
  private stampMissingOwners(): void {
    const me = this.currentOwnerUsername();
    if (!me || !this.recentSearches.length) {
      return;
    }
    let changed = false;
    this.recentSearches = this.recentSearches.map((e) => {
      if ((e.ownerUsername || '').trim()) {
        return e;
      }
      changed = true;
      return { ...e, ownerUsername: me };
    });
    if (changed) {
      this.persistLocalOnlyHistory();
    }
  }

  profileIcon(profile: OpenRouteProfile): string {
    return this.profiles.find((p) => p.id === profile)?.icon || 'fa-road';
  }

  toggleNav3d(): void {
    if (!this.route?.coordinates?.length) {
      return;
    }
    this.nav3dActive = !this.nav3dActive;
    if (!this.nav3dActive) {
      this.refreshMapAfterNav3d();
      this.applyMapBearing();
    }
  }

  refreshMapAfterNav3d(): void {
    setTimeout(() => {
      this.map?.invalidateSize();
      if (this.route?.coordinates?.length) {
        this.refreshMarkers(true);
      }
    }, 80);
  }

  get availableMapBaseLayers(): LeafletBasemapOption[] {
    return this.basemap.getAvailableLayers();
  }

  getMapBaseLayerLabel(layer: LeafletBasemapOption): string {
    return layer.labelKey ? this.translate.instant(layer.labelKey) : layer.label;
  }

  onMapBaseLayerChange(): void {
    if (!this.map) {
      return;
    }
    this.baseLayer = this.basemap.applyBaseLayer(this.map, this.mapBaseLayerId, this.baseLayer);
  }

  toggleMapFullscreen(): void {
    const shell = this.mapShell?.nativeElement;
    if (!shell) {
      return;
    }
    if (this.mapFullscreen) {
      this.exitMapFullscreenIfActive();
      return;
    }
    const request = shell.requestFullscreen?.bind(shell)
      ?? (shell as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.bind(shell);
    request?.().catch(() => {
      this.mapFullscreen = true;
      this.refreshMapLayoutAfterResize();
    });
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  onMapFullscreenChange(): void {
    const shell = this.mapShell?.nativeElement;
    const doc = document as Document & { webkitFullscreenElement?: Element };
    const active = !!(shell && (document.fullscreenElement === shell || doc.webkitFullscreenElement === shell));
    if (this.mapFullscreen === active) {
      return;
    }
    this.mapFullscreen = active;
    this.refreshMapLayoutAfterResize();
  }

  @HostListener('document:keydown.escape')
  onMapFullscreenEscape(): void {
    if (this.mapFullscreen) {
      this.exitMapFullscreenIfActive();
    }
  }

  openInTraceViewer(): void {
    if (!this.traceViewerModal || !this.route?.coordinates?.length) {
      return;
    }
    const points = this.route.coordinates
      .filter((c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
      .map((c) => ({ lat: c[0], lng: c[1] }));
    if (!points.length) {
      return;
    }
    const fromLabel = this.fromPoint?.label || this.translate.instant('GPS_ROUTING.FROM');
    const toLabel = this.toPoint?.label || this.translate.instant('GPS_ROUTING.TO');
    const title = this.routeTitle(fromLabel, toLabel);
    this.traceViewerModal.openWithTrackPoints(points, title, {
      initialBaseLayerId: this.mapBaseLayerId
    });
  }

  exportGpx(): void {
    const coords = this.route?.coordinates;
    if (!coords?.length) {
      return;
    }
    const points = coords.filter(
      (c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])
    );
    if (!points.length) {
      return;
    }

    const fromLabel = this.fromPoint?.label || this.translate.instant('GPS_ROUTING.FROM');
    const toLabel = this.toPoint?.label || this.translate.instant('GPS_ROUTING.TO');
    const name = this.routeTitle(fromLabel, toLabel);
    const profileLabel = this.translate.instant(
      this.profiles.find((p) => p.id === this.profile)?.labelKey || 'GPS_ROUTING.TITLE'
    );
    const gpx = this.buildGpx(points, name, profileLabel);
    const blob = new Blob([gpx], { type: 'application/gpx+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.buildGpxFileName(fromLabel, toLabel);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  formatDistance(meters?: number | null): string {
    if (meters == null || !Number.isFinite(meters)) {
      return '—';
    }
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(meters >= 10000 ? 0 : 1)} km`;
    }
    return `${Math.round(meters)} m`;
  }

  formatElevation(meters?: number | null): string {
    if (meters == null || !Number.isFinite(meters)) {
      return '—';
    }
    return `${Math.round(meters)} m`;
  }

  formatSpeed(kmh?: number | null): string {
    if (kmh == null || !Number.isFinite(kmh)) {
      return '—';
    }
    return `${kmh.toFixed(1)} km/h`;
  }

  formatPercent(amount?: number | null): string {
    if (amount == null || !Number.isFinite(amount)) {
      return '—';
    }
    return `${amount.toFixed(amount >= 10 ? 0 : 1)} %`;
  }

  formatBbox(bbox?: number[] | null): string {
    if (!bbox?.length) {
      return '—';
    }
    return bbox.map((v) => Number(v).toFixed(5)).join(', ');
  }

  formatTimestamp(ts?: number | null): string {
    if (ts == null || !Number.isFinite(ts)) {
      return '—';
    }
    const ms = ts > 1e12 ? ts : ts * 1000;
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return String(ts);
    }
  }

  profileLabel(profile?: string | null): string {
    const found = this.profiles.find((p) => p.id === profile);
    return found ? this.translate.instant(found.labelKey) : (profile || '—');
  }

  extraGroupLabel(key?: string | null): string {
    if (!key) {
      return '—';
    }
    const normalized = key.toLowerCase();
    const i18nKey = `GPS_ROUTING.EXTRA_GROUP.${normalized}`;
    const translated = this.translate.instant(i18nKey);
    return translated !== i18nKey ? translated : key;
  }

  extraValueLabel(groupKey?: string | null, value?: number | null): string {
    if (value == null || !Number.isFinite(value)) {
      return '—';
    }
    const normalized = (groupKey || '').toLowerCase();
    // ORS response key is often "waytypes" while request uses "waytype".
    const mapKey = normalized === 'waytypes' ? 'waytype' : normalized;
    const i18nKey = `GPS_ROUTING.EXTRA_VALUE.${mapKey}.${value}`;
    const translated = this.translate.instant(i18nKey);
    if (translated !== i18nKey) {
      return translated;
    }
    return `${value}`;
  }

  formatDuration(seconds?: number | null): string {
    if (seconds == null || !Number.isFinite(seconds)) {
      return '—';
    }
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (h > 0) {
      return `${h} h ${m} min`;
    }
    if (m > 0) {
      return `${m} min`;
    }
    return `${total} s`;
  }

  private handleViaResultsKeydown(event: KeyboardEvent, via: ViaStop): void {
    const results = via.results;
    if (!results.length) {
      return;
    }
    const setActive = (index: number) => {
      via.activeIndex = index;
      this.cdr.detectChanges();
      this.scrollActiveResultIntoView(`gpsViaResults${via.id}`, index);
    };

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive(via.activeIndex < results.length - 1 ? via.activeIndex + 1 : 0);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive(via.activeIndex > 0 ? via.activeIndex - 1 : results.length - 1);
        break;
      case 'Enter':
        if (via.activeIndex >= 0 && via.activeIndex < results.length) {
          event.preventDefault();
          this.selectVia(via, results[via.activeIndex]);
        }
        break;
      case 'Escape':
        event.preventDefault();
        via.results = [];
        via.activeIndex = -1;
        this.cdr.detectChanges();
        break;
      case 'Home':
        event.preventDefault();
        setActive(0);
        break;
      case 'End':
        event.preventDefault();
        setActive(results.length - 1);
        break;
      default:
        break;
    }
  }

  private handleResultsKeydown(event: KeyboardEvent, side: 'from' | 'to'): void {
    const results = side === 'from' ? this.fromResults : this.toResults;
    if (!results.length) {
      return;
    }
    const active = side === 'from' ? this.fromActiveIndex : this.toActiveIndex;
    const setActive = (index: number) => {
      if (side === 'from') {
        this.fromActiveIndex = index;
      } else {
        this.toActiveIndex = index;
      }
      this.cdr.detectChanges();
      this.scrollActiveResultIntoView(side === 'from' ? 'gpsFromResults' : 'gpsToResults', index);
    };

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive(active < results.length - 1 ? active + 1 : 0);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive(active > 0 ? active - 1 : results.length - 1);
        break;
      case 'Enter':
        if (active >= 0 && active < results.length) {
          event.preventDefault();
          if (side === 'from') {
            this.selectFrom(results[active]);
          } else {
            this.selectTo(results[active]);
          }
        }
        break;
      case 'Escape':
        event.preventDefault();
        if (side === 'from') {
          this.fromResults = [];
          this.fromActiveIndex = -1;
        } else {
          this.toResults = [];
          this.toActiveIndex = -1;
        }
        this.cdr.detectChanges();
        break;
      case 'Home':
        event.preventDefault();
        setActive(0);
        break;
      case 'End':
        event.preventDefault();
        setActive(results.length - 1);
        break;
      default:
        break;
    }
  }

  private scrollActiveResultIntoView(listId: string, index: number): void {
    const list = document.getElementById(listId);
    const item = list?.querySelectorAll('.gps-result-row')[index] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }

  private runGeocode(side: 'from' | 'to', query: string): void {
    const q = query?.trim();
    if (!q || q.length < 3) {
      if (side === 'from') {
        this.fromResults = [];
        this.fromActiveIndex = -1;
      } else {
        this.toResults = [];
        this.toActiveIndex = -1;
      }
      this.cdr.detectChanges();
      return;
    }

    const coords = this.parseCoordinates(q);
    if (coords) {
      const hit: GeocodeHit = {
        lat: coords.lat,
        lon: coords.lon,
        displayName: `${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}`
      };
      if (side === 'from') {
        this.selectFrom(hit);
      } else {
        this.selectTo(hit);
      }
      return;
    }

    if (side === 'from') {
      this.isSearchingFrom = true;
    } else {
      this.isSearchingTo = true;
    }

    this.api.geocodeSearch(q).subscribe({
      next: (data: any[]) => {
        const hits = this.mapGeocodeHits(data);
        if (side === 'from') {
          this.fromResults = hits.slice(0, 6);
          this.fromActiveIndex = this.fromResults.length ? 0 : -1;
          this.isSearchingFrom = false;
        } else {
          this.toResults = hits.slice(0, 6);
          this.toActiveIndex = this.toResults.length ? 0 : -1;
          this.isSearchingTo = false;
        }
        this.cdr.detectChanges();
      },
      error: () => {
        if (side === 'from') {
          this.fromResults = [];
          this.fromActiveIndex = -1;
          this.isSearchingFrom = false;
        } else {
          this.toResults = [];
          this.toActiveIndex = -1;
          this.isSearchingTo = false;
        }
        this.cdr.detectChanges();
      }
    });
  }

  private runGeocodeVia(id: string, query: string): void {
    const via = this.vias.find((v) => v.id === id);
    if (!via) {
      return;
    }
    const q = query?.trim();
    if (!q || q.length < 3) {
      via.results = [];
      via.activeIndex = -1;
      via.searching = false;
      this.cdr.detectChanges();
      return;
    }

    const coords = this.parseCoordinates(q);
    if (coords) {
      this.selectVia(via, {
        lat: coords.lat,
        lon: coords.lon,
        displayName: `${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}`
      });
      return;
    }

    via.searching = true;
    this.api.geocodeSearch(q).subscribe({
      next: (data: any[]) => {
        const current = this.vias.find((v) => v.id === id);
        if (!current) {
          return;
        }
        const hits = this.mapGeocodeHits(data);
        current.results = hits.slice(0, 6);
        current.activeIndex = current.results.length ? 0 : -1;
        current.searching = false;
        this.cdr.detectChanges();
      },
      error: () => {
        const current = this.vias.find((v) => v.id === id);
        if (!current) {
          return;
        }
        current.results = [];
        current.activeIndex = -1;
        current.searching = false;
        this.cdr.detectChanges();
      }
    });
  }

  private mapGeocodeHits(data: any[]): GeocodeHit[] {
    return (data || []).map((item: any) => ({
      lat: typeof item.lat === 'number' ? item.lat : parseFloat(item.lat) || 0,
      lon: typeof item.lon === 'number' ? item.lon : parseFloat(item.lon) || 0,
      displayName: item.displayName || item.display_name || ''
    })).filter((h: GeocodeHit) => h.displayName && Number.isFinite(h.lat) && Number.isFinite(h.lon));
  }

  private parseCoordinates(raw: string): { lat: number; lon: number } | null {
    const cleaned = raw.trim().replace(/;/g, ',').replace(/\s+/g, ' ');
    let match = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (!match) {
      match = cleaned.match(/^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/);
    }
    if (!match) {
      return null;
    }
    const lat = parseFloat(match[1]);
    const lon = parseFloat(match[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return null;
    }
    return { lat, lon };
  }

  private ensureMap(): void {
    const el = this.mapHost?.nativeElement;
    if (!el || this.map) {
      this.map?.invalidateSize();
      return;
    }
    this.basemap.loadOptionalLayers(this.api);
    this.map = L.map(el, {
      zoomControl: true,
      attributionControl: true,
      rotate: true,
      bearing: 0,
      touchRotate: false,
      shiftKeyRotate: false,
      rotateControl: false
    } as L.MapOptions) as RotatableMap;
    this.baseLayer = this.basemap.applyBaseLayer(this.map, this.mapBaseLayerId, null);
    this.routeLayer = L.featureGroup().addTo(this.map);
    this.map.setView([46.6, 2.5], 6);
    this.map.on('click', (e: L.LeafletMouseEvent) => {
      this.ngZone.run(() => this.onMapClick(e.latlng.lat, e.latlng.lng));
    });
    this.syncOrientationWatch();
    this.applyMapBearing();
    setTimeout(() => this.map?.invalidateSize(), 0);
  }

  private restoreOrientation(): void {
    try {
      const raw = localStorage.getItem(GpsRoutingComponent.ORIENTATION_STORAGE_KEY);
      if (raw === 'north' || raw === 'heading' || raw === 'route') {
        this.mapOrientation = raw;
      }
    } catch {
      // ignore
    }
  }

  private persistOrientation(): void {
    try {
      localStorage.setItem(GpsRoutingComponent.ORIENTATION_STORAGE_KEY, this.mapOrientation);
    } catch {
      // ignore
    }
  }

  private restoreFollowUserLocal(): void {
    try {
      const raw = localStorage.getItem(GpsRoutingComponent.FOLLOW_STORAGE_KEY);
      if (raw === '0' || raw === 'false') {
        this.followUserPosition = false;
      } else if (raw === '1' || raw === 'true') {
        this.followUserPosition = true;
      }
    } catch {
      // default false
    }
  }

  private persistFollowUserLocal(): void {
    try {
      localStorage.setItem(
        GpsRoutingComponent.FOLLOW_STORAGE_KEY,
        this.followUserPosition ? '1' : '0'
      );
    } catch {
      // ignore
    }
  }

  private loadFollowUserPreference(): void {
    this.api.getGpsFollowPreferences().subscribe({
      next: (pref) => {
        this.followUserPosition = pref?.followUser === true;
        this.persistFollowUserLocal();
        this.syncFollowTracking();
        this.cdr.detectChanges();
      },
      error: () => {
        // keep local / default (off)
      }
    });
  }

  private persistFollowUserRemote(): void {
    this.api.saveGpsFollowPreferences(this.followUserPosition).subscribe({
      error: () => { /* local already saved */ }
    });
  }

  private syncFollowTracking(): void {
    if (this.followUserPosition) {
      this.startFollowWatch();
      this.startFollowInterval();
    } else {
      this.stopFollowInterval();
      // Keep last known fix; stop dedicated watch if orientation doesn't need GPS.
      if (this.mapOrientation === 'north') {
        this.stopFollowWatch();
      }
    }
  }

  private startFollowWatch(): void {
    if (this.followWatchId != null || !navigator.geolocation) {
      return;
    }
    this.followWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.ngZone.run(() => {
          this.lastUserLat = pos.coords.latitude;
          this.lastUserLon = pos.coords.longitude;
          if (pos.coords.heading != null && Number.isFinite(pos.coords.heading)) {
            this.deviceHeadingDeg = pos.coords.heading;
          }
        });
      },
      () => { /* keep last fix */ },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
  }

  private stopFollowWatch(): void {
    if (this.followWatchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.followWatchId);
      this.followWatchId = null;
    }
  }

  private startFollowInterval(): void {
    if (this.followIntervalId != null) {
      return;
    }
    this.recenterMapOnUser();
    this.followIntervalId = setInterval(() => {
      this.ngZone.run(() => this.recenterMapOnUser());
    }, GpsRoutingComponent.FOLLOW_INTERVAL_MS);
  }

  private stopFollowInterval(): void {
    if (this.followIntervalId != null) {
      clearInterval(this.followIntervalId);
      this.followIntervalId = null;
    }
  }

  private stopFollowTracking(): void {
    this.stopFollowInterval();
    this.stopFollowWatch();
  }

  /** Pan 2D map to last known user position (3D handles follow via its own input). */
  private recenterMapOnUser(): void {
    if (!this.followUserPosition || this.nav3dActive || !this.map) {
      return;
    }
    if (this.lastUserLat == null || this.lastUserLon == null) {
      return;
    }
    try {
      this.map.panTo([this.lastUserLat, this.lastUserLon], { animate: true, duration: 0.6 });
      this.applyMapBearing();
    } catch {
      // map not ready
    }
  }

  private syncOrientationWatch(): void {
    if (this.mapOrientation === 'heading' || this.mapOrientation === 'route') {
      this.startOrientationWatch();
    } else {
      this.stopOrientationWatch();
    }
  }

  private startOrientationWatch(): void {
    if (this.orientationWatchId != null || !navigator.geolocation) {
      return;
    }
    this.orientationWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.ngZone.run(() => {
          if (pos.coords.heading != null && Number.isFinite(pos.coords.heading)) {
            this.deviceHeadingDeg = pos.coords.heading;
          }
          if (this.mapOrientation === 'route') {
            this.updateRouteHeadingNear(pos.coords.latitude, pos.coords.longitude);
          }
          if (this.mapOrientation === 'heading' || this.mapOrientation === 'route') {
            this.applyMapBearing();
          }
        });
      },
      () => { /* keep last heading */ },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
  }

  private stopOrientationWatch(): void {
    if (this.orientationWatchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.orientationWatchId);
      this.orientationWatchId = null;
    }
  }

  private updateRouteHeadingFromPath(): void {
    const coords = this.route?.coordinates;
    if (!coords || coords.length < 2) {
      this.routeHeadingDeg = 0;
      return;
    }
    this.updateRouteHeadingNear(coords[0][0], coords[0][1]);
  }

  private updateRouteHeadingNear(lat: number, lon: number): void {
    const coords = this.route?.coordinates;
    if (!coords || coords.length < 2) {
      return;
    }
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const d = Math.hypot(coords[i][0] - lat, coords[i][1] - lon);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    const i = Math.min(bestI, coords.length - 2);
    const a = coords[i];
    const b = coords[i + 1];
    const lat1 = a[0] * Math.PI / 180;
    const lat2 = b[0] * Math.PI / 180;
    const dLon = (b[1] - a[1]) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    let bearing = Math.atan2(y, x) * 180 / Math.PI;
    this.routeHeadingDeg = (bearing + 360) % 360;
  }

  applyMapBearing(): void {
    if (!this.map?.setBearing || this.nav3dActive) {
      return;
    }
    let bearing = 0;
    if (this.mapOrientation === 'heading') {
      bearing = this.deviceHeadingDeg != null ? this.deviceHeadingDeg : this.routeHeadingDeg;
    } else if (this.mapOrientation === 'route') {
      bearing = this.routeHeadingDeg;
    }
    try {
      this.map.setBearing(((bearing % 360) + 360) % 360);
      this.map.invalidateSize({ animate: false });
    } catch {
      // plugin not ready
    }
  }

  private exitMapFullscreenIfActive(): void {
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => Promise<void> };
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      const exit = document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(document);
      exit?.().catch(() => {
        this.mapFullscreen = false;
        this.refreshMapLayoutAfterResize();
      });
      return;
    }
    if (this.mapFullscreen) {
      this.mapFullscreen = false;
      this.refreshMapLayoutAfterResize();
    }
  }

  private refreshMapLayoutAfterResize(): void {
    setTimeout(() => {
      this.map?.invalidateSize();
      if (this.route?.coordinates?.length) {
        this.refreshMarkers(true);
      }
    }, 120);
  }

  private onMapClick(lat: number, lon: number): void {
    if (!this.pickTarget) {
      return;
    }
    const label = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const point: PlacePoint = { lat, lon, label };
    if (this.pickTarget === 'from') {
      this.fromPoint = point;
      this.fromQuery = label;
      this.fromResults = [];
    } else if (this.pickTarget === 'to') {
      this.toPoint = point;
      this.toQuery = label;
      this.toResults = [];
    } else if (this.pickTarget.startsWith('via:')) {
      const id = this.pickTarget.slice(4);
      const via = this.vias.find((v) => v.id === id);
      if (via) {
        via.point = point;
        via.query = label;
        via.results = [];
        via.activeIndex = -1;
      }
    }
    this.pickTarget = null;
    this.persistDraft();
    this.refreshMarkers();
    this.cdr.detectChanges();
  }

  private refreshMarkers(fitRoute = false): void {
    if (!this.map || !this.routeLayer) {
      return;
    }
    const layer = this.routeLayer;
    layer.clearLayers();
    if (this.fromPoint) {
      L.circleMarker([this.fromPoint.lat, this.fromPoint.lon], {
        radius: 9,
        color: '#fff',
        weight: 2,
        fillColor: '#198754',
        fillOpacity: 0.95
      }).bindTooltip(this.translate.instant('GPS_ROUTING.FROM'), { permanent: false })
        .addTo(layer);
    }
    this.resolvedViaPoints().forEach((via, index) => {
      L.marker([via.lat, via.lon], {
        icon: L.divIcon({
          className: 'gps-via-marker',
          html: `<span>${index + 1}</span>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11]
        }),
        keyboard: false
      }).bindTooltip(
        this.translate.instant('GPS_ROUTING.VIA', { n: index + 1 }),
        { permanent: false }
      ).addTo(layer);
    });
    if (this.toPoint) {
      L.circleMarker([this.toPoint.lat, this.toPoint.lon], {
        radius: 9,
        color: '#fff',
        weight: 2,
        fillColor: '#dc3545',
        fillOpacity: 0.95
      }).bindTooltip(this.translate.instant('GPS_ROUTING.TO'), { permanent: false })
        .addTo(layer);
    }
    if (this.route?.coordinates?.length) {
      this.drawRoutePolyline(fitRoute);
      return;
    }
    const bounds = this.routeLayer.getBounds();
    if (bounds.isValid()) {
      this.map.fitBounds(bounds.pad(0.25));
    }
  }

  private drawRoute(): void {
    if (!this.map || !this.routeLayer) {
      this.ensureMap();
    }
    this.refreshMarkers(true);
  }

  private drawRoutePolyline(fit: boolean): void {
    if (!this.map || !this.routeLayer || !this.route?.coordinates?.length) {
      return;
    }
    const latLngs = this.route.coordinates
      .filter((c) => Array.isArray(c) && c.length >= 2)
      .map((c) => L.latLng(c[0], c[1]));
    if (!latLngs.length) {
      return;
    }
    L.polyline(latLngs, {
      color: '#0d6efd',
      weight: 5,
      opacity: 0.85
    }).addTo(this.routeLayer);
    if (fit) {
      this.map.fitBounds(L.latLngBounds(latLngs).pad(0.15));
    }
  }

  private clearRouteLine(): void {
    if (!this.routeLayer) {
      return;
    }
    this.routeLayer.clearLayers();
    this.refreshMarkers();
  }

  private buildGpx(points: number[][], name: string, profileLabel: string): string {
    const now = new Date().toISOString();
    const safeName = this.escapeXml(name);
    const elevBits: string[] = [];
    if (this.route?.ascentMeters != null) {
      elevBits.push(`D+ ${this.formatElevation(this.route.ascentMeters)}`);
    }
    if (this.route?.descentMeters != null) {
      elevBits.push(`D- ${this.formatElevation(this.route.descentMeters)}`);
    }
    const safeDesc = this.escapeXml(
      [
        profileLabel,
        this.formatDistance(this.route?.distanceMeters),
        this.formatDuration(this.route?.durationSeconds),
        ...elevBits
      ].filter(Boolean).join(' · ')
    );
    const trkpts = points
      .map((c) => {
        const ele = c.length >= 3 && Number.isFinite(c[2])
          ? `\n        <ele>${c[2].toFixed(1)}</ele>`
          : '';
        return `      <trkpt lat="${c[0]}" lon="${c[1]}">${ele}</trkpt>`;
      })
      .join('\n');
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="PatTool GPS"',
      '  xmlns="http://www.topografix.com/GPX/1/1"',
      '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
      '  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
      '  <metadata>',
      `    <name>${safeName}</name>`,
      `    <desc>${safeDesc}</desc>`,
      `    <time>${now}</time>`,
      '  </metadata>',
      '  <trk>',
      `    <name>${safeName}</name>`,
      `    <type>${this.escapeXml(this.profile)}</type>`,
      '    <trkseg>',
      trkpts,
      '    </trkseg>',
      '  </trk>',
      '</gpx>',
      ''
    ].join('\n');
  }

  private buildGpxFileName(fromLabel: string, toLabel: string): string {
    const slug = (value: string) =>
      value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .toLowerCase() || 'route';
    return `pattool-${slug(fromLabel)}-${slug(toLabel)}.gpx`;
  }

  private escapeXml(value: string): string {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private restoreDraft(): void {
    try {
      const raw = localStorage.getItem(GpsRoutingComponent.DRAFT_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const draft = JSON.parse(raw);
      if (draft?.profile && this.profiles.some((p) => p.id === draft.profile)) {
        this.profile = draft.profile;
      }
      if (draft?.from && this.isValidPoint(draft.from)) {
        this.fromPoint = {
          lat: Number(draft.from.lat),
          lon: Number(draft.from.lon),
          label: String(draft.from.label || '')
        };
        this.fromQuery = this.fromPoint.label || `${this.fromPoint.lat.toFixed(5)}, ${this.fromPoint.lon.toFixed(5)}`;
      }
      if (draft?.to && this.isValidPoint(draft.to)) {
        const lat = Number(draft.to.lat);
        const lon = Number(draft.to.lon);
        if (lat !== 0 || lon !== 0) {
          this.toPoint = {
            lat,
            lon,
            label: String(draft.to.label || '')
          };
          this.toQuery = this.toPoint.label || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        }
      }
      if (Array.isArray(draft?.vias)) {
        this.vias = draft.vias
          .slice(0, GpsRoutingComponent.MAX_VIA_POINTS)
          .map((p: any) => {
            if (this.isValidPoint(p)) {
              return this.newViaStop({
                lat: Number(p.lat),
                lon: Number(p.lon),
                label: String(p.label || '')
              });
            }
            return this.newViaStop(null, String(p.label || p.query || ''));
          });
      }
    } catch {
      // ignore corrupt draft
    }
  }

  private persistDraft(): void {
    try {
      const payload = {
        profile: this.profile,
        from: this.fromPoint,
        to: this.toPoint,
        vias: this.vias.map((v) => v.point && this.isValidPoint(v.point)
          ? { ...v.point }
          : { label: v.query || '' }),
        savedAt: Date.now()
      };
      localStorage.setItem(GpsRoutingComponent.DRAFT_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // quota / private mode
    }
  }

  private saveSuccessfulSearch(data: OpenRouteDirections | null, alsoPersistServer = false): void {
    if (!this.fromPoint || !this.toPoint) {
      return;
    }
    const vias = this.resolvedViaPoints();
    const entry: GpsHistoryEntry = {
      id: `${Date.now()}-${Math.round(this.fromPoint.lat * 1e5)}-${Math.round(this.toPoint.lon * 1e5)}`,
      profile: this.profile,
      from: { ...this.fromPoint },
      to: { ...this.toPoint },
      vias: vias.map((p) => ({ ...p })),
      distanceMeters: data?.distanceMeters,
      durationSeconds: data?.durationSeconds,
      savedAt: Date.now(),
      ownerUsername: this.currentOwnerUsername(),
      coordinates: data?.coordinates?.length ? data.coordinates : undefined
    };
    const next = [entry, ...this.recentSearches.filter((e) => !this.sameRoute(e, entry))]
      .slice(0, GpsRoutingComponent.HISTORY_MAX);
    this.recentSearches = next;
    this.persistLocalOnlyHistory();
    this.historyOpen = true;
    if (alsoPersistServer) {
      this.persistEntryToServer(entry);
    }
  }

  private persistEntryToServer(entry: GpsHistoryEntry, onSaved?: (saved: GpsHistoryEntry) => void): void {
    if (entry.sharedWithMe) {
      return;
    }
    this.api.createGpsItinerary({
      profile: entry.profile,
      from: entry.from,
      to: entry.to,
      vias: entry.vias || [],
      distanceMeters: entry.distanceMeters,
      durationSeconds: entry.durationSeconds,
      coordinates: entry.coordinates || this.route?.coordinates
    }).subscribe({
      next: (it) => {
        const saved = this.mergeServerItinerary(it, entry.id);
        onSaved?.(saved);
        this.cdr.detectChanges();
      },
      error: () => {
        // Local history still available offline.
        this.cdr.detectChanges();
      }
    });
  }

  private refreshServerItineraries(): void {
    this.api.listGpsItineraries().subscribe({
      next: (list) => {
        for (const it of list || []) {
          this.mergeServerItinerary(it);
        }
        this.recentSearches = this.recentSearches
          .slice()
          .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
          .slice(0, GpsRoutingComponent.HISTORY_MAX);
        this.persistLocalOnlyHistory();
        if (this.recentSearches.length) {
          this.historyOpen = true;
        }
        this.cdr.detectChanges();
      },
      error: () => { /* offline / unauthenticated */ }
    });
  }

  private mergeServerItinerary(it: GpsItinerary, replaceLocalId?: string): GpsHistoryEntry {
    const mapped = this.mapServerItinerary(it);
    this.recentSearches = [
      mapped,
      ...this.recentSearches.filter((e) => {
        if (replaceLocalId && e.id === replaceLocalId) {
          return false;
        }
        if (e.serverId && e.serverId === mapped.serverId) {
          return false;
        }
        return !this.sameRoute(e, mapped);
      })
    ].slice(0, GpsRoutingComponent.HISTORY_MAX);
    this.persistLocalOnlyHistory();
    return mapped;
  }

  private mapServerItinerary(it: GpsItinerary): GpsHistoryEntry {
    return {
      id: it.id,
      serverId: it.id,
      profile: (this.profiles.some((p) => p.id === it.profile) ? it.profile : 'driving-car') as OpenRouteProfile,
      from: {
        lat: Number(it.from?.lat),
        lon: Number(it.from?.lon),
        label: String(it.from?.label || '')
      },
      to: {
        lat: Number(it.to?.lat),
        lon: Number(it.to?.lon),
        label: String(it.to?.label || '')
      },
      vias: (it.vias || [])
        .filter((p) => this.isValidPoint(p))
        .map((p) => ({
          lat: Number(p.lat),
          lon: Number(p.lon),
          label: String(p.label || '')
        })),
      distanceMeters: typeof it.distanceMeters === 'number' ? it.distanceMeters : undefined,
      durationSeconds: typeof it.durationSeconds === 'number' ? it.durationSeconds : undefined,
      savedAt: it.updatedAt ? Date.parse(it.updatedAt) || Date.now() : Date.now(),
      ownerUsername: it.ownerUsername || undefined,
      sharedWithMe: !!it.sharedWithMe,
      sharedWithMemberIds: it.sharedWithMemberIds || [],
      sharedWithUsernames: it.sharedWithUsernames || [],
      coordinates: it.coordinates?.length ? it.coordinates : undefined
    };
  }

  /** Persist only local (non-server / owned mirror without shared-only) entries for offline cache. */
  private persistLocalOnlyHistory(): void {
    const local = this.recentSearches.filter((e) => !e.sharedWithMe);
    this.writeHistory(local);
  }

  private loadHistory(): GpsHistoryEntry[] {
    try {
      const raw = localStorage.getItem(GpsRoutingComponent.HISTORY_STORAGE_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .filter((e: any) => e && this.isValidPoint(e.from) && this.isValidPoint(e.to))
        .map((e: any) => ({
          id: String(e.id || `${e.savedAt}-${e.from.lat}-${e.to.lon}`),
          profile: (this.profiles.some((p) => p.id === e.profile) ? e.profile : 'driving-car') as OpenRouteProfile,
          from: {
            lat: Number(e.from.lat),
            lon: Number(e.from.lon),
            label: String(e.from.label || '')
          },
          to: {
            lat: Number(e.to.lat),
            lon: Number(e.to.lon),
            label: String(e.to.label || '')
          },
          vias: Array.isArray(e.vias)
            ? e.vias.filter((p: any) => this.isValidPoint(p)).map((p: any) => ({
                lat: Number(p.lat),
                lon: Number(p.lon),
                label: String(p.label || '')
              }))
            : [],
          distanceMeters: typeof e.distanceMeters === 'number' ? e.distanceMeters : undefined,
          durationSeconds: typeof e.durationSeconds === 'number' ? e.durationSeconds : undefined,
          savedAt: Number(e.savedAt) || 0,
          ownerUsername: typeof e.ownerUsername === 'string' && e.ownerUsername.trim()
            ? e.ownerUsername.trim()
            : undefined,
          serverId: typeof e.serverId === 'string' && e.serverId.trim() ? e.serverId.trim() : undefined,
          sharedWithMemberIds: Array.isArray(e.sharedWithMemberIds) ? e.sharedWithMemberIds.map(String) : undefined,
          sharedWithUsernames: Array.isArray(e.sharedWithUsernames) ? e.sharedWithUsernames.map(String) : undefined,
          coordinates: Array.isArray(e.coordinates) ? e.coordinates : undefined
        }))
        .slice(0, GpsRoutingComponent.HISTORY_MAX);
    } catch {
      return [];
    }
  }

  private writeHistory(entries: GpsHistoryEntry[]): void {
    try {
      localStorage.setItem(GpsRoutingComponent.HISTORY_STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // quota / private mode
    }
  }

  private isValidPoint(point: any): boolean {
    return !!point
      && Number.isFinite(Number(point.lat))
      && Number.isFinite(Number(point.lon));
  }

  resolvedViaPoints(): PlacePoint[] {
    return this.vias
      .filter((v) => v.point && this.isValidPoint(v.point))
      .map((v) => ({ ...v.point! }));
  }

  private newViaStop(point?: PlacePoint | null, query = ''): ViaStop {
    const resolved = point && this.isValidPoint(point)
      ? { lat: Number(point.lat), lon: Number(point.lon), label: String(point.label || '') }
      : null;
    return {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      query: query || resolved?.label || '',
      point: resolved,
      results: [],
      activeIndex: -1,
      searching: false
    };
  }

  private routeTitle(fromLabel: string, toLabel: string): string {
    const vias = this.resolvedViaPoints();
    if (!vias.length) {
      return `${fromLabel} → ${toLabel}`;
    }
    const viaPart = vias.map((v, i) => this.shortLabel(v.label || String(i + 1), 22)).join(' → ');
    return `${fromLabel} → ${viaPart} → ${toLabel}`;
  }

  private sameRoute(a: GpsHistoryEntry, b: GpsHistoryEntry): boolean {
    if (a.profile !== b.profile || !this.sameCoord(a.from, b.from) || !this.sameCoord(a.to, b.to)) {
      return false;
    }
    const av = a.vias || [];
    const bv = b.vias || [];
    if (av.length !== bv.length) {
      return false;
    }
    return av.every((p, i) => this.sameCoord(p, bv[i]));
  }

  private sameCoord(a: PlacePoint | undefined, b: PlacePoint | undefined): boolean {
    if (!a || !b) {
      return false;
    }
    return Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5;
  }
}

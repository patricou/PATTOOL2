import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import * as L from 'leaflet';

import { Member } from '../model/member';
import { Friend } from '../model/friend';
import { FriendsService } from '../services/friends.service';
import { MembersService } from '../services/members.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { ApiService } from '../services/api.service';
import { LeafletBasemapService } from '../shared/leaflet-basemap.service';
import { PositionService } from '../services/position.service';
import { copyPlainTextToClipboard, preferNativeFileShare } from '../shared/clipboard-copy';

export interface SosContact {
  id: string;
  name: string;
  whatsappLink?: string;
  phone: string | null;
  selected: boolean;
  sent: boolean;
}

type SosChannel = 'whatsapp' | 'sms';

@Component({
  selector: 'app-sos',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, TranslateModule],
  templateUrl: './sos.component.html',
  styleUrls: ['./sos.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SosComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('mapHost') mapHost?: ElementRef<HTMLDivElement>;

  latitude: number | null = null;
  longitude: number | null = null;
  accuracyM: number | null = null;
  locationSource: 'gps' | 'ip' | null = null;
  locating = true;
  locationError = false;
  address: string | null = null;
  addressLoading = false;

  contacts: SosContact[] = [];
  contactsLoading = false;
  contactsError = false;

  customMessage = '';
  messageIsCustom = false;
  clipboardCopied = false;
  sendFeedback: 'idle' | 'opened' | 'blocked' | 'need-contact' | 'sms-desktop' = 'idle';
  remainingToSend: SosContact[] = [];
  lastChannel: SosChannel = 'whatsapp';

  private map: L.Map | null = null;
  private baseLayer: L.TileLayer | L.LayerGroup | null = null;
  private marker: L.Marker | null = null;
  private accuracyCircle: L.Circle | null = null;
  private geoWatchId: number | null = null;
  private langSub?: Subscription;
  private posSub?: Subscription;
  private friendsSub?: Subscription;
  private geocodeSub?: Subscription;
  private geocodedLat: number | null = null;
  private geocodedLon: number | null = null;
  private clipboardTimer: ReturnType<typeof setTimeout> | null = null;
  private mapReady = false;
  private defaultMessage = '';

  private static readonly CONTACTS_KEY = 'pattool.sos.contacts';
  private static readonly MESSAGE_KEY = 'pattool.sos.message';

  constructor(
    private readonly cdr: ChangeDetectorRef,
    private readonly ngZone: NgZone,
    private readonly translate: TranslateService,
    private readonly friendsService: FriendsService,
    private readonly members: MembersService,
    private readonly keycloak: KeycloakService,
    private readonly basemap: LeafletBasemapService,
    private readonly position: PositionService,
    private readonly api: ApiService,
    private readonly sanitizer: DomSanitizer
  ) {}

  ngOnInit(): void {
    this.fixLeafletIcons();
    this.applyDefaultMessage(this.translate.instant('SOS.DEFAULT_MESSAGE'));
    this.restoreMessage();
    this.translate.get('SOS.DEFAULT_MESSAGE').subscribe((t) => this.applyDefaultMessage(t));
    this.langSub = this.translate.onLangChange.subscribe(() => {
      this.translate.get('SOS.DEFAULT_MESSAGE').subscribe((t) => this.applyDefaultMessage(t));
    });
    this.loadContacts();
    this.locateUser(true);
  }

  ngAfterViewInit(): void {
    this.mapReady = true;
    this.ensureMap();
    this.syncMarker();
  }

  ngOnDestroy(): void {
    this.langSub?.unsubscribe();
    this.posSub?.unsubscribe();
    this.friendsSub?.unsubscribe();
    this.geocodeSub?.unsubscribe();
    if (this.clipboardTimer) {
      clearTimeout(this.clipboardTimer);
    }
    this.stopWatch();
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
  }

  get isLoggedIn(): boolean {
    return this.keycloak.isLoggedIn();
  }

  get hasPosition(): boolean {
    return this.latitude != null && this.longitude != null
      && Number.isFinite(this.latitude) && Number.isFinite(this.longitude);
  }

  get selectedContacts(): SosContact[] {
    return this.contacts.filter((c) => c.selected && !!c.phone);
  }

  get selectableCount(): number {
    return this.contacts.filter((c) => !!c.phone).length;
  }

  get fullMessage(): string {
    const body = (this.customMessage || this.defaultMessage || '').trim();
    const params = this.positionParams();
    const pos = this.hasPosition
      ? this.translate.instant('SOS.POSITION_BLOCK', params)
      : this.translate.instant('SOS.POSITION_UNKNOWN', params);
    return `${body}\n\n${pos}`.trim();
  }

  get fullMessageHtml(): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(this.whatsAppMarkdownToHtml(this.fullMessage));
  }

  locateUser(startWatch = false): void {
    this.locating = true;
    this.locationError = false;
    this.cdr.markForCheck();
    this.posSub?.unsubscribe();
    this.posSub = this.position.getGpsPosition().subscribe({
      next: (gps) => {
        if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
          this.applyCoords(gps.latitude, gps.longitude, 'gps', true);
          if (startWatch) {
            this.startWatch();
          }
          return;
        }
        this.position.getIpPosition().subscribe({
          next: (ip) => {
            if (this.locationSource === 'gps') {
              return;
            }
            if (ip && Number.isFinite(ip.latitude) && Number.isFinite(ip.longitude)) {
              this.applyCoords(ip.latitude, ip.longitude, 'ip', true);
            } else {
              this.locating = false;
              this.locationError = !this.hasPosition;
              this.cdr.markForCheck();
            }
          },
          error: () => {
            this.locating = false;
            this.locationError = !this.hasPosition;
            this.cdr.markForCheck();
          }
        });
        if (startWatch) {
          this.startWatch();
        }
      },
      error: () => {
        this.locating = false;
        this.locationError = !this.hasPosition;
        this.cdr.markForCheck();
        if (startWatch) {
          this.startWatch();
        }
      }
    });
  }

  onMessageChange(value: string): void {
    this.customMessage = value;
    const def = (this.defaultMessage || '').trim();
    this.messageIsCustom = value.trim() !== def;
    this.persistMessage();
    this.cdr.markForCheck();
  }

  resetMessage(): void {
    this.customMessage = this.defaultMessage;
    this.messageIsCustom = false;
    this.persistMessage();
    this.cdr.markForCheck();
  }

  toggleContact(contact: SosContact): void {
    if (!contact.phone) {
      return;
    }
    contact.selected = !contact.selected;
    this.persistContacts();
    this.cdr.markForCheck();
  }

  selectAll(): void {
    for (const c of this.contacts) {
      if (c.phone) {
        c.selected = true;
      }
    }
    this.persistContacts();
    this.cdr.markForCheck();
  }

  selectNone(): void {
    for (const c of this.contacts) {
      c.selected = false;
    }
    this.persistContacts();
    this.cdr.markForCheck();
  }

  sendSos(channel: SosChannel): void {
    this.lastChannel = channel;
    const text = this.fullMessage;
    if (!text) {
      return;
    }
    copyPlainTextToClipboard(text);
    this.clipboardCopied = true;
    if (this.clipboardTimer) {
      clearTimeout(this.clipboardTimer);
    }
    this.clipboardTimer = setTimeout(() => {
      this.clipboardCopied = false;
      this.cdr.markForCheck();
    }, 4000);

    const targets = this.selectedContacts;
    if (targets.length === 0) {
      this.sendFeedback = 'need-contact';
      this.remainingToSend = [];
      this.openChannel(channel, null, text);
      this.cdr.markForCheck();
      return;
    }

    for (const c of this.contacts) {
      c.sent = false;
    }
    const first = targets[0];
    const opened = this.openChannel(channel, first.phone, text);
    first.sent = opened;
    this.remainingToSend = targets.slice(1);
    if (channel === 'sms' && !this.canUseNativeSms()) {
      this.sendFeedback = 'sms-desktop';
    } else {
      this.sendFeedback = opened
        ? (this.remainingToSend.length ? 'blocked' : 'opened')
        : 'blocked';
    }
    this.cdr.markForCheck();
  }

  sendToContact(contact: SosContact, channel: SosChannel = this.lastChannel): void {
    this.lastChannel = channel;
    const text = this.fullMessage;
    copyPlainTextToClipboard(text);
    const opened = this.openChannel(channel, contact.phone, text);
    contact.sent = opened;
    this.remainingToSend = this.remainingToSend.filter((c) => c.id !== contact.id);
    if (channel === 'sms' && !this.canUseNativeSms()) {
      this.sendFeedback = 'sms-desktop';
    } else {
      this.sendFeedback = opened ? 'opened' : 'blocked';
    }
    this.cdr.markForCheck();
  }

  trackById(_index: number, row: SosContact): string {
    return row.id;
  }

  private loadContacts(): void {
    if (!this.isLoggedIn) {
      this.contacts = [];
      this.contactsLoading = false;
      this.cdr.markForCheck();
      return;
    }
    this.contactsLoading = true;
    this.contactsError = false;
    this.friendsSub?.unsubscribe();
    this.friendsSub = this.friendsService.getFriends().subscribe({
      next: (friends: Friend[]) => {
        const myName = (this.keycloak.getUsernameForDisplay() || '').trim().toLowerCase();
        const saved = new Set(this.readSavedContactIds());
        const rows: SosContact[] = [];
        for (const f of friends || []) {
          const other = this.otherFriendMember(f, myName);
          if (!other?.id) {
            continue;
          }
          const phone = this.extractPhone(other.whatsappLink);
          const selected = saved.size > 0 ? saved.has(other.id) && !!phone : !!phone;
          rows.push({
            id: other.id,
            name: this.displayName(other),
            whatsappLink: other.whatsappLink,
            phone,
            selected,
            sent: false
          });
        }
        rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        this.contacts = rows;
        this.contactsLoading = false;
        this.contactsError = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.contactsLoading = false;
        this.contactsError = true;
        this.cdr.markForCheck();
      }
    });
  }

  private startWatch(): void {
    if (typeof navigator === 'undefined' || !navigator.geolocation || this.geoWatchId != null) {
      return;
    }
    this.geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.ngZone.run(() => {
          this.latitude = pos.coords.latitude;
          this.longitude = pos.coords.longitude;
          this.accuracyM = Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null;
          this.locationSource = 'gps';
          this.locating = false;
          this.locationError = false;
          this.ensureMap();
          this.syncMarker(false);
          this.requestAddress(pos.coords.latitude, pos.coords.longitude, false);
          this.cdr.markForCheck();
        });
      },
      () => {
        /* keep last known fix */
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
  }

  private stopWatch(): void {
    if (this.geoWatchId != null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.geoWatchId);
    }
    this.geoWatchId = null;
  }

  private ensureMap(): void {
    if (!this.mapReady) {
      return;
    }
    const el = this.mapHost?.nativeElement;
    if (!el || this.map) {
      this.map?.invalidateSize();
      return;
    }
    this.map = L.map(el, {
      zoomControl: true,
      attributionControl: true
    });
    this.baseLayer = this.basemap.applyBaseLayer(this.map, 'osm-standard', null);
    const lat = this.latitude ?? 46.6;
    const lon = this.longitude ?? 2.5;
    const zoom = this.hasPosition ? 16 : 5;
    this.map.setView([lat, lon], zoom);
    setTimeout(() => this.map?.invalidateSize(), 0);
  }

  private syncMarker(fit = false): void {
    if (!this.map || !this.hasPosition || this.latitude == null || this.longitude == null) {
      return;
    }
    const latLng: L.LatLngExpression = [this.latitude, this.longitude];
    if (!this.marker) {
      this.marker = L.marker(latLng, {
        icon: L.divIcon({
          className: 'sos-user-marker',
          html: '<div class="sos-user-marker-pulse"></div><div class="sos-user-marker-dot"></div>',
          iconSize: [32, 32],
          iconAnchor: [16, 16]
        }),
        keyboard: false,
        title: 'SOS'
      }).addTo(this.map);
    } else {
      this.marker.setLatLng(latLng);
    }
    if (this.accuracyM != null && this.accuracyM > 0 && this.accuracyM < 5000) {
      if (!this.accuracyCircle) {
        this.accuracyCircle = L.circle(latLng, {
          radius: this.accuracyM,
          color: '#dc2626',
          weight: 1,
          fillColor: '#ef4444',
          fillOpacity: 0.12
        }).addTo(this.map);
      } else {
        this.accuracyCircle.setLatLng(latLng);
        this.accuracyCircle.setRadius(this.accuracyM);
      }
    }
    if (fit) {
      this.map.setView(latLng, Math.max(this.map.getZoom(), 16));
    } else {
      this.map.panTo(latLng, { animate: true });
    }
  }

  private openWhatsApp(phone: string | null, text: string): boolean {
    const encoded = encodeURIComponent(text);
    const mobile = preferNativeFileShare();
    let url: string;
    if (phone) {
      url = mobile
        ? `https://api.whatsapp.com/send?phone=${phone}&text=${encoded}`
        : `https://wa.me/${phone}?text=${encoded}`;
    } else {
      url = mobile
        ? `https://api.whatsapp.com/send?text=${encoded}`
        : `https://wa.me/?text=${encoded}`;
    }
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    return !!win;
  }

  private openChannel(channel: SosChannel, phone: string | null, text: string): boolean {
    return channel === 'sms' ? this.openSms(phone, text) : this.openWhatsApp(phone, text);
  }

  private openSms(phone: string | null, text: string): boolean {
    const url = this.smsUrl(phone, text);
    try {
      const opened = window.open(url, '_blank');
      if (opened) {
        return true;
      }
    } catch {
      /* fall through */
    }
    try {
      window.location.href = url;
      return true;
    } catch {
      return false;
    }
  }

  private smsUrl(phone: string | null, text: string): string {
    const encoded = encodeURIComponent(text);
    const number = phone ? `+${phone.replace(/^\+/, '')}` : '';
    if (this.isAppleMobile()) {
      return number ? `sms:${number}&body=${encoded}` : `sms:&body=${encoded}`;
    }
    return number ? `sms:${number}?body=${encoded}` : `sms:?body=${encoded}`;
  }

  private canUseNativeSms(): boolean {
    return preferNativeFileShare() || this.isAppleMobile();
  }

  private isAppleMobile(): boolean {
    if (typeof navigator === 'undefined') {
      return false;
    }
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/i.test(ua)) {
      return true;
    }
    return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
  }

  private positionParams(): Record<string, string> {
    const now = new Date();
    const locale = this.localeTag();
    const dateRaw = now.toLocaleDateString(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
    const clock = now.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    let timeZone = '';
    try {
      const tzPart = new Intl.DateTimeFormat(locale, { timeZoneName: 'long' })
        .formatToParts(now)
        .find((part) => part.type === 'timeZoneName');
      timeZone = tzPart?.value?.trim() || '';
    } catch {
      timeZone = '';
    }
    const latS = this.hasPosition && this.latitude != null ? this.latitude.toFixed(6) : '';
    const lonS = this.hasPosition && this.longitude != null ? this.longitude.toFixed(6) : '';
    const accuracy = this.hasPosition && this.accuracyM != null && this.locationSource === 'gps'
      ? this.translate.instant('SOS.ACCURACY_LINE', { meters: Math.round(this.accuracyM) })
      : '';
    return {
      lat: latS,
      lon: lonS,
      address: this.addressLabelForMessage(),
      accuracy,
      gmaps: latS && lonS ? `https://maps.google.com/?q=${latS},${lonS}` : '',
      osm: latS && lonS
        ? `https://www.openstreetmap.org/?mlat=${latS}&mlon=${lonS}#map=17/${latS}/${lonS}`
        : '',
      date: this.capitalizeFirst(dateRaw),
      clock: timeZone ? `${clock} (${timeZone})` : clock,
      time: `${this.capitalizeFirst(dateRaw)} ${clock}`,
      sender: this.senderLabel(),
      fullName: this.senderFullName() || this.senderUserName() || 'PatTool',
      user: this.senderUserName() || 'PatTool'
    };
  }

  private capitalizeFirst(value: string): string {
    const v = (value || '').trim();
    if (!v) {
      return v;
    }
    return v.charAt(0).toUpperCase() + v.slice(1);
  }

  private whatsAppMarkdownToHtml(text: string): string {
    const escaped = (text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return escaped
      .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  private senderFullName(): string {
    const member = this.currentMember();
    const first = (member.firstName || '').trim();
    const last = (member.lastName || '').trim();
    return `${first} ${last}`.trim();
  }

  private senderUserName(): string {
    const fromMember = (this.currentMember().userName || '').trim();
    return fromMember || (this.keycloak.getUsernameForDisplay() || '').trim();
  }

  private senderLabel(): string {
    const full = this.senderFullName();
    const user = this.senderUserName();
    if (full && user && full.toLowerCase() !== user.toLowerCase()) {
      return `${full} (${user})`;
    }
    return full || user || 'PatTool';
  }

  private currentMember(): Member {
    let stored: Member | null = null;
    try {
      stored = this.members.getUser();
    } catch {
      stored = null;
    }
    let kc: Member | null = null;
    try {
      kc = this.keycloak.getUserAsMember();
    } catch {
      kc = null;
    }
    return new Member(
      stored?.id || kc?.id || '',
      stored?.addressEmail || kc?.addressEmail || '',
      (stored?.firstName || kc?.firstName || '').trim(),
      (stored?.lastName || kc?.lastName || '').trim(),
      (stored?.userName || kc?.userName || this.keycloak.getUsernameForDisplay() || '').trim(),
      stored?.roles || kc?.roles || [],
      stored?.keycloakId || kc?.keycloakId || ''
    );
  }

  private localeTag(): string {
    const lang = (this.translate.currentLang || 'fr').toLowerCase();
    const map: Record<string, string> = {
      fr: 'fr-FR', en: 'en-GB', de: 'de-DE', es: 'es-ES', it: 'it-IT',
      ar: 'ar', cn: 'zh-CN', jp: 'ja-JP', ru: 'ru-RU', he: 'he-IL',
      el: 'el-GR', in: 'hi-IN'
    };
    return map[lang] || lang;
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

  private displayName(member: Member): string {
    const user = (member.userName || '').trim();
    if (user) {
      return user;
    }
    const full = `${member.firstName || ''} ${member.lastName || ''}`.trim();
    return full || member.id || '—';
  }

  private extractPhone(link: string | undefined): string | null {
    if (!link) {
      return null;
    }
    const wa = link.match(/wa\.me\/(\d+)/i);
    if (wa?.[1]) {
      return wa[1];
    }
    const phone = link.match(/[?&]phone=(\d+)/i);
    if (phone?.[1]) {
      return phone[1];
    }
    const digits = link.replace(/\D/g, '');
    return digits.length >= 8 ? digits : null;
  }

  private storageOwner(): string {
    return this.keycloak.getUsernameForDisplay() || 'anon';
  }

  private restoreMessage(): void {
    try {
      const raw = localStorage.getItem(`${SosComponent.MESSAGE_KEY}:${this.storageOwner()}`);
      if (raw && raw.trim() && raw.trim() !== (this.defaultMessage || '').trim()) {
        this.customMessage = raw;
        this.messageIsCustom = true;
        return;
      }
    } catch {
      /* ignore */
    }
    this.customMessage = this.defaultMessage;
    this.messageIsCustom = false;
  }

  private persistMessage(): void {
    try {
      const key = `${SosComponent.MESSAGE_KEY}:${this.storageOwner()}`;
      if (this.messageIsCustom && this.customMessage.trim()) {
        localStorage.setItem(key, this.customMessage);
      } else {
        localStorage.removeItem(key);
      }
    } catch {
      /* ignore */
    }
  }

  private readSavedContactIds(): string[] {
    try {
      const raw = localStorage.getItem(`${SosComponent.CONTACTS_KEY}:${this.storageOwner()}`);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  private persistContacts(): void {
    try {
      const ids = this.contacts.filter((c) => c.selected).map((c) => c.id);
      localStorage.setItem(
        `${SosComponent.CONTACTS_KEY}:${this.storageOwner()}`,
        JSON.stringify(ids)
      );
    } catch {
      /* ignore */
    }
  }

  private applyDefaultMessage(value: string): void {
    if (!value || value === 'SOS.DEFAULT_MESSAGE') {
      return;
    }
    this.defaultMessage = value;
    if (!this.messageIsCustom) {
      this.customMessage = value;
    }
    this.cdr.markForCheck();
  }

  private applyCoords(lat: number, lon: number, source: 'gps' | 'ip', fit: boolean): void {
    this.ngZone.run(() => {
      this.latitude = lat;
      this.longitude = lon;
      this.locationSource = source;
      if (source !== 'gps') {
        this.accuracyM = null;
      }
      this.locating = false;
      this.locationError = false;
      this.ensureMap();
      this.syncMarker(fit);
      this.requestAddress(lat, lon, true);
      this.cdr.markForCheck();
    });
  }

  private addressLabelForMessage(): string {
    const found = (this.address || '').trim();
    if (found) {
      return found;
    }
    if (this.addressLoading) {
      return this.translate.instant('SOS.ADDRESS_LOADING');
    }
    return this.translate.instant('SOS.ADDRESS_UNKNOWN');
  }

  private requestAddress(lat: number, lon: number, force: boolean): void {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return;
    }
    if (!force && this.geocodedLat != null && this.geocodedLon != null) {
      if (this.metersBetween(lat, lon, this.geocodedLat, this.geocodedLon) < 40) {
        return;
      }
    }
    this.addressLoading = true;
    this.geocodeSub?.unsubscribe();
    this.geocodeSub = this.api.geocodeReverse(lat, lon).subscribe({
      next: (data) => {
        const formatted = this.formatReverseGeocodeAddress(data);
        this.address = formatted || null;
        this.addressLoading = false;
        this.geocodedLat = lat;
        this.geocodedLon = lon;
        this.cdr.markForCheck();
      },
      error: () => {
        this.addressLoading = false;
        if (!this.address) {
          this.address = null;
        }
        this.cdr.markForCheck();
      }
    });
  }

  private formatReverseGeocodeAddress(data: unknown): string {
    const row = data as {
      error?: unknown;
      address?: Record<string, unknown>;
      display_name?: string;
      displayName?: string;
    } | null;
    if (!row || row.error) {
      return '';
    }
    const addr = row.address;
    if (addr && typeof addr === 'object') {
      const parts: string[] = [];
      const road = this.asText(addr['road'] ?? addr['street']);
      const houseNumber = this.asText(addr['house_number'] ?? addr['housenumber']);
      if (houseNumber && road) {
        parts.push(`${houseNumber} ${road}`);
      } else if (road) {
        parts.push(road);
      } else {
        const named = this.asText(addr['name']);
        if (named) {
          parts.push(named);
        }
      }
      const postcode = this.asText(addr['postcode']);
      const locality = this.asText(
        addr['city'] ?? addr['town'] ?? addr['village'] ?? addr['municipality']
      );
      if (postcode && locality) {
        parts.push(`${postcode} ${locality}`);
      } else {
        if (postcode) {
          parts.push(postcode);
        }
        if (locality) {
          parts.push(locality);
        }
      }
      const region = this.asText(addr['state'] ?? addr['region'] ?? addr['county']);
      if (region && region !== locality) {
        parts.push(region);
      }
      const country = this.asText(addr['country']);
      if (country) {
        parts.push(country);
      }
      if (parts.length > 0) {
        return parts.join(', ');
      }
    }
    return this.asText(row.display_name ?? row.displayName);
  }

  private asText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private metersBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  private fixLeafletIcons(): void {
    delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: 'assets/leaflet/images/marker-icon-2x.png',
      iconUrl: 'assets/leaflet/images/marker-icon.png',
      shadowUrl: 'assets/leaflet/images/marker-shadow.png'
    });
  }
}

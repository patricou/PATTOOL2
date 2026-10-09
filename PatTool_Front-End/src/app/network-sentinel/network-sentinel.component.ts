import { Component, HostListener, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription, timer } from 'rxjs';
import { KeycloakService } from '../keycloak/keycloak.service';
import {
  NetworkSentinelService,
  SentinelCapabilities,
  SentinelFinding,
  SentinelFlow,
  SentinelLive,
  SentinelLogon,
  SentinelPrefs,
  SentinelSeverity,
  SentinelStatus,
  SentinelStreamEvent,
  SentinelSweep,
  SentinelSweepSummary
} from '../services/network-sentinel.service';

type Tab = 'findings' | 'live' | 'capture' | 'access' | 'history' | 'settings';
type FlowFilter = 'all' | 'inboundPublic' | 'outboundPublic' | 'lan' | 'listeners';

const SEVERITY_ORDER: SentinelSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const LIVE_REFRESH_MS = 5000;

/**
 * Maison › Sentinelle réseau (admin). Watches the PatTool host and its LAN for intrusions that already
 * succeeded: established inbound connections from the Internet, new listeners, new logons, unknown LAN
 * devices, ARP spoofing, scans and suspicious traffic seen in a short packet capture.
 */
@Component({
  selector: 'app-network-sentinel',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, RouterLink],
  templateUrl: './network-sentinel.component.html',
  styleUrls: ['./network-sentinel.component.css']
})
export class NetworkSentinelComponent implements OnInit, OnDestroy {
  private readonly api = inject(NetworkSentinelService);
  private readonly keycloak = inject(KeycloakService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);

  readonly severities = SEVERITY_ORDER;

  readonly guideSections: { icon: string; titleKey: string; bodyKey: string }[] = [
    { icon: 'fa-shield', titleKey: 'NETWORK_SENTINEL.GUIDE.S1_TITLE', bodyKey: 'NETWORK_SENTINEL.GUIDE.S1_BODY' },
    { icon: 'fa-eye', titleKey: 'NETWORK_SENTINEL.GUIDE.S2_TITLE', bodyKey: 'NETWORK_SENTINEL.GUIDE.S2_BODY' },
    { icon: 'fa-graduation-cap', titleKey: 'NETWORK_SENTINEL.GUIDE.S3_TITLE', bodyKey: 'NETWORK_SENTINEL.GUIDE.S3_BODY' },
    { icon: 'fa-play', titleKey: 'NETWORK_SENTINEL.GUIDE.S4_TITLE', bodyKey: 'NETWORK_SENTINEL.GUIDE.S4_BODY' },
    { icon: 'fa-exclamation-circle', titleKey: 'NETWORK_SENTINEL.GUIDE.S5_TITLE', bodyKey: 'NETWORK_SENTINEL.GUIDE.S5_BODY' },
    { icon: 'fa-exchange', titleKey: 'NETWORK_SENTINEL.GUIDE.S6_TITLE', bodyKey: 'NETWORK_SENTINEL.GUIDE.S6_BODY' },
    { icon: 'fa-filter', titleKey: 'NETWORK_SENTINEL.GUIDE.S7_TITLE', bodyKey: 'NETWORK_SENTINEL.GUIDE.S7_BODY' },
    { icon: 'fa-user-secret', titleKey: 'NETWORK_SENTINEL.GUIDE.S8_TITLE', bodyKey: 'NETWORK_SENTINEL.GUIDE.S8_BODY' },
    { icon: 'fa-envelope', titleKey: 'NETWORK_SENTINEL.GUIDE.S9_TITLE', bodyKey: 'NETWORK_SENTINEL.GUIDE.S9_BODY' },
    { icon: 'fa-cog', titleKey: 'NETWORK_SENTINEL.GUIDE.S10_TITLE', bodyKey: 'NETWORK_SENTINEL.GUIDE.S10_BODY' },
    { icon: 'fa-lock', titleKey: 'NETWORK_SENTINEL.GUIDE.S11_TITLE', bodyKey: 'NETWORK_SENTINEL.GUIDE.S11_BODY' }
  ];

  guideOpen = false;

  isAuthorized = false;
  activeTab: Tab = 'findings';

  capabilities: SentinelCapabilities | null = null;
  status: SentinelStatus | null = null;
  prefs: SentinelPrefs = {};
  prefsSaving = false;
  prefsError: string | null = null;
  trustedCidrsText = '';
  expectedListenersText = '';

  // Sweep (SSE)
  sweepRunning = false;
  sweepPhase: string | null = null;
  sweepActivity = '';
  sweepDeviceProgress = 0;
  sweepDeviceTotal = 0;
  sweepDevicesFound = 0;
  sweepLiveFindings: SentinelFinding[] = [];
  sweepError: string | null = null;
  private sweepSub: Subscription | null = null;

  // Sweep options (local, initialised from prefs)
  optIncludeDeviceScan = true;
  optIncludeCapture = true;
  optCaptureSeconds = 20;
  readonly captureSecondsChoices = [10, 20, 30, 60, 90];
  readonly intervalChoices = [5, 10, 15, 30, 60, 120, 360];

  // Selected sweep (latest or from history)
  sweep: SentinelSweep | null = null;
  sweepLoading = false;
  history: SentinelSweepSummary[] = [];
  historyLoading = false;

  // Live
  live: SentinelLive | null = null;
  liveLoading = false;
  liveError: string | null = null;
  liveAutoRefresh = false;
  private liveSub: Subscription | null = null;
  flowFilter: FlowFilter = 'all';
  flowText = '';

  // Findings view
  showAcknowledged = false;
  ackBusyKey: string | null = null;

  ngOnInit(): void {
    if (!this.keycloak.hasAdminRole()) {
      this.router.navigate(['/']);
      return;
    }
    this.isAuthorized = true;
    this.loadCapabilities();
    this.loadStatus();
    this.loadPrefs();
    this.loadLatest();
    this.loadHistory();
    this.refreshLive();
  }

  ngOnDestroy(): void {
    this.sweepSub?.unsubscribe();
    this.stopLiveAutoRefresh();
  }

  openGuide(): void {
    this.guideOpen = true;
  }

  closeGuide(): void {
    this.guideOpen = false;
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.guideOpen) {
      this.closeGuide();
    }
  }

  setTab(tab: Tab): void {
    this.activeTab = tab;
    if (tab === 'live' && !this.live && !this.liveLoading) {
      this.refreshLive();
    }
    if (tab === 'history' && this.history.length === 0 && !this.historyLoading) {
      this.loadHistory();
    }
  }

  // ---------------------------------------------------------------------------------------------- loading

  loadCapabilities(): void {
    this.api.capabilities().subscribe({
      next: c => (this.capabilities = c),
      error: () => (this.capabilities = null)
    });
  }

  loadStatus(): void {
    this.api.status().subscribe({
      next: s => {
        this.status = s;
        if (s.running && !this.sweepRunning) {
          this.sweepRunning = true;
          this.sweepPhase = s.currentPhase ?? null;
        }
      },
      error: () => (this.status = null)
    });
  }

  loadPrefs(): void {
    this.api.getPrefs().subscribe({
      next: p => {
        this.prefs = p;
        this.optIncludeDeviceScan = p.includeDeviceScan ?? true;
        this.optIncludeCapture = p.includeCapture ?? true;
        this.optCaptureSeconds = p.captureSeconds ?? 20;
        this.trustedCidrsText = (p.trustedRemoteCidrs ?? []).join('\n');
        this.expectedListenersText = (p.expectedListeners ?? []).join('\n');
      },
      error: () => undefined
    });
  }

  loadLatest(): void {
    this.sweepLoading = true;
    this.api.latest().subscribe({
      next: s => {
        this.sweep = s;
        this.sweepLoading = false;
      },
      error: () => (this.sweepLoading = false)
    });
  }

  loadHistory(): void {
    this.historyLoading = true;
    this.api.history(40).subscribe({
      next: h => {
        this.history = h.sweeps ?? [];
        this.historyLoading = false;
      },
      error: () => (this.historyLoading = false)
    });
  }

  openSweep(id: string): void {
    this.sweepLoading = true;
    this.api.sweep(id).subscribe({
      next: s => {
        this.sweep = s;
        this.sweepLoading = false;
        this.activeTab = 'findings';
      },
      error: () => (this.sweepLoading = false)
    });
  }

  clearHistory(): void {
    if (!confirm(this.translate.instant('NETWORK_SENTINEL.CONFIRM_CLEAR_HISTORY'))) {
      return;
    }
    this.api.clearHistory().subscribe({
      next: () => {
        this.history = [];
        this.sweep = null;
        this.loadStatus();
      },
      error: () => undefined
    });
  }

  resetBaseline(): void {
    if (!confirm(this.translate.instant('NETWORK_SENTINEL.CONFIRM_RESET_BASELINE'))) {
      return;
    }
    this.api.resetBaseline().subscribe({
      next: () => this.loadStatus(),
      error: () => undefined
    });
  }

  // ---------------------------------------------------------------------------------------------- prefs

  private savePrefs(patch: SentinelPrefs): void {
    this.prefsSaving = true;
    this.prefsError = null;
    this.api.updatePrefs(patch).subscribe({
      next: p => {
        this.prefs = p;
        this.trustedCidrsText = (p.trustedRemoteCidrs ?? []).join('\n');
        this.expectedListenersText = (p.expectedListeners ?? []).join('\n');
        this.prefsSaving = false;
      },
      error: err => {
        this.prefsSaving = false;
        this.prefsError = err?.error?.message || err?.message || 'error';
      }
    });
  }

  toggleScheduler(): void {
    this.savePrefs({ schedulerEnabled: !(this.prefs.schedulerEnabled ?? false) });
  }

  onIntervalChange(v: number | string): void {
    this.savePrefs({ schedulerIntervalMinutes: Number(v) });
  }

  toggleEmail(): void {
    this.savePrefs({ emailAlertsEnabled: !(this.prefs.emailAlertsEnabled ?? true) });
  }

  onEmailSeverityChange(v: string): void {
    this.savePrefs({ emailMinSeverity: v as SentinelPrefs['emailMinSeverity'] });
  }

  onDefaultOptionsChange(): void {
    this.savePrefs({
      includeDeviceScan: this.optIncludeDeviceScan,
      includeCapture: this.optIncludeCapture,
      captureSeconds: this.optCaptureSeconds
    });
  }

  saveTrustAndListeners(): void {
    const cidrs = this.trustedCidrsText.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
    const listeners = this.expectedListenersText.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
    this.savePrefs({ trustedRemoteCidrs: cidrs, expectedListeners: listeners });
  }

  onCaptureInterfaceChange(v: string): void {
    this.savePrefs({ captureInterface: v && v !== '__auto__' ? v : '' });
  }

  captureInterfaceName(entry: string): string {
    const i = entry.indexOf(' (');
    return i > 0 ? entry.substring(0, i) : entry;
  }

  // ---------------------------------------------------------------------------------------------- sweep

  startSweep(): void {
    if (this.sweepRunning) {
      return;
    }
    this.sweepRunning = true;
    this.sweepError = null;
    this.sweepPhase = null;
    this.sweepActivity = '';
    this.sweepDeviceProgress = 0;
    this.sweepDeviceTotal = 0;
    this.sweepDevicesFound = 0;
    this.sweepLiveFindings = [];
    this.sweepSub?.unsubscribe();
    this.sweepSub = this.api.sweepStream({
      includeDeviceScan: this.optIncludeDeviceScan,
      includeCapture: this.optIncludeCapture,
      captureSeconds: this.optCaptureSeconds
    }).subscribe({
      next: ev => this.onSweepEvent(ev),
      error: err => {
        this.sweepRunning = false;
        this.sweepError = err?.message || 'stream error';
      },
      complete: () => {
        this.sweepRunning = false;
        this.loadStatus();
        this.loadHistory();
      }
    });
  }

  cancelSweepStream(): void {
    // Stops listening; the server finishes the sweep on its own and stores it.
    this.sweepSub?.unsubscribe();
    this.sweepSub = null;
    this.sweepRunning = false;
    this.sweepActivity = '';
    this.loadStatus();
  }

  private onSweepEvent(ev: SentinelStreamEvent): void {
    switch (ev.type) {
      case 'sweep-started':
        this.sweepPhase = 'started';
        break;
      case 'phase':
        this.sweepPhase = ev.data?.phase ?? null;
        this.sweepActivity = ev.data?.message ?? '';
        break;
      case 'status':
        this.sweepActivity = ev.data?.message ?? this.sweepActivity;
        break;
      case 'flows':
        if (this.live) {
          this.live = { ...this.live, flows: ev.data?.flows ?? this.live.flows, counts: ev.data?.counts ?? this.live.counts };
        }
        break;
      case 'device-found':
        this.sweepDevicesFound++;
        this.sweepDeviceProgress = Number(ev.data?.progress ?? this.sweepDeviceProgress);
        this.sweepDeviceTotal = Number(ev.data?.total ?? this.sweepDeviceTotal);
        break;
      case 'finding':
        this.sweepLiveFindings = [...this.sweepLiveFindings, ev.data as SentinelFinding];
        break;
      case 'sweep-completed':
        this.sweep = ev.data as SentinelSweep;
        this.sweepLiveFindings = [];
        this.sweepPhase = 'completed';
        this.sweepActivity = '';
        break;
      case 'error':
        this.sweepError = ev.data?.message || ev.data?.error || 'error';
        break;
      default:
        break;
    }
  }

  get sweepDevicePercent(): number {
    if (!this.sweepDeviceTotal) {
      return 0;
    }
    return Math.min(100, Math.round((this.sweepDeviceProgress / this.sweepDeviceTotal) * 100));
  }

  // ---------------------------------------------------------------------------------------------- live

  refreshLive(): void {
    if (this.liveLoading) {
      return;
    }
    this.liveLoading = true;
    this.liveError = null;
    this.api.live().subscribe({
      next: l => {
        this.live = l;
        this.liveLoading = false;
      },
      error: err => {
        this.liveLoading = false;
        this.liveError = err?.error?.message || err?.message || 'error';
      }
    });
  }

  toggleLiveAutoRefresh(): void {
    this.liveAutoRefresh = !this.liveAutoRefresh;
    if (this.liveAutoRefresh) {
      this.liveSub = timer(0, LIVE_REFRESH_MS).subscribe(() => this.refreshLive());
    } else {
      this.stopLiveAutoRefresh();
    }
  }

  private stopLiveAutoRefresh(): void {
    this.liveSub?.unsubscribe();
    this.liveSub = null;
    this.liveAutoRefresh = false;
  }

  get filteredFlows(): SentinelFlow[] {
    const flows = this.live?.flows ?? [];
    const text = this.flowText.trim().toLowerCase();
    return flows.filter(f => {
      switch (this.flowFilter) {
        case 'inboundPublic':
          if (!(f.direction === 'INBOUND' && f.remoteScope === 'PUBLIC')) { return false; }
          break;
        case 'outboundPublic':
          if (!(f.direction === 'OUTBOUND' && f.remoteScope === 'PUBLIC')) { return false; }
          break;
        case 'lan':
          if (f.remoteScope !== 'LAN' || f.direction === 'LISTEN') { return false; }
          break;
        case 'listeners':
          if (f.direction !== 'LISTEN' || this.isLoopback(f.localAddress)) { return false; }
          break;
        default:
          if (f.remoteScope === 'LOOPBACK') { return false; }
          if (f.direction === 'LISTEN' && this.isLoopback(f.localAddress)) { return false; }
          break;
      }
      if (!text) {
        return true;
      }
      const hay = `${f.protocol} ${f.localAddress}:${f.localPort} ${f.remoteAddress}:${f.remotePort} ${f.state} ${f.processName ?? ''} ${f.pid ?? ''} ${f.remoteScope} ${f.direction}`.toLowerCase();
      return hay.includes(text);
    });
  }

  isLoopback(a: string | null | undefined): boolean {
    return !!a && (a.startsWith('127.') || a === '::1' || a === '0:0:0:0:0:0:0:1');
  }

  // ---------------------------------------------------------------------------------------------- findings

  get currentFindings(): SentinelFinding[] {
    const base = this.sweepRunning && this.sweepLiveFindings.length > 0 ? this.sweepLiveFindings : (this.sweep?.findings ?? []);
    return this.showAcknowledged ? base : base.filter(f => !f.acknowledged);
  }

  get liveFindings(): SentinelFinding[] {
    const base = this.live?.findings ?? [];
    return this.showAcknowledged ? base : base.filter(f => !f.acknowledged);
  }

  get intrusionCount(): number {
    return this.currentFindings.filter(f => f.intrusionSucceeded && !f.acknowledged).length;
  }

  severityCount(findings: SentinelFinding[], sev: SentinelSeverity): number {
    return findings.filter(f => f.severity === sev).length;
  }

  acknowledge(f: SentinelFinding, ack: boolean): void {
    this.ackBusyKey = f.key;
    this.api.acknowledge(f.key, ack).subscribe({
      next: () => {
        f.acknowledged = ack;
        if (ack) {
          f.severity = 'INFO';
          f.intrusionSucceeded = false;
        }
        this.ackBusyKey = null;
        this.loadStatus();
      },
      error: () => (this.ackBusyKey = null)
    });
  }

  evidenceEntries(f: SentinelFinding): { key: string; value: string }[] {
    const ev = f.evidence ?? {};
    return Object.keys(ev)
      .filter(k => ev[k] !== null && ev[k] !== undefined && ev[k] !== '')
      .map(k => ({ key: k, value: Array.isArray(ev[k]) ? (ev[k] as unknown[]).join(', ') : String(ev[k]) }));
  }

  severityClass(sev: string | null | undefined): string {
    return 'sev-' + (sev ?? 'INFO').toLowerCase();
  }

  categoryIcon(category: string): string {
    switch (category) {
      case 'EXTERNAL_INBOUND': return 'fa-sign-in';
      case 'REMOTE_SESSION': return 'fa-desktop';
      case 'NEW_LISTENER': return 'fa-plug';
      case 'NEW_LOGON': return 'fa-user-secret';
      case 'UNKNOWN_DEVICE': return 'fa-question-circle';
      case 'PORT_SCAN': return 'fa-crosshairs';
      case 'HOST_SWEEP': return 'fa-binoculars';
      case 'ARP_SPOOF': return 'fa-exchange';
      case 'ARP_CHANGE': return 'fa-random';
      case 'UNKNOWN_DEVICE_TRAFFIC': return 'fa-globe';
      case 'DNS_SUSPECT': return 'fa-book';
      case 'SUSPICIOUS_OUTBOUND': return 'fa-sign-out';
      case 'HIGH_FANOUT': return 'fa-share-alt';
      case 'EXPOSED_SERVICE': return 'fa-unlock-alt';
      default: return 'fa-exclamation-triangle';
    }
  }

  categoryLabelKey(category: string): string {
    return 'NETWORK_SENTINEL.CAT.' + category;
  }

  // ---------------------------------------------------------------------------------------------- misc

  remoteAccess(sweep: SentinelSweep | null): SentinelLogon[] {
    return [...(sweep?.sessions ?? []), ...(sweep?.logons ?? [])];
  }

  formatBytes(n: number | null | undefined): string {
    if (!n) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  formatDuration(ms: number | null | undefined): string {
    if (!ms) {
      return '–';
    }
    const s = Math.round(ms / 1000);
    if (s < 60) {
      return `${s}s`;
    }
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  trackByKey(_: number, f: SentinelFinding): string {
    return f.key;
  }

  trackByFlow(_: number, f: SentinelFlow): string {
    return `${f.protocol}|${f.localAddress}:${f.localPort}|${f.remoteAddress}:${f.remotePort}|${f.pid ?? ''}`;
  }
}

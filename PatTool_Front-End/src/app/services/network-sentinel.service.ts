import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, Subject, Subscription, from } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { KeycloakService } from '../keycloak/keycloak.service';
import { environment } from '../../environments/environment';

export type SentinelSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type SentinelDirection = 'LISTEN' | 'INBOUND' | 'OUTBOUND' | 'UNKNOWN';
export type SentinelScope = 'LOOPBACK' | 'LAN' | 'PRIVATE' | 'PUBLIC' | 'MULTICAST' | 'UNSPECIFIED';

export interface SentinelFlow {
  protocol: string;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  state: string;
  pid?: number | null;
  processName?: string | null;
  direction: SentinelDirection;
  remoteScope: SentinelScope;
}

export interface SentinelLogon {
  kind: 'LOGON' | 'SESSION';
  user: string;
  sourceAddress?: string | null;
  sourceScope?: SentinelScope | null;
  method?: string | null;
  when?: string | null;
  raw?: string | null;
}

export interface SentinelFinding {
  key: string;
  category: string;
  severity: SentinelSeverity;
  title: string;
  detail: string;
  evidence?: { [k: string]: unknown };
  acknowledged?: boolean;
  intrusionSucceeded?: boolean;
}

export interface SentinelConversation {
  protocol: string;
  srcAddress: string;
  srcPort?: number | null;
  dstAddress: string;
  dstPort?: number | null;
  packets: number;
  bytes: number;
  distinctDstPorts: number;
  synOnly: boolean;
}

export interface SentinelCapture {
  tool?: string | null;
  available: boolean;
  requestedSeconds: number;
  packets: number;
  bytes: number;
  conversations: SentinelConversation[];
  dnsQueries: { client: string; name: string; count: number }[];
  arpObservations: { ip: string; mac: string; count: number; reply: boolean }[];
  packetsByHost: { address: string; packets: number; bytes: number }[];
  ipToMac: { ip: string; mac: string }[];
  warning?: string | null;
}

export interface SentinelFlowCounts {
  total: number;
  established: number;
  listeners: number;
  inboundPublic: number;
  inboundLan: number;
  outboundPublic: number;
  outboundLan: number;
}

export interface SentinelLive {
  at: string;
  hostName: string;
  os: string;
  localAddresses: string[];
  lanCidrs: string[];
  flows: SentinelFlow[];
  flowCount: number;
  counts: SentinelFlowCounts;
  sessions: SentinelLogon[];
  findings: SentinelFinding[];
  severityCounts: { [sev: string]: number };
  warnings: string[];
  running: boolean;
  currentPhase?: string | null;
}

export interface SentinelSweep {
  id: string;
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
  trigger: 'MANUAL' | 'SCHEDULED';
  hostName: string;
  os: string;
  deviceScanIncluded: boolean;
  deviceCount: number;
  unknownDeviceCount: number;
  unknownDevices: { [k: string]: unknown }[];
  flowCount: number;
  listenerCount: number;
  inboundPublicCount: number;
  outboundPublicCount: number;
  flows: SentinelFlow[];
  captureIncluded: boolean;
  capture?: SentinelCapture | null;
  logons: SentinelLogon[];
  sessions: SentinelLogon[];
  findings: SentinelFinding[];
  severityCounts: { [sev: string]: number };
  intrusionSucceededCount: number;
  maxSeverity?: SentinelSeverity | null;
  emailSent: boolean;
  warnings: string[];
  baselineLearning: boolean;
}

export interface SentinelSweepSummary {
  id: string;
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
  trigger: 'MANUAL' | 'SCHEDULED';
  hostName: string;
  deviceScanIncluded: boolean;
  deviceCount: number;
  unknownDeviceCount: number;
  flowCount: number;
  inboundPublicCount: number;
  outboundPublicCount: number;
  captureIncluded: boolean;
  capturePackets: number;
  findingCount: number;
  severityCounts: { [sev: string]: number };
  intrusionSucceededCount: number;
  maxSeverity?: SentinelSeverity | null;
  emailSent: boolean;
  baselineLearning: boolean;
  warningCount: number;
}

export interface SentinelPrefs {
  schedulerEnabled?: boolean;
  schedulerIntervalMinutes?: number;
  captureSeconds?: number;
  includeDeviceScan?: boolean;
  includeCapture?: boolean;
  emailAlertsEnabled?: boolean;
  emailMinSeverity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  trustedRemoteCidrs?: string[];
  expectedListeners?: string[];
  captureInterface?: string | null;
}

export interface SentinelCapabilities {
  hostName: string;
  os: string;
  platform: string;
  localAddresses: string[];
  lanCidrs: string[];
  connectionTable: boolean;
  connectionTool?: string | null;
  packetCapture: boolean;
  captureTool?: string | null;
  captureInterfaces: string[];
  logonHistory: boolean;
  logonTool?: string | null;
  sessions: boolean;
  sessionTool?: string | null;
  deviceScan: boolean;
  hints: string[];
}

export interface SentinelStatus {
  running: boolean;
  currentPhase?: string | null;
  lastSweepStartedAt?: string | null;
  baselineInitialized: boolean;
  baselineSweepCount: number;
  baselineListeners: number;
  baselineLogons: number;
  baselineArpEntries: number;
  acknowledgedKeys: number;
  historyCount: number;
}

export type SentinelStreamEventType =
  | 'sweep-started'
  | 'phase'
  | 'status'
  | 'flows'
  | 'sessions'
  | 'capture'
  | 'device-found'
  | 'finding'
  | 'sweep-completed'
  | 'error';

export interface SentinelStreamEvent {
  type: SentinelStreamEventType;
  data: any;
}

export interface SweepRequest {
  includeDeviceScan?: boolean;
  includeCapture?: boolean;
  captureSeconds?: number;
}

/** REST + SSE client for /api/network/sentinel (admin only). */
@Injectable({ providedIn: 'root' })
export class NetworkSentinelService {

  private readonly API_URL: string = environment.API_URL;
  private readonly BASE = 'network/sentinel';

  constructor(private readonly http: HttpClient, private readonly keycloak: KeycloakService) {}

  private headers(): Observable<HttpHeaders> {
    return from(this.keycloak.getToken()).pipe(
      map((token: string) => new HttpHeaders({
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=UTF-8',
        Authorization: 'Bearer ' + token
      }))
    );
  }

  private get<T>(path: string): Observable<T> {
    return this.headers().pipe(switchMap(h => this.http.get<T>(`${this.API_URL}${this.BASE}${path}`, { headers: h })));
  }

  capabilities(): Observable<SentinelCapabilities> {
    return this.get<SentinelCapabilities>('/capabilities');
  }

  status(): Observable<SentinelStatus> {
    return this.get<SentinelStatus>('/status');
  }

  live(): Observable<SentinelLive> {
    return this.get<SentinelLive>('/live');
  }

  getPrefs(): Observable<SentinelPrefs> {
    return this.get<SentinelPrefs>('/prefs');
  }

  updatePrefs(patch: SentinelPrefs): Observable<SentinelPrefs> {
    return this.headers().pipe(
      switchMap(h => this.http.put<SentinelPrefs>(`${this.API_URL}${this.BASE}/prefs`, patch, { headers: h }))
    );
  }

  history(limit = 30): Observable<{ sweeps: SentinelSweepSummary[] }> {
    return this.get<{ sweeps: SentinelSweepSummary[] }>(`/sweeps?limit=${limit}`);
  }

  latest(): Observable<SentinelSweep | null> {
    return this.headers().pipe(
      switchMap(h => this.http.get<SentinelSweep>(`${this.API_URL}${this.BASE}/sweeps/latest`, { headers: h, observe: 'response' })),
      map(resp => (resp.status === 204 ? null : resp.body))
    );
  }

  sweep(id: string): Observable<SentinelSweep> {
    return this.get<SentinelSweep>(`/sweeps/${encodeURIComponent(id)}`);
  }

  clearHistory(): Observable<{ deletedCount: number }> {
    return this.headers().pipe(
      switchMap(h => this.http.delete<{ deletedCount: number }>(`${this.API_URL}${this.BASE}/sweeps`, { headers: h }))
    );
  }

  acknowledge(key: string, acknowledged = true): Observable<{ key: string; acknowledged: boolean; acknowledgedKeys: string[] }> {
    return this.headers().pipe(
      switchMap(h => this.http.post<{ key: string; acknowledged: boolean; acknowledgedKeys: string[] }>(
        `${this.API_URL}${this.BASE}/findings/ack`, { key, acknowledged }, { headers: h }))
    );
  }

  resetBaseline(): Observable<{ message: string }> {
    return this.headers().pipe(
      switchMap(h => this.http.delete<{ message: string }>(`${this.API_URL}${this.BASE}/baseline`, { headers: h }))
    );
  }

  /**
   * Runs a full sweep and streams its events (SSE over fetch so the bearer token can be sent).
   * Unsubscribing aborts the request.
   */
  sweepStream(req: SweepRequest = {}): Observable<SentinelStreamEvent> {
    const subject = new Subject<SentinelStreamEvent>();
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let tokenSub: Subscription | null = null;

    const params = new URLSearchParams();
    if (req.includeDeviceScan !== undefined) { params.set('includeDeviceScan', String(req.includeDeviceScan)); }
    if (req.includeCapture !== undefined) { params.set('includeCapture', String(req.includeCapture)); }
    if (req.captureSeconds !== undefined) { params.set('captureSeconds', String(req.captureSeconds)); }
    const qs = params.toString();
    const url = `${this.API_URL}${this.BASE}/sweep/stream${qs ? '?' + qs : ''}`;

    tokenSub = from(this.keycloak.getToken()).subscribe({
      next: (token: string) => {
        if (abort.signal.aborted) { return; }
        fetch(url, {
          headers: { Authorization: 'Bearer ' + token, Accept: 'text/event-stream' },
          cache: 'no-cache',
          signal: abort.signal
        }).then(response => {
          if (abort.signal.aborted) { return; }
          if (!response.ok) {
            subject.error(new Error(`HTTP ${response.status}`));
            return;
          }
          if (!response.body) {
            subject.error(new Error('Empty response body'));
            return;
          }
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let eventType: string = 'message';
          let eventData = '';

          const flush = (): void => {
            if (!eventData.trim()) { return; }
            try {
              subject.next({ type: eventType as SentinelStreamEventType, data: JSON.parse(eventData.trim()) });
            } catch (e) {
              console.error('[sentinel SSE] parse error', e, eventData);
            }
            eventData = '';
            eventType = 'message';
          };

          const read = (): void => {
            if (abort.signal.aborted || !reader) { return; }
            reader.read().then(({ done, value }) => {
              if (abort.signal.aborted) { return; }
              if (done) {
                flush();
                subject.complete();
                return;
              }
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              for (const raw of lines) {
                const line = raw.trim();
                if (line.startsWith('event:')) {
                  eventType = line.substring(6).trim();
                } else if (line.startsWith('data:')) {
                  const d = line.substring(5);
                  eventData = eventData ? eventData + '\n' + d : d;
                } else if (line === '' && eventData) {
                  flush();
                }
              }
              read();
            }).catch(err => {
              if (!abort.signal.aborted) { subject.error(err); }
            });
          };
          read();
        }).catch(err => {
          if (!abort.signal.aborted) { subject.error(err); }
        });
      },
      error: err => {
        if (!abort.signal.aborted) { subject.error(err); }
      }
    });

    return new Observable<SentinelStreamEvent>(subscriber => {
      const sub = subject.subscribe(subscriber);
      return () => {
        abort.abort();
        tokenSub?.unsubscribe();
        tokenSub = null;
        reader?.cancel().catch(() => undefined);
        reader = null;
        sub.unsubscribe();
      };
    });
  }
}

import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { KeycloakService } from '../keycloak/keycloak.service';
import { environment } from '../../environments/environment';
import { Observable, from, Subject, Subscription } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';

export interface StreamEvent {
  type: 'scan-started' | 'device-found' | 'scan-status' | 'scan-completed' | 'error';
  data: any;
}

/** Shared local-network switch states (GET/PUT /network/global-prefs, admin only). */
export interface LocalNetworkGlobalPrefs {
  useExternalVendorAPI?: boolean;
  scanSchedulerEnabled?: boolean;
  showOnlyUnknownDevices?: boolean;
  showOnlyMacConflictDevices?: boolean;
  wifiScanUseBackend?: boolean;
}

@Injectable()
export class LocalNetworkService {

  private API_URL: string = environment.API_URL;

  constructor(
    private _http: HttpClient, 
    private _keycloakService: KeycloakService
  ) {
  }

  // Get the header with token for Keycloak Security
  private getHeaderWithToken(): Observable<HttpHeaders> {
    return from(this._keycloakService.getToken()).pipe(
      map((token: string) => {
        return new HttpHeaders({
          'Accept': 'application/json',
          'Content-Type': 'application/json; charset=UTF-8',
          'Authorization': 'Bearer ' + token
        });
      })
    );
  }

  /**
   * Scan the local network for devices and vulnerabilities
   */
  scanNetwork(): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get(this.API_URL + "network/scan", { headers: headers })
      )
    );
  }

  /**
   * WLAN networks visible from PatTool backend host (server radio, not browser).
   */
  scanNearbyWifi(): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get(this.API_URL + "network/wifi-scan", { headers: headers })
      )
    );
  }

  /**
   * Stream network scan results using Server-Sent Events (SSE)
   * Returns an Observable that emits events as devices are found.
   * Unsubscribing aborts the underlying fetch and cancels the stream reader.
   */
  scanNetworkStream(useExternalVendorAPI: boolean = false): Observable<StreamEvent> {
    const eventSubject = new Subject<StreamEvent>();
    const abortController = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let tokenSubscription: Subscription | null = null;

    tokenSubscription = from(this._keycloakService.getToken()).subscribe({
      next: (token: string) => {
        if (abortController.signal.aborted) {
          return;
        }
        const url = this.API_URL + 'network/scan/stream'
          + (useExternalVendorAPI ? '?useExternalVendorAPI=true' : '');

        fetch(url, {
          headers: {
            Authorization: 'Bearer ' + token,
            Accept: 'text/event-stream'
          },
          cache: 'no-cache',
          signal: abortController.signal
        }).then(response => {
          if (abortController.signal.aborted) {
            return;
          }
          if (!response.ok) {
            eventSubject.error(new Error(`HTTP error! status: ${response.status}`));
            return;
          }
          if (!response.body) {
            eventSubject.error(new Error('Response body is null'));
            return;
          }

          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let eventType: StreamEvent['type'] | 'message' = 'message';
          let eventData = '';

          const readStream = (): void => {
            if (abortController.signal.aborted || !reader) {
              return;
            }
            reader.read().then(({ done, value }) => {
              if (abortController.signal.aborted) {
                return;
              }
              if (done) {
                if (eventData.trim()) {
                  try {
                    const data = JSON.parse(eventData.trim());
                    eventSubject.next({ type: eventType as StreamEvent['type'], data });
                  } catch (e) {
                    console.error('[SSE] Error parsing final SSE data:', e, eventData);
                  }
                }
                eventSubject.complete();
                return;
              }

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine.startsWith('event:')) {
                  eventType = trimmedLine.substring(6).trim() as StreamEvent['type'];
                } else if (trimmedLine.startsWith('data:')) {
                  const dataLine = trimmedLine.substring(5);
                  eventData = eventData ? eventData + '\n' + dataLine : dataLine;
                } else if (trimmedLine === '' && eventData) {
                  try {
                    const data = JSON.parse(eventData.trim());
                    eventSubject.next({ type: eventType as StreamEvent['type'], data });
                  } catch (e) {
                    console.error('[SSE] Error parsing SSE data:', e, 'EventData:', eventData);
                  }
                  eventData = '';
                  eventType = 'message';
                }
              }

              readStream();
            }).catch(error => {
              if (abortController.signal.aborted) {
                return;
              }
              console.error('[SSE] Error reading stream:', error);
              eventSubject.error(error);
            });
          };

          readStream();
        }).catch(error => {
          if (abortController.signal.aborted) {
            return;
          }
          console.error('[SSE] Fetch error:', error);
          eventSubject.error(error);
        });
      },
      error: (error) => {
        if (!abortController.signal.aborted) {
          eventSubject.error(error);
        }
      }
    });

    return new Observable<StreamEvent>(subscriber => {
      const subscription = eventSubject.subscribe(subscriber);
      return () => {
        abortController.abort();
        tokenSubscription?.unsubscribe();
        tokenSubscription = null;
        reader?.cancel().catch(() => undefined);
        reader = null;
        subscription.unsubscribe();
      };
    });
  }

  /**
   * Get all device mappings from MongoDB
   */
  getDeviceMappings(): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get(this.API_URL + "network/device-mappings", { headers: headers })
      )
    );
  }

  /**
   * Reload device mappings from CSV file into MongoDB
   */

  /**
   * Create a new device mapping
   */
  createDeviceMapping(mapping: {
    ipAddress: string;
    deviceName: string;
    macAddress?: string;
    deviceNumber?: number;
  }): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post(this.API_URL + "network/device-mappings", mapping, { headers: headers })
      )
    );
  }

  /**
   * Update an existing device mapping
   */
  updateDeviceMapping(id: string, mapping: {
    ipAddress: string;
    deviceName: string;
    macAddress?: string;
    deviceNumber?: number;
    deviceType?: string | null;
    deviceDescription?: string | null;
  }): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put(this.API_URL + "network/device-mappings/" + id, mapping, { headers: headers })
      )
    );
  }

  /**
   * Delete a device mapping
   */
  deleteDeviceMapping(id: string): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.delete(this.API_URL + "network/device-mappings/" + id, { headers: headers })
      )
    );
  }

  /**
   * Get vendor information from external API for a MAC address
   */
  getVendorInfo(macAddress: string): Observable<any> {
    // Encode MAC address for URL (replace : with - or keep as is)
    const encodedMac = encodeURIComponent(macAddress);
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get(this.API_URL + "network/vendor-info/" + encodedMac, { headers: headers })
      )
    );
  }

  /**
   * Get all MAC vendor mappings from MongoDB
   */
  getMacVendorMappings(): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get(this.API_URL + "network/mac-vendor-mappings", { headers: headers })
      )
    );
  }

  /**
   * Create a new MAC vendor mapping
   */
  createMacVendorMapping(mapping: {
    oui: string;
    vendor: string;
  }): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.post(this.API_URL + "network/mac-vendor-mappings", mapping, { headers: headers })
      )
    );
  }

  /**
   * Update an existing MAC vendor mapping
   */
  updateMacVendorMapping(id: string, mapping: {
    oui: string;
    vendor: string;
  }): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put(this.API_URL + "network/mac-vendor-mappings/" + id, mapping, { headers: headers })
      )
    );
  }

  /**
   * Delete a MAC vendor mapping
   */
  deleteMacVendorMapping(id: string): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.delete(this.API_URL + "network/mac-vendor-mappings/" + id, { headers: headers })
      )
    );
  }

  /**
   * Shared local-network UI switch states (MongoDB, admin only).
   */
  getLocalNetworkGlobalPrefs(): Observable<LocalNetworkGlobalPrefs> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get<LocalNetworkGlobalPrefs>(this.API_URL + 'network/global-prefs', { headers: headers })
      )
    );
  }

  setLocalNetworkGlobalPrefs(prefs: LocalNetworkGlobalPrefs): Observable<LocalNetworkGlobalPrefs> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put<LocalNetworkGlobalPrefs>(
          this.API_URL + 'network/global-prefs',
          prefs,
          { headers: headers }
        )
      )
    );
  }

  /**
   * Get network scan scheduler enabled status
   */
  getScanSchedulerEnabled(): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get(this.API_URL + "network/scan-scheduler/enabled", { headers: headers })
      )
    );
  }

  /**
   * Set network scan scheduler enabled status
   */
  setScanSchedulerEnabled(enabled: boolean): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.put(this.API_URL + "network/scan-scheduler/enabled", { enabled: enabled }, { headers: headers })
      )
    );
  }

  /**
   * Get network scan scheduler interval (in minutes)
   */
  getScanSchedulerInterval(): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get(this.API_URL + "network/scan-scheduler/interval", { headers: headers })
      )
    );
  }

  /**
   * Get all new device history entries from MongoDB
   */
  getNewDeviceHistory(): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.get(this.API_URL + "network/new-device-history", { headers: headers })
      )
    );
  }

  /**
   * Clear all new device history entries
   */
  clearNewDeviceHistory(): Observable<any> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.delete(this.API_URL + "network/new-device-history", { headers: headers })
      )
    );
  }

  /**
   * Delete new device history entries by MAC address
   */
  deleteNewDeviceHistoryByMac(macAddress: string): Observable<any> {
    const encodedMac = encodeURIComponent(macAddress);
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this._http.delete(this.API_URL + "network/new-device-history/by-mac/" + encodedMac, { headers: headers })
      )
    );
  }
}


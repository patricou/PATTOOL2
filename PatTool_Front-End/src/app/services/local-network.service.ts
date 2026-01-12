import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { KeycloakService } from '../keycloak/keycloak.service';
import { environment } from '../../environments/environment';
import { Observable, from, Subject } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';

export interface StreamEvent {
  type: 'scan-started' | 'device-found' | 'scan-completed' | 'error';
  data: any;
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
   * Stream network scan results using Server-Sent Events (SSE)
   * Returns an Observable that emits events as devices are found
   * @param useExternalVendorAPI If true, use external API for vendor detection (OUI lookup)
   */
  scanNetworkStream(useExternalVendorAPI: boolean = false): Observable<StreamEvent> {
    const eventSubject = new Subject<StreamEvent>();

    from(this._keycloakService.getToken()).subscribe({
      next: (token: string) => {
        // Build URL with query parameter
        const url = this.API_URL + "network/scan/stream" + (useExternalVendorAPI ? "?useExternalVendorAPI=true" : "");
        
        // Use fetch API instead of EventSource to support custom headers
        fetch(url, {
          headers: {
            'Authorization': 'Bearer ' + token,
            'Accept': 'text/event-stream'
          },
          cache: 'no-cache'
        }).then(response => {
          if (!response.ok) {
            const error = new Error(`HTTP error! status: ${response.status}`);
            eventSubject.error(error);
            return;
          }

          if (!response.body) {
            eventSubject.error(new Error('Response body is null'));
            return;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let eventType = 'message';
          let eventData = '';
          let eventCount = 0;

          const readStream = (): void => {
            reader.read().then(({ done, value }) => {
              if (done) {
                // Process any remaining data in buffer
                if (eventData.trim()) {
                  try {
                    const data = JSON.parse(eventData.trim());
                    const event: StreamEvent = { type: eventType as any, data };
                    eventSubject.next(event);
                    eventCount++;
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
                  eventType = trimmedLine.substring(6).trim();
                } else if (trimmedLine.startsWith('data:')) {
                  // Handle multi-line data (append if data already exists)
                  const dataLine = trimmedLine.substring(5);
                  if (eventData) {
                    eventData += '\n' + dataLine;
                  } else {
                    eventData = dataLine;
                  }
                } else if (trimmedLine === '' && eventData) {
                  // Empty line signals end of event
                  try {
                    const data = JSON.parse(eventData.trim());
                    const event: StreamEvent = { type: eventType as any, data };
                    eventSubject.next(event);
                    eventCount++;
                  } catch (e) {
                    console.error('[SSE] Error parsing SSE data:', e, 'EventData:', eventData);
                  }
                  eventData = '';
                  eventType = 'message';
                }
              }

              readStream();
            }).catch(error => {
              console.error('[SSE] Error reading stream:', error);
              eventSubject.error(error);
            });
          };

          readStream();
        }).catch(error => {
          console.error('[SSE] Fetch error:', error);
          eventSubject.error(error);
        });
      },
      error: (error) => {
        eventSubject.error(error);
      }
    });

    return eventSubject.asObservable();
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
}


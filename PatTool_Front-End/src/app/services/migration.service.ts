import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, from, forkJoin } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';
import { Evenement } from '../model/evenement';
import { UrlEvent } from '../model/url-event';

@Injectable({
  providedIn: 'root'
})
export class MigrationService {
  private apiUrl = environment.API_URL;

  constructor(private http: HttpClient, private keycloakService: KeycloakService) { }

  // Get the header with token for Keycloak Security
  private getHeaderWithToken(): Observable<HttpHeaders> {
    return from(this.keycloakService.getToken()).pipe(
      map(token => new HttpHeaders({
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      }))
    );
  }

  /**
   * Execute the migration from map field to urlEvents using existing APIs
   */
  migrateMapToUrlEventsFrontend(): Observable<string> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        // Get all events
        return this.http.get<Evenement[]>(`${this.apiUrl}evenements`, { headers }).pipe(
          switchMap(events => {
            const eventsToMigrate = events.filter(event => 
              event.map && event.map.trim() !== ''
            );
            
            if (eventsToMigrate.length === 0) {
              return from(['Aucun événement à migrer trouvé.']);
            }

            // Create migration operations for each event
            const migrationOperations = eventsToMigrate.map(event => {
              // Create UrlEvent from map data
              const mapUrlEvent = new UrlEvent(
                "MAP",                           // typeUrl: Use the new ID constant
                new Date(),                      // dateCreation: Current date
                "Patricou",                      // owner: As requested
                event.map.trim(),                // link: The map URL
                "Carte"                         // urlDescription: As requested
              );
              
              // Initialize urlEvents list if null
              if (!event.urlEvents) {
                event.urlEvents = [];
              }
              
              // Add the UrlEvent to the list
              event.urlEvents.push(mapUrlEvent);
              
              // Clear the map field
              event.map = "";
              
              // Update the event
              return this.http.put<Evenement>(`${this.apiUrl}evenements/${event.id}`, event, { headers });
            });

            // Execute all migrations
            return forkJoin(migrationOperations).pipe(
              map(() => `Migration terminée avec succès. ${eventsToMigrate.length} événements migrés.`)
            );
          })
        );
      })
    );
  }

  /**
   * Get migration status using existing APIs
   */
  getMigrationStatusFrontend(): Observable<string> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this.http.get<Evenement[]>(`${this.apiUrl}evenements`, { headers }).pipe(
          map(events => {
            const eventsWithMap = events.filter(event => 
              event.map && event.map.trim() !== ''
            ).length;
            const eventsWithUrlEvents = events.filter(event => 
              event.urlEvents && event.urlEvents.length > 0
            ).length;
            const totalEvents = events.length;

            return `Statut de la migration:\n` +
                   `Total événements: ${totalEvents}\n` +
                   `Événements avec champ map: ${eventsWithMap}\n` +
                   `Événements avec urlEvents: ${eventsWithUrlEvents}\n` +
                   `Événements prêts pour migration: ${eventsWithMap}`;
          })
        )
      )
    );
  }

  /**
   * Execute the migration from map field to urlEvents (backend endpoint)
   */
  migrateMapToUrlEvents(): Observable<string> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this.http.post<string>(`${this.apiUrl}migration/migrate-map-to-urlevents`, {}, { headers })
      )
    );
  }

  /**
   * Get the current migration status (backend endpoint)
   */
  getMigrationStatus(): Observable<string> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this.http.get<string>(`${this.apiUrl}migration/migration-status`, { headers })
      )
    );
  }

  /**
   * Execute the migration from photosUrl field to urlEvents using existing APIs
   */
  migratePhotosToUrlEventsFrontend(): Observable<string> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers => {
        // Get all events
        return this.http.get<Evenement[]>(`${this.apiUrl}evenements`, { headers }).pipe(
          switchMap(events => {
            const eventsToMigrate = events.filter(event => 
              event.photosUrl && event.photosUrl.length > 0
            );
            
            if (eventsToMigrate.length === 0) {
              return from(['Aucun événement avec photos à migrer trouvé.']);
            }

            // Create migration operations for each event
            const migrationOperations = eventsToMigrate.map(event => {
              // Initialize urlEvents list if null
              if (!event.urlEvents) {
                event.urlEvents = [];
              }
              
              // Create UrlEvent for each photo URL
              const photoUrlEvents = event.photosUrl.map(photoUrl => 
                new UrlEvent(
                  "Photos",                       // typeUrl: Corrected to "Photos"
                  new Date(),                     // dateCreation: Current date
                  "Patricou",                     // owner: As requested
                  photoUrl.trim(),                // link: The photo URL
                  "Photos"                        // urlDescription: Corrected to "Photos"
                )
              );
              
              // Add all photo UrlEvents to the list
              event.urlEvents.push(...photoUrlEvents);
              
              // Clear the photosUrl field
              event.photosUrl = [];
              
              // Update the event
              return this.http.put<Evenement>(`${this.apiUrl}evenements/${event.id}`, event, { headers });
            });

            // Execute all migrations
            return forkJoin(migrationOperations).pipe(
              map(() => `Migration des photos terminée avec succès. ${eventsToMigrate.length} événements migrés.`)
            );
          })
        );
      })
    );
  }

  /**
   * Get migration status for photos using existing APIs
   */
  getPhotosMigrationStatusFrontend(): Observable<string> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this.http.get<Evenement[]>(`${this.apiUrl}evenements`, { headers }).pipe(
          map(events => {
            const eventsWithPhotos = events.filter(event => 
              event.photosUrl && event.photosUrl.length > 0
            ).length;
            const eventsWithUrlEvents = events.filter(event => 
              event.urlEvents && event.urlEvents.length > 0
            ).length;
            const totalEvents = events.length;

            return `Statut de la migration des photos:\n` +
                   `Total événements: ${totalEvents}\n` +
                   `Événements avec photosUrl: ${eventsWithPhotos}\n` +
                   `Événements avec urlEvents: ${eventsWithUrlEvents}\n` +
                   `Événements prêts pour migration des photos: ${eventsWithPhotos}`;
          })
        )
      )
    );
  }

  /**
   * Execute the migration from photosUrl field to urlEvents (backend endpoint)
   */
  migratePhotosToUrlEvents(): Observable<string> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this.http.post<string>(`${this.apiUrl}migration/migrate-photos-to-urlevents`, {}, { headers })
      )
    );
  }

  /**
   * Get the current migration status for photos (backend endpoint)
   */
  getPhotosMigrationStatus(): Observable<string> {
    return this.getHeaderWithToken().pipe(
      switchMap(headers =>
        this.http.get<string>(`${this.apiUrl}migration/photos-migration-status`, { headers })
      )
    );
  }
}

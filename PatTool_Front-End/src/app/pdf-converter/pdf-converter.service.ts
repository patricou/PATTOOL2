import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, forkJoin, from, map, switchMap } from 'rxjs';
import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';
import { MembersService } from '../services/members.service';

export interface PdfConverterDocument {
  id?: string;
  ownerMemberId?: string;
  /** Populated for admin users when listing all documents. */
  ownerDisplayName?: string | null;
  fileName: string;
  htmlContent?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

@Injectable({ providedIn: 'root' })
export class PdfConverterService {
  private readonly baseUrl = `${environment.API_URL}pdf-converter/documents`;

  constructor(
    private http: HttpClient,
    private keycloak: KeycloakService,
    private membersService: MembersService
  ) {}

  private withUserHeaders(): Observable<HttpHeaders> {
    return forkJoin({
      member: this.membersService.getUserId({ skipGeolocation: true }),
      token: from(this.keycloak.getToken())
    }).pipe(
      map(({ member, token }) => {
        let h = new HttpHeaders({
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'user-id': member.id || ''
        });
        if (token) {
          h = h.set('Authorization', 'Bearer ' + token);
        }
        return h;
      })
    );
  }

  list(): Observable<PdfConverterDocument[]> {
    return this.withUserHeaders().pipe(
      switchMap((headers) => this.http.get<PdfConverterDocument[]>(this.baseUrl, { headers }))
    );
  }

  getOne(id: string): Observable<PdfConverterDocument> {
    return this.withUserHeaders().pipe(
      switchMap((headers) =>
        this.http.get<PdfConverterDocument>(`${this.baseUrl}/${id}`, { headers })
      )
    );
  }

  create(body: PdfConverterDocument): Observable<PdfConverterDocument> {
    return this.withUserHeaders().pipe(
      switchMap((headers) => this.http.post<PdfConverterDocument>(this.baseUrl, body, { headers }))
    );
  }

  update(id: string, body: PdfConverterDocument): Observable<PdfConverterDocument> {
    return this.withUserHeaders().pipe(
      switchMap((headers) =>
        this.http.put<PdfConverterDocument>(`${this.baseUrl}/${id}`, body, { headers })
      )
    );
  }

  delete(id: string): Observable<void> {
    const encodedId = encodeURIComponent(id);
    return this.withUserHeaders().pipe(
      switchMap((headers) =>
        this.http.delete(`${this.baseUrl}/${encodedId}`, {
          headers,
          observe: 'response',
          responseType: 'text'
        })
      ),
      map((res) => {
        if (res.status === 204 || res.status === 200) {
          return;
        }
        throw new Error(`delete failed: HTTP ${res.status}`);
      })
    );
  }
}

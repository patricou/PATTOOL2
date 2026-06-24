import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, forkJoin, from, map, switchMap } from 'rxjs';
import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';
import { MembersService } from '../services/members.service';

export interface OdsEditorDocument {
  id?: string;
  ownerMemberId?: string;
  /** Populated for admin users when listing all documents. */
  ownerDisplayName?: string | null;
  fileName: string;
  odsContentBase64?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

@Injectable({ providedIn: 'root' })
export class OdsEditorService {
  private readonly baseUrl = `${environment.API_URL}ods-editor/documents`;

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

  list(): Observable<OdsEditorDocument[]> {
    return this.withUserHeaders().pipe(
      switchMap((headers) => this.http.get<OdsEditorDocument[]>(this.baseUrl, { headers }))
    );
  }

  getOne(id: string): Observable<OdsEditorDocument> {
    return this.withUserHeaders().pipe(
      switchMap((headers) =>
        this.http.get<OdsEditorDocument>(`${this.baseUrl}/${id}`, { headers })
      )
    );
  }

  create(body: OdsEditorDocument): Observable<OdsEditorDocument> {
    return this.withUserHeaders().pipe(
      switchMap((headers) => this.http.post<OdsEditorDocument>(this.baseUrl, body, { headers }))
    );
  }

  update(id: string, body: OdsEditorDocument): Observable<OdsEditorDocument> {
    return this.withUserHeaders().pipe(
      switchMap((headers) =>
        this.http.put<OdsEditorDocument>(`${this.baseUrl}/${id}`, body, { headers })
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

/** Read a Blob as a Base64 string (without data-URL prefix). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Decode Base64 into a File suitable for {@link loadOdsFromFile}. */
export function base64ToOdsFile(base64: string, fileName: string): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const safeName = fileName.toLowerCase().endsWith('.ods') ? fileName : `${fileName}.ods`;
  return new File([bytes], safeName, {
    type: 'application/vnd.oasis.opendocument.spreadsheet'
  });
}

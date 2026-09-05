import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, forkJoin, from } from 'rxjs';
import { map, switchMap, timeout } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { KeycloakService } from '../keycloak/keycloak.service';
import { MembersService } from '../services/members.service';

export type VideoMontageClipKind = 'photo' | 'video' | 'recording';

export interface VideoMontageClip {
  kind: VideoMontageClipKind;
  fileId: string;
  evenementId?: string | null;
  recordingId?: string | null;
  fileName?: string | null;
  fileType?: string | null;
  title?: string | null;
  durationSec?: number | null;
  startSec?: number | null;
}

export interface VideoMontageProject {
  id?: string;
  ownerMemberId?: string;
  ownerDisplayName?: string | null;
  title: string;
  evenementId?: string | null;
  clips?: VideoMontageClip[];
  width?: number | null;
  height?: number | null;
  photoDefaultDurationSec?: number | null;
  outputGridFsFileId?: string | null;
  outputFileName?: string | null;
  outputByteLength?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface VideoMontageStatus {
  enabled: boolean;
  ffmpegAvailable: boolean;
}

export interface VideoMontageExportRequest {
  title?: string;
  projectId?: string | null;
  evenementId?: string | null;
  attachToEvent?: boolean;
  width?: number;
  height?: number;
  clips: VideoMontageClip[];
}

export interface VideoMontageExportResponse {
  fileId: string;
  fileName: string;
  mediaUrl: string;
  byteLength: number;
  evenementId?: string | null;
  attachedToEvent?: boolean;
  projectId?: string | null;
}

@Injectable({ providedIn: 'root' })
export class VideoMontageService {
  private readonly baseUrl = `${environment.API_URL}video-montage`;

  constructor(
    private http: HttpClient,
    private keycloak: KeycloakService,
    private membersService: MembersService
  ) {}

  status(): Observable<VideoMontageStatus> {
    return this.withUserHeaders(false).pipe(
      switchMap((headers) => this.http.get<VideoMontageStatus>(`${this.baseUrl}/status`, { headers }))
    );
  }

  list(): Observable<VideoMontageProject[]> {
    return this.withUserHeaders().pipe(
      switchMap((headers) => this.http.get<VideoMontageProject[]>(`${this.baseUrl}/projects`, { headers }))
    );
  }

  getOne(id: string): Observable<VideoMontageProject> {
    return this.withUserHeaders().pipe(
      switchMap((headers) =>
        this.http.get<VideoMontageProject>(`${this.baseUrl}/projects/${encodeURIComponent(id)}`, { headers })
      )
    );
  }

  create(body: VideoMontageProject): Observable<VideoMontageProject> {
    return this.withUserHeaders().pipe(
      switchMap((headers) => this.http.post<VideoMontageProject>(`${this.baseUrl}/projects`, body, { headers }))
    );
  }

  update(id: string, body: VideoMontageProject): Observable<VideoMontageProject> {
    return this.withUserHeaders().pipe(
      switchMap((headers) =>
        this.http.put<VideoMontageProject>(
          `${this.baseUrl}/projects/${encodeURIComponent(id)}`,
          body,
          { headers }
        )
      )
    );
  }

  delete(id: string): Observable<void> {
    return this.withUserHeaders().pipe(
      switchMap((headers) =>
        this.http.delete<void>(`${this.baseUrl}/projects/${encodeURIComponent(id)}`, { headers })
      )
    );
  }

  export(body: VideoMontageExportRequest): Observable<VideoMontageExportResponse> {
    return this.withUserHeaders().pipe(
      switchMap((headers) =>
        this.http
          .post<VideoMontageExportResponse>(`${this.baseUrl}/export`, body, { headers })
          .pipe(timeout(16 * 60 * 1000))
      )
    );
  }

  private withUserHeaders(json = true): Observable<HttpHeaders> {
    return forkJoin({
      member: this.membersService.getUserId({ skipGeolocation: true }),
      token: from(this.keycloak.getToken())
    }).pipe(
      map(({ member, token }) => {
        let h = new HttpHeaders({
          Accept: 'application/json',
          'user-id': member.id || ''
        });
        if (json) {
          h = h.set('Content-Type', 'application/json');
        }
        if (token) {
          h = h.set('Authorization', 'Bearer ' + token);
        }
        return h;
      })
    );
  }
}

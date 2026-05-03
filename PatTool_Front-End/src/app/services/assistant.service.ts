import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { KeycloakService } from '../keycloak/keycloak.service';
import { TranslateService } from '@ngx-translate/core';
import { environment } from '../../environments/environment';
import { Observable, from, throwError, of } from 'rxjs';
import { map, switchMap, catchError } from 'rxjs/operators';

export interface AssistantChatMeta {
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Modèle effectif renvoyé par l’API (ex. gpt-4o) */
  model?: string;
  /** Libellé fournisseur exposé par le backend */
  provider?: string;
}

export interface AssistantChatTurn {
  role: 'user' | 'assistant';
  content: string;
  meta?: AssistantChatMeta;
}

export interface AssistantChatResponse {
  id?: string;
  model?: string;
  provider?: string;
  role?: string;
  content?: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Temps côté serveur (PatTool ↔ OpenAI), ms */
  elapsedMs?: number;
}

/**
 * Réponse REST parfois en snake_case ou chaîne selon proxies / anciennes builds.
 */
export function parseElapsedMsFromAssistantResponse(
  res: AssistantChatResponse | Record<string, unknown> | null | undefined
): number | undefined {
  if (res == null || typeof res !== 'object') {
    return undefined;
  }
  const raw = [
    (res as AssistantChatResponse).elapsedMs,
    (res as Record<string, unknown>)['elapsed_ms'],
    (res as Record<string, unknown>)['elapsedMS']
  ];
  for (const v of raw) {
    if (v == null) {
      continue;
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      const n = Math.round(Math.max(0, v));
      return n;
    }
    if (typeof v === 'string') {
      const t = v.trim();
      if (/^\d+$/.test(t)) {
        return parseInt(t, 10);
      }
    }
  }
  return undefined;
}

export interface AssistantOpenAiCredits {
  ok?: boolean;
  totalAvailableUsd?: number | null;
  totalGrantedUsd?: number | null;
  totalUsedUsd?: number | null;
  message?: string | null;
}

/** openai.provider + openai.assistant.model (backend application.properties). */
export interface AssistantClientConfig {
  provider?: string | null;
  model?: string | null;
}


@Injectable({ providedIn: 'root' })
export class AssistantService {
  private readonly apiUrl = environment.API_URL + 'assistant/chat';
  private readonly creditsUrl = environment.API_URL + 'assistant/openai/credits';
  private readonly configUrl = environment.API_URL + 'assistant/config';

  constructor(
    private http: HttpClient,
    private keycloak: KeycloakService,
    private translate: TranslateService
  ) {}

  private authHeaders(): Observable<HttpHeaders> {
    return from(this.keycloak.getToken()).pipe(
      map((token: string) =>
        new HttpHeaders({
          Accept: 'application/json',
          'Content-Type': 'application/json; charset=UTF-8',
          Authorization: 'Bearer ' + token
        })
      )
    );
  }

  sendMessages(
    messages: AssistantChatTurn[],
    system?: string
  ): Observable<AssistantChatResponse> {
    const body: { messages: AssistantChatTurn[]; system?: string } = { messages };
    if (system && system.trim()) {
      body.system = system.trim();
    }
    return this.authHeaders().pipe(
      switchMap((headers) =>
        this.http
          .post<AssistantChatResponse>(this.apiUrl, body, { headers })
          .pipe(
            catchError((err: HttpErrorResponse) => {
              const b = err.error as AssistantChatResponse | null | undefined;
              if (
                b != null &&
                typeof b === 'object' &&
                typeof b.error === 'string'
              ) {
                return of(b);
              }
              return throwError(() => err);
            })
          )
      )
    );
  }

  /** Configuration affichable (application.properties côté serveur). */
  getAssistantClientConfig(): Observable<AssistantClientConfig> {
    return this.authHeaders().pipe(
      switchMap((headers) =>
        this.http
          .get<AssistantClientConfig>(this.configUrl, { headers })
          .pipe(catchError(() => of({})))
      ),
      catchError(() => of({}))
    );
  }

  /** Crédits prépayés exposés par OpenAI (peut échouer selon le type de clé). L’Observable ne passe pas par erreur : body avec ok false + message explicatif. */
  getOpenAiCredits(): Observable<AssistantOpenAiCredits> {
    return this.authHeaders().pipe(
      switchMap((headers) =>
        this.http
          .get<AssistantOpenAiCredits>(this.creditsUrl, { headers })
          .pipe(
            catchError((err: unknown) => of(this.mapCreditsClientError(err)))
          )
      ),
      catchError((err: unknown) => of(this.mapCreditsClientError(err)))
    );
  }

  private mapCreditsClientError(err: unknown): AssistantOpenAiCredits {
    if (err instanceof HttpErrorResponse) {
      const fromBody = AssistantService.parseCreditsPayload(err.error);
      if (fromBody != null && (fromBody.message || fromBody.ok === false)) {
        return {
          ok: false,
          totalAvailableUsd: fromBody.totalAvailableUsd,
          totalGrantedUsd: fromBody.totalGrantedUsd,
          totalUsedUsd: fromBody.totalUsedUsd,
          message:
            (fromBody.message && fromBody.message.trim()) ||
            this.translate.instant('ASSISTANT.CREDITS_ERR_HTTP', {
              status: String(err.status)
            })
        };
      }
      if (err.status === 0) {
        return {
          ok: false,
          message: this.translate.instant('ASSISTANT.CREDITS_ERR_NO_RESPONSE')
        };
      }
      if (err.status === 401 || err.status === 403) {
        return {
          ok: false,
          message: this.translate.instant('ASSISTANT.CREDITS_ERR_UNAUTHORIZED')
        };
      }
      if (err.status === 404) {
        return {
          ok: false,
          message: this.translate.instant('ASSISTANT.CREDITS_ERR_NOT_FOUND')
        };
      }
      return {
        ok: false,
        message: this.translate.instant('ASSISTANT.CREDITS_ERR_HTTP', {
          status: String(err.status)
        })
      };
    }
    return {
      ok: false,
      message: this.translate.instant('ASSISTANT.CREDITS_ERR_TOKEN')
    };
  }

  private static parseCreditsPayload(raw: unknown): AssistantOpenAiCredits | null {
    if (raw === null || typeof raw !== 'object') {
      return null;
    }
    const o = raw as Record<string, unknown>;
    if (typeof o['ok'] !== 'boolean') {
      return null;
    }
    return {
      ok: o['ok'] as boolean,
      totalAvailableUsd: (o['totalAvailableUsd'] ?? undefined) as
        | number
        | null
        | undefined,
      totalGrantedUsd: (o['totalGrantedUsd'] ?? undefined) as
        | number
        | null
        | undefined,
      totalUsedUsd: (o['totalUsedUsd'] ?? undefined) as number | null | undefined,
      message: (o['message'] ?? undefined) as string | null | undefined
    };
  }
}
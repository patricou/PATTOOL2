import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { KeycloakService } from '../keycloak/keycloak.service';
import { TranslateService } from '@ngx-translate/core';
import { environment } from '../../environments/environment';
import { Observable, from, throwError, of, EMPTY } from 'rxjs';
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
  /** Indique qu’une image a été envoyée avec ce message. */
  hasImage?: boolean;
  /** Aperçu local (data URL) ; non sérialisé en session. */
  imageDataUrl?: string;
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

/** Libellés + routage par défaut côté serveur (GET /assistant/config). */
export interface AssistantClientConfig {
  provider?: string | null;
  model?: string | null;
  /** openai | anthropic — valeur de assistant.provider côté Spring. */
  routingDefault?: string | null;
  /** Préférence persistée (Mongo appParameters), si l’utilisateur en a déjà enregistré une. */
  persistedRouting?: AssistantRoutingStored | null;
}

/** Fournisseur + modèle effectifs pour un tour de chat (surcharge la config serveur). */
export interface AssistantRoutingRequest {
  provider: 'openai' | 'anthropic';
  model: string;
}

/** Persistance du choix fournisseur / modèle dans l’assistant (sessionStorage + optionnellement Mongo via API). */
export interface AssistantRoutingStored {
  provider: 'openai' | 'anthropic';
  modelPreset: string;
  modelCustom: string;
}

export interface AssistantToolFlagsRequest {
  webSearch?: boolean;
  imageGeneration?: boolean;
  mcp?: boolean;
}

/** Image jointe au dernier message (vision côté serveur). */
export interface AssistantAttachedImageRequest {
  mimeType: string;
  base64: string;
}

@Injectable({ providedIn: 'root' })
export class AssistantService {
  private readonly apiUrl = environment.API_URL + 'assistant/chat';
  private readonly creditsUrl = environment.API_URL + 'assistant/openai/credits';
  private readonly configUrl = environment.API_URL + 'assistant/config';
  private readonly routingPrefUrl =
    environment.API_URL + 'assistant/routing-preference';

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
    system?: string,
    tools?: AssistantToolFlagsRequest,
    attachedImage?: AssistantAttachedImageRequest,
    routing?: AssistantRoutingRequest
  ): Observable<AssistantChatResponse> {
    const slimMessages = messages.map((m) => ({
      role: m.role,
      content: m.content
    }));
    const body: {
      messages: { role: string; content: string }[];
      system?: string;
      tools?: AssistantToolFlagsRequest;
      attachedImage?: AssistantAttachedImageRequest;
      provider?: string;
      model?: string;
    } = { messages: slimMessages };
    if (system && system.trim()) {
      body.system = system.trim();
    }
    if (
      tools &&
      (tools.webSearch === true ||
        tools.imageGeneration === true ||
        tools.mcp === true)
    ) {
      body.tools = {
        ...(tools.webSearch === true ? { webSearch: true } : {}),
        ...(tools.imageGeneration === true ? { imageGeneration: true } : {}),
        ...(tools.mcp === true ? { mcp: true } : {})
      };
    }
    if (
      attachedImage &&
      attachedImage.mimeType &&
      attachedImage.base64 &&
      attachedImage.mimeType.trim() &&
      attachedImage.base64.trim()
    ) {
      body.attachedImage = {
        mimeType: attachedImage.mimeType.trim(),
        base64: attachedImage.base64.trim()
      };
    }
    if (routing?.provider === 'openai' || routing?.provider === 'anthropic') {
      body.provider = routing.provider;
    }
    if (routing?.model?.trim()) {
      body.model = routing.model.trim();
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

  /** Enregistre le couple fournisseur / modèle pour l’utilisateur connecté (Mongo appParameters). */
  saveAssistantRoutingPreference(r: AssistantRoutingStored): Observable<void> {
    const body = {
      provider: r.provider,
      modelPreset: r.modelPreset,
      modelCustom: r.modelCustom ?? ''
    };
    return this.authHeaders().pipe(
      switchMap((headers) =>
        this.http.put<void>(this.routingPrefUrl, body, { headers })
      ),
      catchError(() => EMPTY)
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
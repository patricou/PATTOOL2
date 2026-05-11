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
  /** Images générées référencées côté serveur (historique rechargé sans data URL). */
  generatedImageAssetIds?: string[];
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
  /** openai | anthropic | gemini — valeur de assistant.provider côté Spring. */
  routingDefault?: string | null;
  /** Préférence persistée (Mongo appParameters), si l’utilisateur en a déjà enregistré une. */
  persistedRouting?: AssistantRoutingStored | null;
  /** Modèles par défaut dans application.properties (un par fournisseur). */
  openaiDefaultModel?: string | null;
  anthropicDefaultModel?: string | null;
  geminiDefaultModel?: string | null;
  /** Liens bandeau facturation / usage (assistant.billing.* côté serveur). */
  billingOpenaiBillingUrl?: string | null;
  billingOpenaiUsageUrl?: string | null;
  billingAnthropicUrl?: string | null;
  billingGeminiRateLimitUrl?: string | null;
  billingGeminiApiKeysUrl?: string | null;
  /** gemini.image-generation-model côté serveur (non sensible). */
  geminiImageGenerationModel?: string | null;
}

/** Fournisseur + modèle effectifs pour un tour de chat (surcharge la config serveur). */
export interface AssistantRoutingRequest {
  provider: 'openai' | 'anthropic' | 'gemini';
  model: string;
}

/** Persistance du choix fournisseur / modèle dans l’assistant (sessionStorage + optionnellement Mongo via API). */
export interface AssistantRoutingStored {
  provider: 'openai' | 'anthropic' | 'gemini';
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

/** Corps POST pour {@code /assistant/export-pdf} — libellés déjà traduits côté client. */
export interface AssistantPdfExportTurn {
  role: 'user' | 'assistant';
  content?: string;
  hasImage?: boolean;
  /** @deprecated Préférer {@link embeddedImageDataUrls} ; encore accepté côté serveur si la liste est vide. */
  imageDataUrl?: string | null;
  /** Images à intégrer au PDF (data:image/...), ordre conservé (utilisateur + réponses avec images générées). */
  embeddedImageDataUrls?: string[];
  providerModelLine?: string | null;
  statsLine?: string | null;
}

export interface AssistantPdfExportRequest {
  title?: string;
  exportedAt?: string;
  youLabel: string;
  assistantLabel: string;
  turns: AssistantPdfExportTurn[];
}

/**
 * Tour persisté (Mongo) — images utilisateur en data URL ;
 * images générées assistant via {@link generatedImageAssetIds} (fichiers dédiés), pas dans {@code content}.
 */
export interface AssistantConversationTurnPersist {
  role: 'user' | 'assistant';
  content: string;
  hasImage?: boolean;
  imageDataUrl?: string | null;
  generatedImageAssetIds?: string[];
  meta?: {
    elapsedMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    provider?: string;
    model?: string;
  };
}

export interface AssistantConversationSaveBody {
  routingProvider: 'openai' | 'anthropic' | 'gemini';
  providerLabel: string;
  model: string;
  turns: AssistantConversationTurnPersist[];
}

export interface AssistantConversationSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  routingProvider: string;
  providerLabel: string;
  model: string;
  preview: string;
  /** JWT Keycloak `sub` du propriétaire de la conversation */
  ownerSubject?: string | null;
  /** `preferred_username` du JWT à la création (peut être vide pour les anciennes entrées). */
  ownerPreferredUsername?: string | null;
}

export interface AssistantConversationDetail extends AssistantConversationSummary {
  turns: AssistantConversationTurnPersist[];
}

@Injectable({ providedIn: 'root' })
export class AssistantService {
  private readonly apiUrl = environment.API_URL + 'assistant/chat';
  private readonly creditsUrl = environment.API_URL + 'assistant/openai/credits';
  private readonly configUrl = environment.API_URL + 'assistant/config';
  private readonly routingPrefUrl =
    environment.API_URL + 'assistant/routing-preference';

  private readonly exportPdfUrl = environment.API_URL + 'assistant/export-pdf';
  private readonly conversationsUrl =
    environment.API_URL + 'assistant/conversations';

  private readonly conversationAssetsUrl =
    environment.API_URL + 'assistant/conversation-assets';

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
    if (
      routing?.provider === 'openai' ||
      routing?.provider === 'anthropic' ||
      routing?.provider === 'gemini'
    ) {
      body.provider = routing.provider;
      const modelTrimmed = routing.model?.trim();
      if (modelTrimmed) {
        body.model = modelTrimmed;
      }
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

  /**
   * Export PDF de la conversation : rendu HTML/Markdown côté serveur (corps déjà traduit par l’UI).
   */
  exportThreadPdf(payload: AssistantPdfExportRequest): Observable<Blob> {
    return this.authHeaders().pipe(
      switchMap((headers) =>
        this.http.post(this.exportPdfUrl, payload, {
          headers: headers.set('Accept', 'application/pdf'),
          responseType: 'blob',
          observe: 'response'
        })
      ),
      switchMap((res) => {
        if (res.status === 200 && res.body) {
          return of(res.body);
        }
        return from(res.body?.text() ?? Promise.resolve('')).pipe(
          switchMap((txt) =>
            throwError(
              () =>
                new HttpErrorResponse({
                  status: res.status,
                  statusText: res.statusText,
                  url: res.url ?? undefined,
                  error: txt || res.statusText
                })
            )
          )
        );
      }),
      catchError((err: HttpErrorResponse) => {
        if (err.error instanceof Blob) {
          return from(err.error.text()).pipe(
            switchMap((txt) =>
              throwError(
                () =>
                  new HttpErrorResponse({
                    status: err.status,
                    statusText: err.statusText,
                    url: err.url ?? undefined,
                    error: txt || err.message
                  })
              )
            )
          );
        }
        return throwError(() => err);
      })
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

  /**
   * Modèles renvoyés par l’API du fournisseur (clé configurée côté serveur), pour le sélecteur de l’assistant.
   * Retourne une liste vide si l’appel échoue ; le client garde alors ses presets locaux.
   */
  getAssistantModels(
    provider: 'openai' | 'anthropic' | 'gemini'
  ): Observable<string[]> {
    const url =
      environment.API_URL +
      'assistant/models?provider=' +
      encodeURIComponent(provider);
    return this.authHeaders().pipe(
      switchMap((headers) =>
        this.http
          .get<{ models?: string[] | null }>(url, { headers })
          .pipe(
            map((body) => {
              const m = body?.models;
              if (!Array.isArray(m)) {
                return [];
              }
              return m.filter(
                (x): x is string =>
                  typeof x === 'string' && x.trim().length > 0
              );
            }),
            catchError(() => of([] as string[]))
          )
      ),
      catchError(() => of([] as string[]))
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

  listConversations(): Observable<AssistantConversationSummary[]> {
    return this.authHeaders().pipe(
      switchMap((headers) =>
        this.http.get<AssistantConversationSummary[]>(this.conversationsUrl, {
          headers
        })
      )
    );
  }

  getConversation(id: string): Observable<AssistantConversationDetail> {
    const url = `${this.conversationsUrl}/${encodeURIComponent(id)}`;
    return this.authHeaders().pipe(
      switchMap((headers) =>
        this.http.get<AssistantConversationDetail>(url, { headers })
      )
    );
  }

  createConversation(
    body: AssistantConversationSaveBody
  ): Observable<{ id: string }> {
    return this.authHeaders().pipe(
      switchMap((headers) =>
        this.http.post<{ id: string }>(this.conversationsUrl, body, {
          headers
        })
      )
    );
  }

  updateConversation(
    id: string,
    body: AssistantConversationSaveBody
  ): Observable<void> {
    const url = `${this.conversationsUrl}/${encodeURIComponent(id)}`;
    return this.authHeaders().pipe(
      switchMap((headers) =>
        this.http.put<void>(url, body, { headers, observe: 'body' })
      )
    );
  }

  deleteConversation(id: string): Observable<void> {
    const url = `${this.conversationsUrl}/${encodeURIComponent(id)}`;
    return this.authHeaders().pipe(
      switchMap((headers) =>
        this.http.delete<void>(url, { headers, observe: 'body' })
      )
    );
  }

  uploadConversationAsset(body: {
    mimeType: string;
    base64: string;
  }): Observable<{ id: string }> {
    return this.authHeaders().pipe(
      switchMap((headers) =>
        this.http.post<{ id: string }>(this.conversationAssetsUrl, body, {
          headers
        })
      )
    );
  }

  getConversationAssetBlob(id: string): Observable<Blob> {
    const url = `${this.conversationAssetsUrl}/${encodeURIComponent(id)}`;
    return this.authHeaders().pipe(
      switchMap((headers) =>
        this.http.get(url, {
          headers: headers.set('Accept', 'image/*,*/*'),
          responseType: 'blob'
        })
      )
    );
  }
}
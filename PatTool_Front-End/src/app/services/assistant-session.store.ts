import { Injectable } from '@angular/core';
import { KeycloakService } from '../keycloak/keycloak.service';
import {
  AssistantChatMeta,
  AssistantChatTurn,
  AssistantRoutingStored,
  AssistantToolFlagsRequest
} from './assistant.service';

interface StoredShape {
  messages?: unknown;
  draft?: string;
  toolFlags?: AssistantToolFlagsRequest;
  routing?: AssistantRoutingStored;
}

/** Historique du panneau assistant par utilisateur, dans sessionStorage (onglet). */
@Injectable({ providedIn: 'root' })
export class AssistantSessionStore {
  private static readonly PREFIX = 'pat-assistant-chat';

  constructor(private keycloak: KeycloakService) {}

  private static sanitizeMeta(role: AssistantChatTurn['role'], meta: unknown): AssistantChatMeta | undefined {
    if (role !== 'assistant' || !meta || typeof meta !== 'object') {
      return undefined;
    }
    const o = meta as Record<string, unknown>;
    const out: AssistantChatMeta = {};

    const elapsedRaw = o['elapsedMs'] ?? o['elapsed_ms'] ?? o['elapsedMS'];
    if (typeof elapsedRaw === 'number' && Number.isFinite(elapsedRaw) && elapsedRaw >= 0) {
      out.elapsedMs = Math.round(elapsedRaw);
    } else if (typeof elapsedRaw === 'string' && /^\d+$/.test(elapsedRaw.trim())) {
      out.elapsedMs = parseInt(elapsedRaw.trim(), 10);
    }

    if (typeof o['inputTokens'] === 'number') {
      out.inputTokens = o['inputTokens'];
    }
    if (typeof o['outputTokens'] === 'number') {
      out.outputTokens = o['outputTokens'];
    }

    const prov =
      typeof o['provider'] === 'string' ? o['provider'].trim() : '';
    if (prov) {
      out.provider = prov;
    }
    const mod = typeof o['model'] === 'string' ? o['model'].trim() : '';
    if (mod) {
      out.model = mod;
    }
    return Object.keys(out).length ? out : undefined;
  }

  private static sanitizeRouting(raw: unknown): AssistantRoutingStored | undefined {
    if (raw == null || typeof raw !== 'object') {
      return undefined;
    }
    const o = raw as Record<string, unknown>;
    const p = o['provider'];
    if (p !== 'openai' && p !== 'anthropic' && p !== 'gemini') {
      return undefined;
    }
    const modelPreset =
      typeof o['modelPreset'] === 'string' ? o['modelPreset'] : '__custom__';
    const modelCustom =
      typeof o['modelCustom'] === 'string' ? o['modelCustom'] : '';
    return {
      provider: p,
      modelPreset,
      modelCustom
    };
  }

  private static sanitizeToolFlags(
    raw: unknown
  ): AssistantToolFlagsRequest | undefined {
    if (raw == null || typeof raw !== 'object') {
      return undefined;
    }
    const o = raw as Record<string, unknown>;
    const out: AssistantToolFlagsRequest = {};
    if (o['webSearch'] === true) {
      out.webSearch = true;
    }
    if (o['imageGeneration'] === true) {
      out.imageGeneration = true;
    }
    if (o['mcp'] === true) {
      out.mcp = true;
    }
    return Object.keys(out).length ? out : undefined;
  }

  private key(): string {
    const auth = this.keycloak.getAuth();
    const id =
      auth?.subject ??
      auth?.tokenParsed?.sub ??
      auth?.tokenParsed?.preferred_username ??
      'anonymous';
    return `${AssistantSessionStore.PREFIX}:${String(id)}`;
  }

  load(): {
    messages: AssistantChatTurn[];
    draft: string;
    toolFlags?: AssistantToolFlagsRequest;
    routing?: AssistantRoutingStored;
  } | null {
    try {
      const raw = sessionStorage.getItem(this.key());
      if (!raw) {
        return null;
      }
      const data = JSON.parse(raw) as StoredShape;
      if (!Array.isArray(data.messages)) {
        return null;
      }
      const messages: AssistantChatTurn[] = [];
      for (const row of data.messages) {
        if (
          row &&
          typeof row === 'object' &&
          (row as AssistantChatTurn).role !== undefined &&
          typeof (row as AssistantChatTurn).content === 'string'
        ) {
          const r = row as AssistantChatTurn;
          if (r.role === 'user' || r.role === 'assistant') {
            const meta =
              Object.prototype.hasOwnProperty.call(r, 'meta')
                ? AssistantSessionStore.sanitizeMeta(r.role, r.meta)
                : undefined;
            const hasImage =
              r.role === 'user' &&
              (row as unknown as Record<string, unknown>)['hasImage'] === true;
            messages.push({
              role: r.role,
              content: r.content,
              ...(meta ? { meta } : {}),
              ...(hasImage ? { hasImage: true } : {})
            });
          }
        }
      }
      const draft = typeof data.draft === 'string' ? data.draft : '';
      const toolFlags = AssistantSessionStore.sanitizeToolFlags(data.toolFlags);
      const routing = AssistantSessionStore.sanitizeRouting(data.routing);
      return {
        messages,
        draft,
        ...(toolFlags ? { toolFlags } : {}),
        ...(routing ? { routing } : {})
      };
    } catch {
      return null;
    }
  }

  save(
    messages: AssistantChatTurn[],
    draft: string,
    toolFlags?: AssistantToolFlagsRequest,
    routing?: AssistantRoutingStored
  ): void {
    try {
      const slim = messages.map((m) => {
        const row: {
          role: AssistantChatTurn['role'];
          content: string;
          meta?: AssistantChatMeta;
          hasImage?: boolean;
        } = { role: m.role, content: m.content };
        if (m.meta != null && typeof m.meta === 'object') {
          const meta = AssistantSessionStore.sanitizeMeta(m.role, m.meta);
          if (meta) {
            row.meta = meta;
          }
        }
        if (m.role === 'user' && m.hasImage === true) {
          row.hasImage = true;
        }
        return row;
      });
      const payload: Record<string, unknown> = { messages: slim, draft };
      if (toolFlags != null && Object.keys(toolFlags).length > 0) {
        payload['toolFlags'] = toolFlags;
      }
      if (routing != null) {
        payload['routing'] = {
          provider: routing.provider,
          modelPreset: routing.modelPreset,
          modelCustom: routing.modelCustom
        };
      }
      sessionStorage.setItem(this.key(), JSON.stringify(payload));
    } catch {
      /* quota / private mode */
    }
  }
}

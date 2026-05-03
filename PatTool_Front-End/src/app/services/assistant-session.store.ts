import { Injectable } from '@angular/core';
import { KeycloakService } from '../keycloak/keycloak.service';
import {
  AssistantChatMeta,
  AssistantChatTurn
} from './assistant.service';

interface StoredShape {
  messages?: unknown;
  draft?: string;
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

  private key(): string {
    const auth = this.keycloak.getAuth();
    const id =
      auth?.subject ??
      auth?.tokenParsed?.sub ??
      auth?.tokenParsed?.preferred_username ??
      'anonymous';
    return `${AssistantSessionStore.PREFIX}:${String(id)}`;
  }

  load(): { messages: AssistantChatTurn[]; draft: string } | null {
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
            messages.push({
              role: r.role,
              content: r.content,
              ...(meta ? { meta } : {})
            });
          }
        }
      }
      const draft = typeof data.draft === 'string' ? data.draft : '';
      return { messages, draft };
    } catch {
      return null;
    }
  }

  save(messages: AssistantChatTurn[], draft: string): void {
    try {
      sessionStorage.setItem(this.key(), JSON.stringify({ messages, draft }));
    } catch {
      /* quota / private mode */
    }
  }
}

import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

export interface AssistantLaunchToolFlags {
  webSearch?: boolean;
  imageGeneration?: boolean;
  mcp?: boolean;
}

export interface AssistantLaunchPayload {
  draft: string;
  /** Si true, l’historique du chat est effacé avant d’ouvrir (nouvelle discussion). */
  newConversation?: boolean;
  /** Si présent, met à jour les cases à cocher outils (recherche web, image, MCP). */
  toolFlags?: AssistantLaunchToolFlags;
}

/**
 * Ouverture du panneau assistant depuis une autre page (pré-remplissage du message).
 */
@Injectable({ providedIn: 'root' })
export class AssistantLaunchService {
  private readonly launches = new Subject<AssistantLaunchPayload>();

  readonly launches$: Observable<AssistantLaunchPayload> = this.launches.asObservable();

  openWithDraft(
    text: string,
    options?: { newConversation?: boolean; toolFlags?: AssistantLaunchToolFlags }
  ): void {
    const draft = text?.trim() ?? '';
    if (!draft.length) {
      return;
    }
    const newConversation = options?.newConversation === true;
    const toolFlags = options?.toolFlags;
    this.launches.next({
      draft,
      newConversation,
      ...(toolFlags != null ? { toolFlags } : {})
    });
  }
}

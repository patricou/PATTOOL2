import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

export interface AssistantLaunchToolFlags {
  webSearch?: boolean;
  imageGeneration?: boolean;
  mcp?: boolean;
}

/** Image jointe au prochain message (vision) — ex. depuis le slideshow. */
export interface AssistantLaunchAttachedImage {
  mimeType: string;
  base64: string;
  dataUrl: string;
}

export interface AssistantLaunchPayload {
  /** Texte du brouillon ; peut être vide si `attachedImage` est fourni (le champ reste vide, l’indication
   *  est affichée dans le placeholder du textarea). */
  draft: string;
  /** Si true, l’historique du chat est effacé avant d’ouvrir (nouvelle discussion). */
  newConversation?: boolean;
  /** Si présent, met à jour les cases à cocher outils (recherche web, image, MCP). */
  toolFlags?: AssistantLaunchToolFlags;
  /** Image à joindre (ex. depuis le slideshow) ; ouvre le panneau avec vision prête à envoyer. */
  attachedImage?: AssistantLaunchAttachedImage;
  /** Si true, envoie le message immédiatement après ouverture du panneau (texte non vide requis). */
  autoSend?: boolean;
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
    options?: {
      newConversation?: boolean;
      toolFlags?: AssistantLaunchToolFlags;
      attachedImage?: AssistantLaunchAttachedImage;
      autoSend?: boolean;
    }
  ): void {
    const draft = text?.trim() ?? '';
    const hasImage = !!options?.attachedImage;
    if (!draft.length && !hasImage) {
      return;
    }
    const newConversation = options?.newConversation === true;
    const toolFlags = options?.toolFlags;
    const attachedImage = options?.attachedImage;
    const autoSend = options?.autoSend === true;
    this.launches.next({
      draft,
      newConversation,
      ...(autoSend ? { autoSend: true } : {}),
      ...(toolFlags != null ? { toolFlags } : {}),
      ...(attachedImage != null ? { attachedImage } : {})
    });
  }
}

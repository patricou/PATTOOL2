import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

export interface AssistantLaunchPayload {
  draft: string;
  /** Si true, l’historique du chat est effacé avant d’ouvrir (nouvelle discussion). */
  newConversation?: boolean;
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
    options?: { newConversation?: boolean }
  ): void {
    const draft = text?.trim() ?? '';
    if (!draft.length) {
      return;
    }
    const newConversation = options?.newConversation === true;
    this.launches.next({ draft, newConversation });
  }
}

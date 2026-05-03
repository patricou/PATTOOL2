import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

export interface AssistantLaunchPayload {
  draft: string;
}

/**
 * Ouverture du panneau assistant depuis une autre page (pré-remplissage du message).
 */
@Injectable({ providedIn: 'root' })
export class AssistantLaunchService {
  private readonly launches = new Subject<AssistantLaunchPayload>();

  readonly launches$: Observable<AssistantLaunchPayload> = this.launches.asObservable();

  openWithDraft(text: string): void {
    const draft = text?.trim() ?? '';
    if (!draft.length) {
      return;
    }
    this.launches.next({ draft });
  }
}

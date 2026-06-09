import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

export interface AssistantLaunchToolFlags {
  webSearch?: boolean;
  imageGeneration?: boolean;
  mcp?: boolean;
}

/** Provider and model applied when opening the drawer (no deferred Mongo persistence). */
export interface AssistantLaunchRouting {
  provider: 'openai' | 'anthropic' | 'gemini';
  /** Preset id (assistant catalogue) or special UI "custom" value. */
  modelPreset: string;
  modelCustom?: string;
}

/** Image attached to the next message (vision), e.g. from slideshow. */
export interface AssistantLaunchAttachedImage {
  mimeType: string;
  base64: string;
  dataUrl: string;
}

/**
 * Photo / vision: slideshow, camera, or gallery/file picker → Google Gemini image-capable flash preview.
 * Keep in sync with models enabled on the backend / {@code GET /api/assistant/models?provider=gemini}.
 */
export const ASSISTANT_VISION_GEMINI_MODEL_ID = 'gemini-3.1-flash-image-preview';

export const ASSISTANT_VISION_IMAGE_LAUNCH_ROUTING: AssistantLaunchRouting = {
  provider: 'gemini',
  modelPreset: ASSISTANT_VISION_GEMINI_MODEL_ID
};

/**
 * News article card → assistant: Google Gemini 3.1 Pro class model (UI: "Gemini 3.1 Pro (Search)").
 * Web search is enabled via {@link AssistantLaunchToolFlags.webSearch}; server uses Gemini grounding tools.
 * Model id must match {@code GET /api/assistant/models?provider=gemini} / Google AI API naming.
 */
export const ASSISTANT_NEWS_GEMINI_MODEL_ID = 'gemini-3.1-pro-preview';

export const ASSISTANT_NEWS_LAUNCH_ROUTING: AssistantLaunchRouting = {
  provider: 'gemini',
  modelPreset: ASSISTANT_NEWS_GEMINI_MODEL_ID
};

/**
 * Activities / events UI ({@code element-evenement}, home list, detail page) → Anthropic Claude Opus 4.8.
 */
export const ASSISTANT_EVENT_ELEMENT_LAUNCH_ROUTING: AssistantLaunchRouting = {
  provider: 'anthropic',
  modelPreset: 'claude-opus-4-8'
};

export interface AssistantLaunchPayload {
  /** Draft text; may be empty when `attachedImage` is set (field stays empty; hint shown in textarea placeholder). */
  draft: string;
  /** If true, chat history is cleared before opening (new conversation). */
  newConversation?: boolean;
  /** When set, updates tool checkboxes (web search, image, MCP). */
  toolFlags?: AssistantLaunchToolFlags;
  /** When set, fixes provider + model before opening (session only). */
  routing?: AssistantLaunchRouting;
  /** Image to attach (e.g. slideshow); opens panel ready for vision send. */
  attachedImage?: AssistantLaunchAttachedImage;
  /** If true, sends the message immediately after opening (non-empty text required). */
  autoSend?: boolean;
}

/**
 * Opens the assistant drawer from another page (prefilled message).
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
      routing?: AssistantLaunchRouting;
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
    const routing = options?.routing;
    const attachedImage = options?.attachedImage;
    const autoSend = options?.autoSend === true;
    this.launches.next({
      draft,
      newConversation,
      ...(autoSend ? { autoSend: true } : {}),
      ...(toolFlags != null ? { toolFlags } : {}),
      ...(routing != null ? { routing } : {}),
      ...(attachedImage != null ? { attachedImage } : {})
    });
  }
}

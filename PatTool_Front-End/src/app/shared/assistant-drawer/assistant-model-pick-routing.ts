import { AssistantProviderSlug } from '../../services/assistant.service';

/** Routing applied when the user clicks a model in the tools help modal. */
export interface AssistantModelPickRouting {
  readonly provider: AssistantProviderSlug;
  readonly apiModelId: string;
  readonly enableWebSearch?: boolean;
  readonly enableImageGeneration?: boolean;
  /** Not selectable in PatTool (e.g. Veo). */
  readonly unavailable?: boolean;
}

/**
 * i18n keys ASSISTANT.TOOLS_HELP_RANK_* (_G / _S / _B) → provider + PatTool API id.
 * Rankings use models actually selectable in PatTool (not market-only ids).
 */
export const ASSISTANT_MODEL_PICK_ROUTING: Readonly<Record<string, AssistantModelPickRouting>> = {
  'ASSISTANT.TOOLS_HELP_RANK_T01_G': { provider: 'anthropic', apiModelId: 'claude-fable-5' },
  'ASSISTANT.TOOLS_HELP_RANK_T01_S': { provider: 'openai', apiModelId: 'gpt-5.5' },
  'ASSISTANT.TOOLS_HELP_RANK_T01_B': { provider: 'anthropic', apiModelId: 'claude-opus-4-8' },

  'ASSISTANT.TOOLS_HELP_RANK_T02_G': { provider: 'openai', apiModelId: 'gpt-5.5' },
  'ASSISTANT.TOOLS_HELP_RANK_T02_S': { provider: 'anthropic', apiModelId: 'claude-sonnet-4-6' },
  'ASSISTANT.TOOLS_HELP_RANK_T02_B': { provider: 'spacexai', apiModelId: 'grok-4.6' },

  'ASSISTANT.TOOLS_HELP_RANK_T03_G': {
    provider: 'gemini',
    apiModelId: 'gemini-2.5-flash',
    enableWebSearch: true
  },
  'ASSISTANT.TOOLS_HELP_RANK_T03_S': {
    provider: 'spacexai',
    apiModelId: 'grok-4.6',
    enableWebSearch: true
  },
  'ASSISTANT.TOOLS_HELP_RANK_T03_B': {
    provider: 'anthropic',
    apiModelId: 'claude-sonnet-4-6',
    enableWebSearch: true
  },

  'ASSISTANT.TOOLS_HELP_RANK_T04_G': {
    provider: 'gemini',
    apiModelId: 'gemini-3.1-flash-image-preview',
    enableImageGeneration: true
  },
  'ASSISTANT.TOOLS_HELP_RANK_T04_S': {
    provider: 'openai',
    apiModelId: 'gpt-4o',
    enableImageGeneration: true
  },

  'ASSISTANT.TOOLS_HELP_RANK_T05_G': {
    provider: 'openai',
    apiModelId: 'gpt-4o',
    enableImageGeneration: true
  },
  'ASSISTANT.TOOLS_HELP_RANK_T05_S': {
    provider: 'gemini',
    apiModelId: 'gemini-3.1-flash-image-preview',
    enableImageGeneration: true
  },

  'ASSISTANT.TOOLS_HELP_RANK_T06_G': { provider: 'anthropic', apiModelId: 'claude-fable-5' },
  'ASSISTANT.TOOLS_HELP_RANK_T06_S': { provider: 'openai', apiModelId: 'gpt-5.5' },
  'ASSISTANT.TOOLS_HELP_RANK_T06_B': { provider: 'spacexai', apiModelId: 'grok-4.6' },

  'ASSISTANT.TOOLS_HELP_RANK_T07_G': { provider: 'gemini', apiModelId: 'gemini-3.1-pro-preview' },
  'ASSISTANT.TOOLS_HELP_RANK_T07_S': { provider: 'anthropic', apiModelId: 'claude-fable-5' },
  'ASSISTANT.TOOLS_HELP_RANK_T07_B': { provider: 'openai', apiModelId: 'gpt-5.5' },

  'ASSISTANT.TOOLS_HELP_RANK_T08_G': { provider: 'gemini', apiModelId: 'gemini-3.1-pro-preview' },
  'ASSISTANT.TOOLS_HELP_RANK_T08_S': { provider: 'openai', apiModelId: 'gpt-4o' },
  'ASSISTANT.TOOLS_HELP_RANK_T08_B': { provider: 'spacexai', apiModelId: 'grok-4.6' },

  'ASSISTANT.TOOLS_HELP_RANK_T09_G': { provider: 'gemini', apiModelId: 'gemini-2.5-flash' },
  'ASSISTANT.TOOLS_HELP_RANK_T09_S': { provider: 'openai', apiModelId: 'gpt-4o-mini' },
  'ASSISTANT.TOOLS_HELP_RANK_T09_B': { provider: 'anthropic', apiModelId: 'claude-haiku-4-5-20251001' },

  'ASSISTANT.TOOLS_HELP_RANK_T10_G': { provider: 'gemini', apiModelId: 'gemini-3.1-pro-preview' },
  'ASSISTANT.TOOLS_HELP_RANK_T10_S': { provider: 'openai', apiModelId: 'gpt-5.5' },

  'ASSISTANT.TOOLS_HELP_RANK_T11_G': { provider: 'gemini', apiModelId: '', unavailable: true },

  'ASSISTANT.TOOLS_HELP_RANK_T12_G': { provider: 'gemini', apiModelId: 'gemini-3.1-pro-preview' },
  'ASSISTANT.TOOLS_HELP_RANK_T12_S': { provider: 'anthropic', apiModelId: 'claude-fable-5' },
  'ASSISTANT.TOOLS_HELP_RANK_T12_B': { provider: 'spacexai', apiModelId: 'grok-4.20-0309-reasoning' },

  'ASSISTANT.TOOLS_HELP_RANK_T13_G': { provider: 'mistral', apiModelId: 'mistral-large-latest' },
  'ASSISTANT.TOOLS_HELP_RANK_T13_S': { provider: 'openai', apiModelId: 'gpt-5.5' },
  'ASSISTANT.TOOLS_HELP_RANK_T13_B': { provider: 'anthropic', apiModelId: 'claude-sonnet-4-6' },

  'ASSISTANT.TOOLS_HELP_RANK_T14_G': { provider: 'gemini', apiModelId: 'gemini-3.1-pro-preview' },
  'ASSISTANT.TOOLS_HELP_RANK_T14_S': { provider: 'anthropic', apiModelId: 'claude-fable-5' },
  'ASSISTANT.TOOLS_HELP_RANK_T14_B': { provider: 'openai', apiModelId: 'gpt-5.5' },

  'ASSISTANT.TOOLS_HELP_RANK_T15_G': { provider: 'anthropic', apiModelId: 'claude-fable-5' },
  'ASSISTANT.TOOLS_HELP_RANK_T15_S': { provider: 'openai', apiModelId: 'gpt-5.5' },
  'ASSISTANT.TOOLS_HELP_RANK_T15_B': { provider: 'spacexai', apiModelId: 'grok-4.6' },

  'ASSISTANT.TOOLS_HELP_RANK_T16_G': { provider: 'anthropic', apiModelId: 'claude-sonnet-4-6' },
  'ASSISTANT.TOOLS_HELP_RANK_T16_S': { provider: 'openai', apiModelId: 'gpt-5.5' },
  'ASSISTANT.TOOLS_HELP_RANK_T16_B': { provider: 'mistral', apiModelId: 'mistral-large-latest' },

  'ASSISTANT.TOOLS_HELP_RANK_T17_G': { provider: 'openai', apiModelId: 'gpt-5.5' },
  'ASSISTANT.TOOLS_HELP_RANK_T17_S': { provider: 'gemini', apiModelId: 'gemini-2.5-flash' },
  'ASSISTANT.TOOLS_HELP_RANK_T17_B': { provider: 'mistral', apiModelId: 'mistral-large-latest' },

  'ASSISTANT.TOOLS_HELP_RANK_T18_G': { provider: 'anthropic', apiModelId: 'claude-sonnet-4-6' },
  'ASSISTANT.TOOLS_HELP_RANK_T18_S': { provider: 'openai', apiModelId: 'gpt-5.5' },
  'ASSISTANT.TOOLS_HELP_RANK_T18_B': { provider: 'gemini', apiModelId: 'gemini-3.1-pro-preview' },

  'ASSISTANT.TOOLS_HELP_RANK_T19_G': { provider: 'spacexai', apiModelId: 'grok-4.6' },
  'ASSISTANT.TOOLS_HELP_RANK_T19_S': { provider: 'openai', apiModelId: 'gpt-5.5' },
  'ASSISTANT.TOOLS_HELP_RANK_T19_B': { provider: 'anthropic', apiModelId: 'claude-sonnet-4-6' },

  'ASSISTANT.TOOLS_HELP_RANK_T20_G': { provider: 'openai', apiModelId: 'gpt-5.5' },
  'ASSISTANT.TOOLS_HELP_RANK_T20_S': { provider: 'openai', apiModelId: 'gpt-4o' },

  'ASSISTANT.TOOLS_HELP_RANK_T21_G': { provider: 'mistral', apiModelId: 'mistral-large-latest' },
  'ASSISTANT.TOOLS_HELP_RANK_T21_S': { provider: 'anthropic', apiModelId: 'claude-sonnet-4-6' },
  'ASSISTANT.TOOLS_HELP_RANK_T21_B': { provider: 'openai', apiModelId: 'gpt-5.5' },

  'ASSISTANT.TOOLS_HELP_RANK_T22_G': { provider: 'gemini', apiModelId: 'gemini-3.1-pro-preview' },
  'ASSISTANT.TOOLS_HELP_RANK_T22_S': { provider: 'spacexai', apiModelId: 'grok-4.20-0309-reasoning' },
  'ASSISTANT.TOOLS_HELP_RANK_T22_B': { provider: 'openai', apiModelId: 'gpt-5.5' },

  'ASSISTANT.TOOLS_HELP_RANK_T23_G': { provider: 'mistral', apiModelId: 'codestral-latest' },
  'ASSISTANT.TOOLS_HELP_RANK_T23_S': { provider: 'anthropic', apiModelId: 'claude-haiku-4-5-20251001' },
  'ASSISTANT.TOOLS_HELP_RANK_T23_B': { provider: 'openai', apiModelId: 'gpt-4o-mini' }
};

export function assistantModelPickRoutingForKey(
  pickKey: string | undefined
): AssistantModelPickRouting | undefined {
  if (!pickKey) {
    return undefined;
  }
  return ASSISTANT_MODEL_PICK_ROUTING[pickKey];
}

export function isAssistantModelPickActionable(pickKey: string | undefined): boolean {
  const r = assistantModelPickRoutingForKey(pickKey);
  return !!r && !r.unavailable && !!r.apiModelId.trim();
}

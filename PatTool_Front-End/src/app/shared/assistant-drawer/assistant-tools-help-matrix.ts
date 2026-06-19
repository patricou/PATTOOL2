import { AssistantProviderSlug } from '../../services/assistant.service';

/** One row in the optional-tools matrix (tools help modal). */
export interface AssistantToolsHelpProviderRow {
  readonly sectionId: AssistantProviderSlug;
  readonly providerLabelKey: string;
  readonly webSearch: boolean;
  readonly imageGeneration: boolean;
  readonly mcp: boolean;
}

/** Checkboxes under the chat input — availability per provider. */
export const ASSISTANT_TOOLS_HELP_PROVIDER_MATRIX: readonly AssistantToolsHelpProviderRow[] = [
  {
    sectionId: 'openai',
    providerLabelKey: 'ASSISTANT.PROVIDER_OPENAI',
    webSearch: true,
    imageGeneration: true,
    mcp: true
  },
  {
    sectionId: 'gemini',
    providerLabelKey: 'ASSISTANT.PROVIDER_GEMINI',
    webSearch: true,
    imageGeneration: true,
    mcp: false
  },
  {
    sectionId: 'anthropic',
    providerLabelKey: 'ASSISTANT.PROVIDER_ANTHROPIC',
    webSearch: true,
    imageGeneration: false,
    mcp: false
  },
  {
    sectionId: 'mistral',
    providerLabelKey: 'ASSISTANT.PROVIDER_MISTRAL',
    webSearch: true,
    imageGeneration: false,
    mcp: false
  }
];

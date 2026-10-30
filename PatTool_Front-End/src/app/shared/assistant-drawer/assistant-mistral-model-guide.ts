import { AssistantModelGuideRow } from './assistant-model-guide.types';

/**
 * Tools help modal “Which model for which task?” — Mistral AI guide.
 * Copy in i18n (ASSISTANT.TOOLS_HELP_MISTRAL_*).
 * Medium 3.5 and Large 3 are deprecated (31 Oct 2026); Large 4 replaces them.
 */
export type AssistantMistralModelGuideRow = AssistantModelGuideRow;

export const ASSISTANT_MISTRAL_MODEL_GUIDE_ROWS: readonly AssistantMistralModelGuideRow[] = [
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_MISTRAL_LARGE_NAME',
    apiModelId: 'mistral-large-4',
    badgeKey: 'ASSISTANT.TOOLS_HELP_MISTRAL_LARGE_BADGE',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_MISTRAL_LARGE_U1',
      'ASSISTANT.TOOLS_HELP_MISTRAL_LARGE_U2',
      'ASSISTANT.TOOLS_HELP_MISTRAL_LARGE_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_MISTRAL_SMALL_NAME',
    apiModelId: 'mistral-small-2603',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_MISTRAL_SMALL_U1',
      'ASSISTANT.TOOLS_HELP_MISTRAL_SMALL_U2',
      'ASSISTANT.TOOLS_HELP_MISTRAL_SMALL_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_MISTRAL_CODESTRAL_NAME',
    apiModelId: 'codestral-latest',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_MISTRAL_CODESTRAL_U1',
      'ASSISTANT.TOOLS_HELP_MISTRAL_CODESTRAL_U2',
      'ASSISTANT.TOOLS_HELP_MISTRAL_CODESTRAL_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_MISTRAL_MINISTRAL_NAME',
    apiModelId: 'ministral-8b-2512',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_MISTRAL_MINISTRAL_U1',
      'ASSISTANT.TOOLS_HELP_MISTRAL_MINISTRAL_U2',
      'ASSISTANT.TOOLS_HELP_MISTRAL_MINISTRAL_U3'
    ]
  }
];

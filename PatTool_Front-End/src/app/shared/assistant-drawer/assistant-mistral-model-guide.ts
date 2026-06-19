import { AssistantModelGuideRow } from './assistant-model-guide.types';

/**
 * Modale aide « Quel modèle pour quelle tâche ? » — guide Mistral AI.
 * Textes dans i18n (ASSISTANT.TOOLS_HELP_MISTRAL_*).
 */
export type AssistantMistralModelGuideRow = AssistantModelGuideRow;

export const ASSISTANT_MISTRAL_MODEL_GUIDE_ROWS: readonly AssistantMistralModelGuideRow[] = [
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_MISTRAL_LARGE_NAME',
    apiModelId: 'mistral-large-latest',
    badgeKey: 'ASSISTANT.TOOLS_HELP_MISTRAL_LARGE_BADGE',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_MISTRAL_LARGE_U1',
      'ASSISTANT.TOOLS_HELP_MISTRAL_LARGE_U2',
      'ASSISTANT.TOOLS_HELP_MISTRAL_LARGE_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_MISTRAL_SMALL_NAME',
    apiModelId: 'mistral-small-latest',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_MISTRAL_SMALL_U1',
      'ASSISTANT.TOOLS_HELP_MISTRAL_SMALL_U2',
      'ASSISTANT.TOOLS_HELP_MISTRAL_SMALL_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_MISTRAL_PIXTRAL_NAME',
    apiModelId: 'pixtral-large-latest',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_MISTRAL_PIXTRAL_U1',
      'ASSISTANT.TOOLS_HELP_MISTRAL_PIXTRAL_U2',
      'ASSISTANT.TOOLS_HELP_MISTRAL_PIXTRAL_U3'
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
    apiModelId: 'ministral-8b-latest',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_MISTRAL_MINISTRAL_U1',
      'ASSISTANT.TOOLS_HELP_MISTRAL_MINISTRAL_U2',
      'ASSISTANT.TOOLS_HELP_MISTRAL_MINISTRAL_U3'
    ]
  }
];

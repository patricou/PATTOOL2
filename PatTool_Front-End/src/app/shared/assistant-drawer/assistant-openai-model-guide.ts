import { AssistantModelGuideRow } from './assistant-model-guide.types';

/**
 * Modale aide « Quel modèle pour quelle tâche ? » — guide OpenAI.
 * Textes dans i18n (ASSISTANT.TOOLS_HELP_OPENAI_*).
 */
export const ASSISTANT_OPENAI_MODEL_GUIDE_ROWS: readonly AssistantModelGuideRow[] = [
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_OPENAI_GPT55_NAME',
    apiModelId: 'gpt-5.5',
    badgeKey: 'ASSISTANT.TOOLS_HELP_OPENAI_GPT55_BADGE',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT55_U1',
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT55_U2',
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT55_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_OPENAI_GPT52_NAME',
    apiModelId: 'gpt-5.2',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT52_U1',
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT52_U2',
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT52_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_OPENAI_GPT41_NAME',
    apiModelId: 'gpt-4.1',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT41_U1',
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT41_U2',
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT41_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_OPENAI_GPT4O_NAME',
    apiModelId: 'gpt-4o',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT4O_U1',
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT4O_U2',
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT4O_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_OPENAI_GPT4OMINI_NAME',
    apiModelId: 'gpt-4o-mini',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT4OMINI_U1',
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT4OMINI_U2',
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT4OMINI_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_OPENAI_O4MINI_NAME',
    apiModelId: 'o4-mini',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_OPENAI_O4MINI_U1',
      'ASSISTANT.TOOLS_HELP_OPENAI_O4MINI_U2',
      'ASSISTANT.TOOLS_HELP_OPENAI_O4MINI_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_OPENAI_O3MINI_NAME',
    apiModelId: 'o3-mini',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_OPENAI_O3MINI_U1',
      'ASSISTANT.TOOLS_HELP_OPENAI_O3MINI_U2',
      'ASSISTANT.TOOLS_HELP_OPENAI_O3MINI_U3'
    ]
  }
];

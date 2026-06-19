import { AssistantModelGuideRow } from './assistant-model-guide.types';

/**
 * Modale aide « Quel modèle pour quelle tâche ? » — guide Anthropic (Claude).
 * Textes dans i18n (ASSISTANT.TOOLS_HELP_ANTHROPIC_*).
 */
export type AssistantAnthropicModelGuideRow = AssistantModelGuideRow;

export const ASSISTANT_ANTHROPIC_MODEL_GUIDE_ROWS: readonly AssistantAnthropicModelGuideRow[] = [
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_ANTHROPIC_FABLE5_NAME',
    apiModelId: 'claude-fable-5',
    badgeKey: 'ASSISTANT.TOOLS_HELP_ANTHROPIC_FABLE5_BADGE',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_FABLE5_U1',
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_FABLE5_U2',
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_FABLE5_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_ANTHROPIC_OPUS48_NAME',
    apiModelId: 'claude-opus-4-8',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_OPUS48_U1',
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_OPUS48_U2',
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_OPUS48_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_ANTHROPIC_SONNET46_NAME',
    apiModelId: 'claude-sonnet-4-6',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_SONNET46_U1',
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_SONNET46_U2',
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_SONNET46_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_ANTHROPIC_HAIKU45_NAME',
    apiModelId: 'claude-haiku-4-5-20251001',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_HAIKU45_U1',
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_HAIKU45_U2',
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_HAIKU45_U3'
    ]
  }
];

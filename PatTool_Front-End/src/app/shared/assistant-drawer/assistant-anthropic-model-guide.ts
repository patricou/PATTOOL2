import { AssistantModelGuideRow } from './assistant-model-guide.types';

/**
 * Tools help modal “Which model for which task?” — Anthropic (Claude) guide.
 * Copy in i18n (ASSISTANT.TOOLS_HELP_ANTHROPIC_*).
 */
export type AssistantAnthropicModelGuideRow = AssistantModelGuideRow;

export const ASSISTANT_ANTHROPIC_MODEL_GUIDE_ROWS: readonly AssistantAnthropicModelGuideRow[] = [
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_ANTHROPIC_FABLE51_NAME',
    apiModelId: 'claude-fable-5-1',
    badgeKey: 'ASSISTANT.TOOLS_HELP_ANTHROPIC_FABLE51_BADGE',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_FABLE51_U1',
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_FABLE51_U2',
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_FABLE51_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_ANTHROPIC_OPUS5_NAME',
    apiModelId: 'claude-opus-5',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_OPUS5_U1',
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_OPUS5_U2',
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_OPUS5_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_ANTHROPIC_SONNET5_NAME',
    apiModelId: 'claude-sonnet-5',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_SONNET5_U1',
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_SONNET5_U2',
      'ASSISTANT.TOOLS_HELP_ANTHROPIC_SONNET5_U3'
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

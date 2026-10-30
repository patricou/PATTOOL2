import { AssistantModelGuideRow } from './assistant-model-guide.types';

/**
 * Tools help modal “Which model for which task?” — OpenAI guide.
 * Copy in i18n (ASSISTANT.TOOLS_HELP_OPENAI_*).
 * Flagship lineup as of October 2026: Astra, Sol 6.1, Terra 6.1, Luna.
 */
export const ASSISTANT_OPENAI_MODEL_GUIDE_ROWS: readonly AssistantModelGuideRow[] = [
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_OPENAI_GPT6ASTRA_NAME',
    apiModelId: 'gpt-6-astra',
    badgeKey: 'ASSISTANT.TOOLS_HELP_OPENAI_GPT6ASTRA_BADGE',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT6ASTRA_U1',
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT6ASTRA_U2',
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT6ASTRA_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_OPENAI_GPT56SOL_NAME',
    apiModelId: 'gpt-6.1-sol',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT56SOL_U1',
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT56SOL_U2',
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT56SOL_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_OPENAI_GPT56TERRA_NAME',
    apiModelId: 'gpt-6.1-terra',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT56TERRA_U1',
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT56TERRA_U2',
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT56TERRA_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_OPENAI_GPT56LUNA_NAME',
    apiModelId: 'gpt-6-luna',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT56LUNA_U1',
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT56LUNA_U2',
      'ASSISTANT.TOOLS_HELP_OPENAI_GPT56LUNA_U3'
    ]
  }
];

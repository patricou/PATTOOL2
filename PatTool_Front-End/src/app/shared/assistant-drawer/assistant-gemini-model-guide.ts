import { AssistantModelGuideRow } from './assistant-model-guide.types';

/**
 * Tools help modal “Which model for which task?” — Google Gemini guide.
 * Copy in i18n (ASSISTANT.TOOLS_HELP_GEMINI_*).
 * Argon is the October 2026 flagship. 3.5 Flash is deprecated (use 3.8 Flash).
 * Image generation: Nano Banana 2.1 ({@code gemini-nano-banana-2.1}).
 */
export const ASSISTANT_GEMINI_MODEL_GUIDE_ROWS: readonly AssistantModelGuideRow[] = [
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_GEMINI_4ARGON_NAME',
    apiModelId: 'gemini-4-argon',
    badgeKey: 'ASSISTANT.TOOLS_HELP_GEMINI_4ARGON_BADGE',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_GEMINI_4ARGON_U1',
      'ASSISTANT.TOOLS_HELP_GEMINI_4ARGON_U2',
      'ASSISTANT.TOOLS_HELP_GEMINI_4ARGON_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_GEMINI_38FLASH_NAME',
    apiModelId: 'gemini-3.8-flash',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_GEMINI_38FLASH_U1',
      'ASSISTANT.TOOLS_HELP_GEMINI_38FLASH_U2',
      'ASSISTANT.TOOLS_HELP_GEMINI_38FLASH_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_GEMINI_35FLASHLITE_NAME',
    apiModelId: 'gemini-3.5-flash-lite',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_GEMINI_35FLASHLITE_U1',
      'ASSISTANT.TOOLS_HELP_GEMINI_35FLASHLITE_U2',
      'ASSISTANT.TOOLS_HELP_GEMINI_35FLASHLITE_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_GEMINI_31FLASHIMG_NAME',
    apiModelId: 'gemini-nano-banana-2.1',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_GEMINI_31FLASHIMG_U1',
      'ASSISTANT.TOOLS_HELP_GEMINI_31FLASHIMG_U2',
      'ASSISTANT.TOOLS_HELP_GEMINI_31FLASHIMG_U3'
    ]
  }
];

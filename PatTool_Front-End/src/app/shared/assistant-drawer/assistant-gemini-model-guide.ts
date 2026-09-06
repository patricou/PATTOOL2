import { AssistantModelGuideRow } from './assistant-model-guide.types';

/**
 * Tools help modal “Which model for which task?” — Google Gemini guide.
 * Copy in i18n (ASSISTANT.TOOLS_HELP_GEMINI_*).
 */
export const ASSISTANT_GEMINI_MODEL_GUIDE_ROWS: readonly AssistantModelGuideRow[] = [
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_GEMINI_38FLASH_NAME',
    apiModelId: 'gemini-3.8-flash',
    badgeKey: 'ASSISTANT.TOOLS_HELP_GEMINI_38FLASH_BADGE',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_GEMINI_38FLASH_U1',
      'ASSISTANT.TOOLS_HELP_GEMINI_38FLASH_U2',
      'ASSISTANT.TOOLS_HELP_GEMINI_38FLASH_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_GEMINI_31PRO_NAME',
    apiModelId: 'gemini-3.1-pro-preview',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_GEMINI_31PRO_U1',
      'ASSISTANT.TOOLS_HELP_GEMINI_31PRO_U2',
      'ASSISTANT.TOOLS_HELP_GEMINI_31PRO_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_GEMINI_35FLASH_NAME',
    apiModelId: 'gemini-3.5-flash',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_GEMINI_35FLASH_U1',
      'ASSISTANT.TOOLS_HELP_GEMINI_35FLASH_U2',
      'ASSISTANT.TOOLS_HELP_GEMINI_35FLASH_U3'
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
    apiModelId: 'gemini-3.1-flash-image',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_GEMINI_31FLASHIMG_U1',
      'ASSISTANT.TOOLS_HELP_GEMINI_31FLASHIMG_U2',
      'ASSISTANT.TOOLS_HELP_GEMINI_31FLASHIMG_U3'
    ]
  }
];

import { AssistantModelGuideRow } from './assistant-model-guide.types';

/**
 * Modale aide « Quel modèle pour quelle tâche ? » — guide Google Gemini.
 * Textes dans i18n (ASSISTANT.TOOLS_HELP_GEMINI_*).
 */
export const ASSISTANT_GEMINI_MODEL_GUIDE_ROWS: readonly AssistantModelGuideRow[] = [
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_GEMINI_31PRO_NAME',
    apiModelId: 'gemini-3.1-pro-preview',
    badgeKey: 'ASSISTANT.TOOLS_HELP_GEMINI_31PRO_BADGE',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_GEMINI_31PRO_U1',
      'ASSISTANT.TOOLS_HELP_GEMINI_31PRO_U2',
      'ASSISTANT.TOOLS_HELP_GEMINI_31PRO_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_GEMINI_31FLASHIMG_NAME',
    apiModelId: 'gemini-3.1-flash-image-preview',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_GEMINI_31FLASHIMG_U1',
      'ASSISTANT.TOOLS_HELP_GEMINI_31FLASHIMG_U2',
      'ASSISTANT.TOOLS_HELP_GEMINI_31FLASHIMG_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_GEMINI_25PRO_NAME',
    apiModelId: 'gemini-2.5-pro',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_GEMINI_25PRO_U1',
      'ASSISTANT.TOOLS_HELP_GEMINI_25PRO_U2',
      'ASSISTANT.TOOLS_HELP_GEMINI_25PRO_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_GEMINI_25FLASH_NAME',
    apiModelId: 'gemini-2.5-flash',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_GEMINI_25FLASH_U1',
      'ASSISTANT.TOOLS_HELP_GEMINI_25FLASH_U2',
      'ASSISTANT.TOOLS_HELP_GEMINI_25FLASH_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_GEMINI_20FLASH_NAME',
    apiModelId: 'gemini-2.0-flash',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_GEMINI_20FLASH_U1',
      'ASSISTANT.TOOLS_HELP_GEMINI_20FLASH_U2',
      'ASSISTANT.TOOLS_HELP_GEMINI_20FLASH_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_GEMINI_15FLASH_NAME',
    apiModelId: 'gemini-1.5-flash',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_GEMINI_15FLASH_U1',
      'ASSISTANT.TOOLS_HELP_GEMINI_15FLASH_U2',
      'ASSISTANT.TOOLS_HELP_GEMINI_15FLASH_U3'
    ]
  }
];

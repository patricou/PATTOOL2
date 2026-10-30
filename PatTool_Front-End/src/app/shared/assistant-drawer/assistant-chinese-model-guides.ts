import { AssistantModelGuideRow } from './assistant-model-guide.types';

/**
 * Tools help modal — DeepSeek, Qwen, GLM and Kimi.
 * Copy in i18n (ASSISTANT.TOOLS_HELP_DEEPSEEK_* / QWEN_* / GLM_* / KIMI_*).
 * Chat Completions only: no PatTool web search, image generation, or MCP.
 */
export const ASSISTANT_DEEPSEEK_MODEL_GUIDE_ROWS: readonly AssistantModelGuideRow[] = [
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_DEEPSEEK_V4PRO_NAME',
    apiModelId: 'deepseek-v4-pro',
    badgeKey: 'ASSISTANT.TOOLS_HELP_DEEPSEEK_V4PRO_BADGE',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_DEEPSEEK_V4PRO_U1',
      'ASSISTANT.TOOLS_HELP_DEEPSEEK_V4PRO_U2',
      'ASSISTANT.TOOLS_HELP_DEEPSEEK_V4PRO_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_DEEPSEEK_V4FLASH_NAME',
    apiModelId: 'deepseek-v4-flash',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_DEEPSEEK_V4FLASH_U1',
      'ASSISTANT.TOOLS_HELP_DEEPSEEK_V4FLASH_U2',
      'ASSISTANT.TOOLS_HELP_DEEPSEEK_V4FLASH_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_DEEPSEEK_V41FLASH_NAME',
    apiModelId: 'deepseek-v4.1-flash',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_DEEPSEEK_V41FLASH_U1',
      'ASSISTANT.TOOLS_HELP_DEEPSEEK_V41FLASH_U2',
      'ASSISTANT.TOOLS_HELP_DEEPSEEK_V41FLASH_U3'
    ]
  }
];

export const ASSISTANT_QWEN_MODEL_GUIDE_ROWS: readonly AssistantModelGuideRow[] = [
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_QWEN_38MAX_NAME',
    apiModelId: 'qwen3.8-max',
    badgeKey: 'ASSISTANT.TOOLS_HELP_QWEN_38MAX_BADGE',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_QWEN_38MAX_U1',
      'ASSISTANT.TOOLS_HELP_QWEN_38MAX_U2',
      'ASSISTANT.TOOLS_HELP_QWEN_38MAX_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_QWEN_38FLASH_NAME',
    apiModelId: 'qwen3.8-flash',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_QWEN_38FLASH_U1',
      'ASSISTANT.TOOLS_HELP_QWEN_38FLASH_U2',
      'ASSISTANT.TOOLS_HELP_QWEN_38FLASH_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_QWEN_37PLUS_NAME',
    apiModelId: 'qwen3.7-plus',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_QWEN_37PLUS_U1',
      'ASSISTANT.TOOLS_HELP_QWEN_37PLUS_U2',
      'ASSISTANT.TOOLS_HELP_QWEN_37PLUS_U3'
    ]
  }
];

export const ASSISTANT_GLM_MODEL_GUIDE_ROWS: readonly AssistantModelGuideRow[] = [
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_GLM_53_NAME',
    apiModelId: 'glm-5.3',
    badgeKey: 'ASSISTANT.TOOLS_HELP_GLM_53_BADGE',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_GLM_53_U1',
      'ASSISTANT.TOOLS_HELP_GLM_53_U2',
      'ASSISTANT.TOOLS_HELP_GLM_53_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_GLM_53FLASH_NAME',
    apiModelId: 'glm-5.3-flash',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_GLM_53FLASH_U1',
      'ASSISTANT.TOOLS_HELP_GLM_53FLASH_U2',
      'ASSISTANT.TOOLS_HELP_GLM_53FLASH_U3'
    ]
  }
];

export const ASSISTANT_KIMI_MODEL_GUIDE_ROWS: readonly AssistantModelGuideRow[] = [
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_KIMI_K31PRO_NAME',
    apiModelId: 'kimi-k3.1-pro',
    badgeKey: 'ASSISTANT.TOOLS_HELP_KIMI_K31PRO_BADGE',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_KIMI_K31PRO_U1',
      'ASSISTANT.TOOLS_HELP_KIMI_K31PRO_U2',
      'ASSISTANT.TOOLS_HELP_KIMI_K31PRO_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_KIMI_K3_NAME',
    apiModelId: 'kimi-k3',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_KIMI_K3_U1',
      'ASSISTANT.TOOLS_HELP_KIMI_K3_U2',
      'ASSISTANT.TOOLS_HELP_KIMI_K3_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_KIMI_K27CODE_NAME',
    apiModelId: 'kimi-k2.7-code',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_KIMI_K27CODE_U1',
      'ASSISTANT.TOOLS_HELP_KIMI_K27CODE_U2',
      'ASSISTANT.TOOLS_HELP_KIMI_K27CODE_U3'
    ]
  }
];

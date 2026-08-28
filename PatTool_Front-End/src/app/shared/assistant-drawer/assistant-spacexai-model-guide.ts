import { AssistantModelGuideRow } from './assistant-model-guide.types';

/**
 * Tools help modal “Which model for which task?” — SpaceXAI (Grok) guide.
 * Copy in i18n (ASSISTANT.TOOLS_HELP_SPACEXAI_*).
 */
export type AssistantSpaceXaiModelGuideRow = AssistantModelGuideRow;

export const ASSISTANT_SPACEXAI_MODEL_GUIDE_ROWS: readonly AssistantSpaceXaiModelGuideRow[] = [
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_SPACEXAI_GROK46_NAME',
    apiModelId: 'grok-4.6',
    badgeKey: 'ASSISTANT.TOOLS_HELP_SPACEXAI_GROK46_BADGE',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_SPACEXAI_GROK46_U1',
      'ASSISTANT.TOOLS_HELP_SPACEXAI_GROK46_U2',
      'ASSISTANT.TOOLS_HELP_SPACEXAI_GROK46_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_SPACEXAI_GROK45_NAME',
    apiModelId: 'grok-4.5',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_SPACEXAI_GROK45_U1',
      'ASSISTANT.TOOLS_HELP_SPACEXAI_GROK45_U2',
      'ASSISTANT.TOOLS_HELP_SPACEXAI_GROK45_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_SPACEXAI_GROK43_NAME',
    apiModelId: 'grok-4.3',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_SPACEXAI_GROK43_U1',
      'ASSISTANT.TOOLS_HELP_SPACEXAI_GROK43_U2',
      'ASSISTANT.TOOLS_HELP_SPACEXAI_GROK43_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_SPACEXAI_GROK420_NAME',
    apiModelId: 'grok-4.20-0309-reasoning',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_SPACEXAI_GROK420_U1',
      'ASSISTANT.TOOLS_HELP_SPACEXAI_GROK420_U2',
      'ASSISTANT.TOOLS_HELP_SPACEXAI_GROK420_U3'
    ]
  },
  {
    modelNameKey: 'ASSISTANT.TOOLS_HELP_SPACEXAI_BUILD_NAME',
    apiModelId: 'grok-build-0.1',
    useKeys: [
      'ASSISTANT.TOOLS_HELP_SPACEXAI_BUILD_U1',
      'ASSISTANT.TOOLS_HELP_SPACEXAI_BUILD_U2',
      'ASSISTANT.TOOLS_HELP_SPACEXAI_BUILD_U3'
    ]
  }
];

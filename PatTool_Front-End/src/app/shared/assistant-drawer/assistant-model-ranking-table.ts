/**
 * Tools help modal (ℹ️ near MCP switch): indicative ranking by task type.
 * Copy in i18n (ASSISTANT.TOOLS_HELP_RANK_*).
 */
export interface AssistantModelRankingRowDef {
  readonly taskKey: string;
  readonly goldKey: string;
  readonly silverKey?: string;
  readonly bronzeKey?: string;
}

export const ASSISTANT_MODEL_RANKING_ROWS: readonly AssistantModelRankingRowDef[] = [
  {
    taskKey: 'ASSISTANT.TOOLS_HELP_RANK_T01_TASK',
    goldKey: 'ASSISTANT.TOOLS_HELP_RANK_T01_G',
    silverKey: 'ASSISTANT.TOOLS_HELP_RANK_T01_S',
    bronzeKey: 'ASSISTANT.TOOLS_HELP_RANK_T01_B'
  },
  {
    taskKey: 'ASSISTANT.TOOLS_HELP_RANK_T02_TASK',
    goldKey: 'ASSISTANT.TOOLS_HELP_RANK_T02_G',
    silverKey: 'ASSISTANT.TOOLS_HELP_RANK_T02_S',
    bronzeKey: 'ASSISTANT.TOOLS_HELP_RANK_T02_B'
  },
  {
    taskKey: 'ASSISTANT.TOOLS_HELP_RANK_T03_TASK',
    goldKey: 'ASSISTANT.TOOLS_HELP_RANK_T03_G',
    silverKey: 'ASSISTANT.TOOLS_HELP_RANK_T03_S',
    bronzeKey: 'ASSISTANT.TOOLS_HELP_RANK_T03_B'
  },
  {
    taskKey: 'ASSISTANT.TOOLS_HELP_RANK_T04_TASK',
    goldKey: 'ASSISTANT.TOOLS_HELP_RANK_T04_G',
    silverKey: 'ASSISTANT.TOOLS_HELP_RANK_T04_S'
  },
  {
    taskKey: 'ASSISTANT.TOOLS_HELP_RANK_T05_TASK',
    goldKey: 'ASSISTANT.TOOLS_HELP_RANK_T05_G',
    silverKey: 'ASSISTANT.TOOLS_HELP_RANK_T05_S'
  },
  {
    taskKey: 'ASSISTANT.TOOLS_HELP_RANK_T06_TASK',
    goldKey: 'ASSISTANT.TOOLS_HELP_RANK_T06_G',
    silverKey: 'ASSISTANT.TOOLS_HELP_RANK_T06_S',
    bronzeKey: 'ASSISTANT.TOOLS_HELP_RANK_T06_B'
  },
  {
    taskKey: 'ASSISTANT.TOOLS_HELP_RANK_T07_TASK',
    goldKey: 'ASSISTANT.TOOLS_HELP_RANK_T07_G',
    silverKey: 'ASSISTANT.TOOLS_HELP_RANK_T07_S',
    bronzeKey: 'ASSISTANT.TOOLS_HELP_RANK_T07_B'
  },
  {
    taskKey: 'ASSISTANT.TOOLS_HELP_RANK_T08_TASK',
    goldKey: 'ASSISTANT.TOOLS_HELP_RANK_T08_G',
    silverKey: 'ASSISTANT.TOOLS_HELP_RANK_T08_S',
    bronzeKey: 'ASSISTANT.TOOLS_HELP_RANK_T08_B'
  },
  {
    taskKey: 'ASSISTANT.TOOLS_HELP_RANK_T09_TASK',
    goldKey: 'ASSISTANT.TOOLS_HELP_RANK_T09_G',
    silverKey: 'ASSISTANT.TOOLS_HELP_RANK_T09_S',
    bronzeKey: 'ASSISTANT.TOOLS_HELP_RANK_T09_B'
  },
  {
    taskKey: 'ASSISTANT.TOOLS_HELP_RANK_T10_TASK',
    goldKey: 'ASSISTANT.TOOLS_HELP_RANK_T10_G',
    silverKey: 'ASSISTANT.TOOLS_HELP_RANK_T10_S'
  },
  {
    taskKey: 'ASSISTANT.TOOLS_HELP_RANK_T11_TASK',
    goldKey: 'ASSISTANT.TOOLS_HELP_RANK_T11_G'
  },
  {
    taskKey: 'ASSISTANT.TOOLS_HELP_RANK_T12_TASK',
    goldKey: 'ASSISTANT.TOOLS_HELP_RANK_T12_G',
    silverKey: 'ASSISTANT.TOOLS_HELP_RANK_T12_S',
    bronzeKey: 'ASSISTANT.TOOLS_HELP_RANK_T12_B'
  }
];

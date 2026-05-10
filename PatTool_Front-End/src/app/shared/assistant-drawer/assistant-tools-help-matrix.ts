import {
  ASSISTANT_ANTHROPIC_MODEL_PRESETS,
  ASSISTANT_GEMINI_MODEL_PRESETS,
  ASSISTANT_OPENAI_MODEL_PRESETS
} from './assistant-model-presets';

/** Capacité typique pour l’UI (indicatif — le fournisseur peut refuser selon le compte). */
export type ToolsHelpLevel = 'yes' | 'no' | 'partial';

/** Clés i18n ASSISTANT.* listant les outils/capacités fournisseur non câblés dans PatTool pour ce preset. */
export type AssistantVendorToolsGapKey =
  | 'TOOLS_GAP_OPENAI_FLAGSHIP'
  | 'TOOLS_GAP_OPENAI_O_SERIES'
  | 'TOOLS_GAP_ANTHROPIC'
  | 'TOOLS_GAP_GEMINI';

export interface AssistantToolsHelpModelRow {
  provider: 'openai' | 'anthropic' | 'gemini';
  modelId: string;
  web: ToolsHelpLevel;
  imageGen: ToolsHelpLevel;
  mcp: ToolsHelpLevel;
  vision: ToolsHelpLevel;
  vendorToolsNotInPatToolKey: AssistantVendorToolsGapKey;
}

const openAiFlagship = new Set([
  'gpt-5.5',
  'gpt-5.2',
  'gpt-4.1',
  'gpt-4o',
  'gpt-4o-mini'
]);

function openAiRows(): AssistantToolsHelpModelRow[] {
  return [...ASSISTANT_OPENAI_MODEL_PRESETS].map((id) => {
    const flagship = openAiFlagship.has(id);
    return {
      provider: 'openai',
      modelId: id,
      web: flagship ? 'yes' : 'partial',
      imageGen: flagship ? 'yes' : 'partial',
      mcp: flagship ? 'yes' : 'partial',
      vision: flagship ? 'yes' : 'partial',
      vendorToolsNotInPatToolKey: flagship ? 'TOOLS_GAP_OPENAI_FLAGSHIP' : 'TOOLS_GAP_OPENAI_O_SERIES'
    };
  });
}

function anthropicRows(): AssistantToolsHelpModelRow[] {
  return [...ASSISTANT_ANTHROPIC_MODEL_PRESETS].map((id) => ({
    provider: 'anthropic',
    modelId: id,
    web: 'partial',
    imageGen: 'no',
    mcp: 'no',
    vision: 'yes',
    vendorToolsNotInPatToolKey: 'TOOLS_GAP_ANTHROPIC'
  }));
}

function geminiRows(): AssistantToolsHelpModelRow[] {
  return [...ASSISTANT_GEMINI_MODEL_PRESETS].map((id) => ({
    provider: 'gemini',
    modelId: id,
    web: 'yes',
    imageGen: 'partial',
    mcp: 'no',
    vision: 'yes',
    vendorToolsNotInPatToolKey: 'TOOLS_GAP_GEMINI'
  }));
}

/** Une ligne par modèle preset ; ordre : OpenAI, Anthropic, Gemini. */
export const ASSISTANT_TOOLS_HELP_MODEL_ROWS: readonly AssistantToolsHelpModelRow[] = [
  ...openAiRows(),
  ...anthropicRows(),
  ...geminiRows()
];

export interface AssistantToolsHelpSection {
  provider: 'openai' | 'anthropic' | 'gemini';
  rows: readonly AssistantToolsHelpModelRow[];
}

export function assistantToolsHelpSections(): AssistantToolsHelpSection[] {
  return [
    { provider: 'openai', rows: openAiRows() },
    { provider: 'anthropic', rows: anthropicRows() },
    { provider: 'gemini', rows: geminiRows() }
  ];
}

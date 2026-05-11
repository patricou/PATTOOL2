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

export interface AssistantToolsHelpSection {
  provider: 'openai' | 'anthropic' | 'gemini';
  rows: readonly AssistantToolsHelpModelRow[];
}

/** PatTool : web + image + MCP « oui » typiques sur Responses pour ces familles d’ids OpenAI. */
function openAiFlagshipPatTools(modelId: string): boolean {
  const s = modelId.toLowerCase();
  if (/^o\d/.test(s) || s.startsWith('o1')) {
    return false;
  }
  return (
    s.startsWith('gpt-5') ||
    s.startsWith('gpt-4.1') ||
    s.startsWith('gpt-4o') ||
    s.startsWith('chatgpt-4o')
  );
}

function buildOpenAiRow(modelId: string): AssistantToolsHelpModelRow {
  const flagship = openAiFlagshipPatTools(modelId);
  return {
    provider: 'openai',
    modelId,
    web: flagship ? 'yes' : 'partial',
    imageGen: flagship ? 'yes' : 'partial',
    mcp: flagship ? 'yes' : 'partial',
    vision: flagship ? 'yes' : 'partial',
    vendorToolsNotInPatToolKey: flagship ? 'TOOLS_GAP_OPENAI_FLAGSHIP' : 'TOOLS_GAP_OPENAI_O_SERIES'
  };
}

function buildAnthropicRow(modelId: string): AssistantToolsHelpModelRow {
  return {
    provider: 'anthropic',
    modelId,
    web: 'partial',
    imageGen: 'no',
    mcp: 'no',
    vision: 'yes',
    vendorToolsNotInPatToolKey: 'TOOLS_GAP_ANTHROPIC'
  };
}

function buildGeminiRow(modelId: string): AssistantToolsHelpModelRow {
  const s = modelId.toLowerCase();
  const legacy = s.startsWith('gemini-1.');
  return {
    provider: 'gemini',
    modelId,
    web: legacy ? 'partial' : 'yes',
    imageGen: 'partial',
    mcp: 'no',
    vision: 'yes',
    vendorToolsNotInPatToolKey: 'TOOLS_GAP_GEMINI'
  };
}

/** Fusionne préréglages PatTool + ids API ; préserve l’ordre des presets puis tri alpha pour le reste. */
export function mergeToolsHelpModelIds(
  presets: readonly string[],
  fromApi: string[]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of presets) {
    const id = (raw ?? '').trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  const extra = (fromApi ?? [])
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((id) => id.length > 0 && !seen.has(id))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  for (const id of extra) {
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Tableau d’aide aligné sur les ids réellement exposés par le backend (GET /assistant/models)
 * ainsi que les préréglages hors-ligne.
 */
export function buildToolsHelpSectionsFromCatalog(
  apiOpenai: string[],
  apiAnthropic: string[],
  apiGemini: string[]
): AssistantToolsHelpSection[] {
  const openaiIds = mergeToolsHelpModelIds(ASSISTANT_OPENAI_MODEL_PRESETS, apiOpenai);
  const anthropicIds = mergeToolsHelpModelIds(ASSISTANT_ANTHROPIC_MODEL_PRESETS, apiAnthropic);
  const geminiIds = mergeToolsHelpModelIds(ASSISTANT_GEMINI_MODEL_PRESETS, apiGemini);
  return [
    { provider: 'openai', rows: openaiIds.map(buildOpenAiRow) },
    { provider: 'anthropic', rows: anthropicIds.map(buildAnthropicRow) },
    { provider: 'gemini', rows: geminiIds.map(buildGeminiRow) }
  ];
}

function openAiRows(): AssistantToolsHelpModelRow[] {
  return [...ASSISTANT_OPENAI_MODEL_PRESETS].map((id) => buildOpenAiRow(id));
}

function anthropicRows(): AssistantToolsHelpModelRow[] {
  return [...ASSISTANT_ANTHROPIC_MODEL_PRESETS].map((id) => buildAnthropicRow(id));
}

function geminiRows(): AssistantToolsHelpModelRow[] {
  return [...ASSISTANT_GEMINI_MODEL_PRESETS].map((id) => buildGeminiRow(id));
}

/** Sections avec uniquement les préréglages (hors-ligne ou avant chargement catalogue). */
export function assistantToolsHelpSections(): AssistantToolsHelpSection[] {
  return [
    { provider: 'openai', rows: openAiRows() },
    { provider: 'anthropic', rows: anthropicRows() },
    { provider: 'gemini', rows: geminiRows() }
  ];
}

/** @deprecated Préférer {@link assistantToolsHelpSections} ou {@link buildToolsHelpSectionsFromCatalog}. */
export const ASSISTANT_TOOLS_HELP_MODEL_ROWS: readonly AssistantToolsHelpModelRow[] = [
  ...openAiRows(),
  ...anthropicRows(),
  ...geminiRows()
];

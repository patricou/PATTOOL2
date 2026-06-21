import { AssistantProviderSlug } from '../../services/assistant.service';
import { ASSISTANT_ANTHROPIC_MODEL_GUIDE_ROWS } from './assistant-anthropic-model-guide';
import { ASSISTANT_GEMINI_MODEL_GUIDE_ROWS } from './assistant-gemini-model-guide';
import { ASSISTANT_MISTRAL_MODEL_GUIDE_ROWS } from './assistant-mistral-model-guide';
import { ASSISTANT_MODEL_PICK_ROUTING } from './assistant-model-pick-routing';
import { ASSISTANT_OPENAI_MODEL_GUIDE_ROWS } from './assistant-openai-model-guide';

export interface AssistantModelPickColor {
  readonly bg: string;
  readonly text: string;
  readonly border: string;
}

const ASSISTANT_MODEL_GUIDES_BY_PROVIDER: readonly {
  provider: AssistantProviderSlug;
  rows: readonly { apiModelId: string }[];
}[] = [
  { provider: 'openai', rows: ASSISTANT_OPENAI_MODEL_GUIDE_ROWS },
  { provider: 'anthropic', rows: ASSISTANT_ANTHROPIC_MODEL_GUIDE_ROWS },
  { provider: 'gemini', rows: ASSISTANT_GEMINI_MODEL_GUIDE_ROWS },
  { provider: 'mistral', rows: ASSISTANT_MISTRAL_MODEL_GUIDE_ROWS }
];

/** Stable key: same provider + API id → same color everywhere in the tools help modal. */
export function assistantModelPickColorKey(provider: string, apiModelId: string): string {
  return `${provider.trim().toLowerCase()}:${apiModelId.trim().toLowerCase()}`;
}

function collectAllModelColorKeys(): string[] {
  const keys = new Set<string>();
  const add = (provider: string, apiModelId: string | undefined): void => {
    const id = (apiModelId ?? '').trim();
    if (!id) {
      return;
    }
    keys.add(assistantModelPickColorKey(provider, id));
  };

  for (const routing of Object.values(ASSISTANT_MODEL_PICK_ROUTING)) {
    add(routing.provider, routing.apiModelId);
  }
  for (const section of ASSISTANT_MODEL_GUIDES_BY_PROVIDER) {
    for (const row of section.rows) {
      add(section.provider, row.apiModelId);
    }
  }

  return [...keys].sort((a, b) => a.localeCompare(b));
}

/** Evenly spaced hues: one distinct color per model, no hash collisions. */
function hslModelPickColor(hue: number): AssistantModelPickColor {
  const h = ((hue % 360) + 360) % 360;
  return {
    bg: `hsl(${h} 68% 91%)`,
    text: `hsl(${h} 42% 22%)`,
    border: `hsl(${h} 48% 52%)`
  };
}

function buildModelPickColorMap(): Readonly<Record<string, AssistantModelPickColor>> {
  const keys = collectAllModelColorKeys();
  const n = keys.length;
  const map: Record<string, AssistantModelPickColor> = {};
  keys.forEach((key, index) => {
    const hue = n <= 1 ? 220 : Math.round((index * 360) / n);
    map[key] = hslModelPickColor(hue);
  });
  return Object.freeze(map);
}

export const ASSISTANT_MODEL_PICK_COLOR_BY_KEY: Readonly<Record<string, AssistantModelPickColor>> =
  buildModelPickColorMap();

export function assistantModelPickColor(
  provider: string,
  apiModelId: string
): AssistantModelPickColor | undefined {
  const id = (apiModelId ?? '').trim();
  if (!id) {
    return undefined;
  }
  return ASSISTANT_MODEL_PICK_COLOR_BY_KEY[assistantModelPickColorKey(provider, id)];
}

export function assistantModelPickChipCssVars(
  provider: string,
  apiModelId: string
): Record<string, string> {
  const c = assistantModelPickColor(provider, apiModelId);
  if (!c) {
    return {};
  }
  return {
    '--model-pick-bg': c.bg,
    '--model-pick-text': c.text,
    '--model-pick-border': c.border
  };
}

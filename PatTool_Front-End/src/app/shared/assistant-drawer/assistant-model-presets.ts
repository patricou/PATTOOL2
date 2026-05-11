/**
 * Modèles « courts » affichés en tête du sélecteur (fallback hors-ligne).
 * La liste complète est chargée via GET /api/assistant/models?provider=… (clés API côté serveur).
 */
export const ASSISTANT_OPENAI_MODEL_PRESETS = [
  'gpt-5.5',
  'gpt-5.2',
  'gpt-4.1',
  'gpt-4o',
  'gpt-4o-mini',
  'o4-mini',
  'o3-mini'
] as const;

export const ASSISTANT_ANTHROPIC_MODEL_PRESETS = [
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'claude-haiku-4-5-20251001'
] as const;

export const ASSISTANT_GEMINI_MODEL_PRESETS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash'
] as const;

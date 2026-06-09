/**
 * Short preset models shown at the top of the selector (offline fallback).
 * The full list is loaded via GET /api/assistant/models?provider=… (API keys on the server).
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
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001'
] as const;

export const ASSISTANT_GEMINI_MODEL_PRESETS = [
  'gemini-3.1-pro-preview',
  'gemini-3.1-flash-image-preview',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-1.5-flash'
] as const;

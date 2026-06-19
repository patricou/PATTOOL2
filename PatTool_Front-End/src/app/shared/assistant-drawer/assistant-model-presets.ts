/**
 * Short preset models shown at the top of the selector (offline fallback).
 * The full list is loaded via GET /api/assistant/models?provider=… (API keys on the server).
 * Sorted alphabetically (case-insensitive).
 */
export const ASSISTANT_OPENAI_MODEL_PRESETS = [
  'gpt-4.1',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-5.2',
  'gpt-5.5',
  'o3-mini',
  'o4-mini'
] as const;

export const ASSISTANT_ANTHROPIC_MODEL_PRESETS = [
  'claude-fable-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-8',
  'claude-sonnet-4-6'
] as const;

export const ASSISTANT_GEMINI_MODEL_PRESETS = [
  'gemini-1.5-flash',
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-3.1-flash-image-preview',
  'gemini-3.1-pro-preview'
] as const;

export const ASSISTANT_MISTRAL_MODEL_PRESETS = [
  'codestral-latest',
  'ministral-8b-latest',
  'mistral-large-latest',
  'mistral-small-latest',
  'pixtral-large-latest'
] as const;

/** Default Mistral model (align with server {@code mistral.model}). */
export const ASSISTANT_MISTRAL_DEFAULT_MODEL = 'mistral-large-latest';

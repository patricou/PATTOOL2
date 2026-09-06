/**
 * Short preset models shown at the top of the selector (offline fallback).
 * The full list is loaded via GET /api/assistant/models?provider=… (API keys on the server).
 * Sorted alphabetically (case-insensitive).
 */
export const ASSISTANT_OPENAI_MODEL_PRESETS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-6-astra'
] as const;

export const ASSISTANT_ANTHROPIC_MODEL_PRESETS = [
  'claude-fable-5-1',
  'claude-haiku-4-5-20251001',
  'claude-opus-5',
  'claude-sonnet-5'
] as const;

export const ASSISTANT_GEMINI_MODEL_PRESETS = [
  'gemini-3.1-flash-image',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash'
] as const;

export const ASSISTANT_MISTRAL_MODEL_PRESETS = [
  'codestral-latest',
  'ministral-8b-latest',
  'mistral-large-latest',
  'mistral-medium-latest',
  'mistral-small-latest'
] as const;

/** Default Mistral model (align with server {@code mistral.model}). */
export const ASSISTANT_MISTRAL_DEFAULT_MODEL = 'mistral-medium-latest';

export const ASSISTANT_SPACEXAI_MODEL_PRESETS = [
  'grok-4.20-0309-reasoning',
  'grok-4.20-multi-agent-0309',
  'grok-4.3',
  'grok-4.5',
  'grok-4.6',
  'grok-build-0.1'
] as const;

/** Default SpaceXAI model (align with server {@code spacexai.model}). */
export const ASSISTANT_SPACEXAI_DEFAULT_MODEL = 'grok-4.6';

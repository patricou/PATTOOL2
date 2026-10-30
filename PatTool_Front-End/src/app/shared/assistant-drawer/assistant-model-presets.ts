/**
 * Short preset models shown at the top of the selector (offline fallback).
 * The full list is loaded via GET /api/assistant/models?provider=… (API keys on the server).
 * Sorted alphabetically (case-insensitive). Ids are the current provider API ids (October 2026).
 */
export const ASSISTANT_OPENAI_MODEL_PRESETS = [
  'gpt-6-astra',
  'gpt-6-luna',
  'gpt-6.1-sol',
  'gpt-6.1-terra'
] as const;

/** Default OpenAI model when the server does not send one. */
export const ASSISTANT_OPENAI_DEFAULT_MODEL = 'gpt-6-astra';

export const ASSISTANT_ANTHROPIC_MODEL_PRESETS = [
  'claude-fable-5-1',
  'claude-haiku-5-5',
  'claude-opus-5-5',
  'claude-sonnet-5-5'
] as const;

/** Balanced default (successor of claude-sonnet-5). Opus 5.5 is the quality pick. */
export const ASSISTANT_ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';

export const ASSISTANT_GEMINI_MODEL_PRESETS = [
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-4-argon',
  'gemini-nano-banana-2.1'
] as const;

/** Default Gemini chat model (align with server {@code gemini.model}). */
export const ASSISTANT_GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';

export const ASSISTANT_MISTRAL_MODEL_PRESETS = [
  'codestral-latest',
  'ministral-8b-2512',
  'mistral-large-4',
  'mistral-small-2603'
] as const;

/** Default Mistral model (align with server {@code mistral.model}). */
export const ASSISTANT_MISTRAL_DEFAULT_MODEL = 'mistral-large-4';

export const ASSISTANT_SPACEXAI_MODEL_PRESETS = [
  'grok-4.20-0309-reasoning',
  'grok-4.20-multi-agent-0309',
  'grok-4.3',
  'grok-4.5',
  'grok-4.6',
  'grok-4.7',
  'grok-build-0.1'
] as const;

/** Default SpaceXAI model (align with server {@code spacexai.model}). */
export const ASSISTANT_SPACEXAI_DEFAULT_MODEL = 'grok-4.7';

export const ASSISTANT_DEEPSEEK_MODEL_PRESETS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-v4.1-flash'
] as const;

/** Default DeepSeek model (align with server {@code deepseek.model}). */
export const ASSISTANT_DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-pro';

export const ASSISTANT_QWEN_MODEL_PRESETS = [
  'qwen3.7-plus',
  'qwen3.8-flash',
  'qwen3.8-max'
] as const;

/** Default Qwen model (align with server {@code qwen.model}). */
export const ASSISTANT_QWEN_DEFAULT_MODEL = 'qwen3.8-max';

export const ASSISTANT_GLM_MODEL_PRESETS = ['glm-5.3', 'glm-5.3-flash'] as const;

/** Default GLM model (align with server {@code glm.model}). Text-only; flash is the vision id. */
export const ASSISTANT_GLM_DEFAULT_MODEL = 'glm-5.3';

export const ASSISTANT_KIMI_MODEL_PRESETS = [
  'kimi-k2.7-code',
  'kimi-k3',
  'kimi-k3.1-pro'
] as const;

/** Default Kimi model (align with server {@code kimi.model}). */
export const ASSISTANT_KIMI_DEFAULT_MODEL = 'kimi-k3.1-pro';

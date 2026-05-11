/**
 * Synthèses « à quoi sert ce modèle » alignées sur les pages modèles des fournisseurs
 * (OpenAI Models, Claude Models, Gemini models). Les formulations peuvent évoluer côté vendor.
 */
export type ToolsHelpModelProvider = 'openai' | 'anthropic' | 'gemini';

export const ASSISTANT_TOOLS_HELP_VENDOR_MODELS_DOC_URL: Record<ToolsHelpModelProvider, string> = {
  openai: 'https://platform.openai.com/docs/models',
  anthropic: 'https://docs.claude.com/en/docs/about-claude/models',
  gemini: 'https://ai.google.dev/gemini-api/docs/models/gemini'
};

/** Variantes localisées des hubs documentation (Claude & Google proposent souvent ?hl= / /fr/). */
export function assistantToolsHelpVendorModelsDocUrlForLang(
  provider: ToolsHelpModelProvider,
  langLower: string
): string {
  const fr = langLower.startsWith('fr');
  if (provider === 'anthropic') {
    return fr
      ? 'https://docs.claude.com/fr/docs/about-claude/models'
      : 'https://docs.claude.com/en/docs/about-claude/models';
  }
  if (provider === 'gemini') {
    return fr
      ? 'https://ai.google.dev/gemini-api/docs/models/gemini?hl=fr'
      : 'https://ai.google.dev/gemini-api/docs/models/gemini';
  }
  return ASSISTANT_TOOLS_HELP_VENDOR_MODELS_DOC_URL.openai;
}

export interface AssistantToolsHelpModelRoleCopy {
  fr: string;
  en: string;
}

export const ASSISTANT_TOOLS_HELP_MODEL_ROLE_COPY: Record<
  ToolsHelpModelProvider,
  Record<string, AssistantToolsHelpModelRoleCopy>
> = {
  openai: {
    'gpt-5.5': {
      fr: 'Modèle phare récent : raisonnement, code et usage général exigeant ; multimodal (texte et images) selon la doc OpenAI.',
      en: 'Latest-generation frontier-class model for demanding reasoning, coding, and general tasks; multimodal (text and image) per OpenAI’s model docs.'
    },
    'gpt-5.2': {
      fr: 'Très haute capacité avec un meilleur compromis coût / latence que les modèles phares maximaux (famille GPT‑5).',
      en: 'High-capability GPT‑5–family model with a stronger cost and latency trade-off vs the largest flagship tier.'
    },
    'gpt-4.1': {
      fr: 'Famille GPT‑4 enrichie : suit mieux les consignes, code et contextes longs ; pensé pour production et agents.',
      en: 'GPT‑4 family upgrade focused on instruction following, coding, and long-context workloads; aimed at production assistants.'
    },
    'gpt-4o': {
      fr: 'Modèle « omni » rapide, multimodal (texte + vision) dans une même API ; bon équilibre qualité / réactivité pour le chat.',
      en: 'Fast “omni” model handling text and vision in one stack; strong default for responsive multimodal chat.'
    },
    'gpt-4o-mini': {
      fr: 'Variante allégée de GPT‑4o : moindre coût et latence pour fort volume ou tâches simples.',
      en: 'Lower-cost, lower-latency variant of GPT‑4o for scaled-out or lighter workloads.'
    },
    'o4-mini': {
      fr: 'Modèle de raisonnement (série o) : favorisé pour maths, logique, sciences et enchaînements d’étapes complexes.',
      en: 'Reasoning-focused o-series model geared toward STEM, multi-step logic, and harder analytical prompts.'
    },
    'o3-mini': {
      fr: 'Raisonnement compact : bon rapport qualité / prix pour problèmes nécessitant réflexion sans le coût des très gros modèles.',
      en: 'Compact reasoning model balancing depth of thought with cost and speed vs larger o-series variants.'
    }
  },
  anthropic: {
    'claude-sonnet-4-6': {
      fr: 'Modèle équilibré vitesse / intelligence : coding, agents et grands contextes ; usage quotidien « flagship » côté Claude.',
      en: 'Balanced speed and capability for coding, agents, and long contexts; Claude’s general-purpose workhorse tier.'
    },
    'claude-opus-4-7': {
      fr: 'Capacité maximale Claude : analyse profonde, recherche, workflows complexes et tâches où la qualité prime sur la vitesse.',
      en: 'Highest Claude tier for deep research, complex analysis, and quality-first long-running tasks.'
    },
    'claude-haiku-4-5-20251001': {
      fr: 'Profil « rapide » : latence faible, coût modéré ; qualité proche des gros modèles pour chat et automatisation.',
      en: 'Fast, cost-efficient tier with near-frontier quality for latency-sensitive chat and automation.'
    }
  },
  gemini: {
    'gemini-2.5-flash': {
      fr: 'Modèle « Flash » 2.5 : latence basse, bon rapport prix / performance, multimodal (texte, image, audio, vidéo selon offre).',
      en: 'Gemini 2.5 Flash: low-latency, price-performance workhorse; multimodal inputs (per Google’s Gemini model docs).'
    },
    'gemini-2.5-pro': {
      fr: 'Modèle Pro 2.5 : raisonnement et tâches complexes, grands contextes ; choix pour analyses exigeantes.',
      en: 'Gemini 2.5 Pro: advanced reasoning, complex prompts, and long multimodal context for demanding workloads.'
    },
    'gemini-2.0-flash': {
      fr: 'Génération Flash 2.0 : modèle rapide et multimodal de la famille 2.0, encore pertinent pour beaucoup de cas d’usage.',
      en: 'Gemini 2.0 Flash: prior-gen fast multimodal model still suitable for many assistant and vision+text tasks.'
    }
  }
};

const GENERIC_OPENAI_REASONING: AssistantToolsHelpModelRoleCopy = {
  fr: 'Modèle « raisonnement » (famille o*) : conçu pour les tâches à étapes, maths, sciences et logique ; peut se comporter différemment des GPT classiques sur la navigation web / outils Responses.',
  en: 'Reasoning-focused o-series model for multi-step STEM, logic, and analytical work; behaviour on PatTool’s web/image/MCP tools may differ from flagship GPT models.'
};

const GENERIC_OPENAI_GPT5: AssistantToolsHelpModelRoleCopy = {
  fr: 'Famille GPT‑5 : modèles récents haute capacité pour le raisonnement, le code et le multimodal ; voir la fiche OpenAI pour la variante exacte (mini, etc.).',
  en: 'GPT‑5 family: high-capability models for reasoning, coding, and multimodal work; check OpenAI’s model page for this exact id (mini, nano, etc.).'
};

const GENERIC_OPENAI_GPT4_CLASS: AssistantToolsHelpModelRoleCopy = {
  fr: 'Famille GPT‑4 / chat complétions : modèle généraliste pour dialogue et tâches texte ; la prise en charge vision et outils PatTool peut être plus limitée que sur GPT‑4o / GPT‑5.',
  en: 'GPT‑4–class chat model for general dialogue and text; vision and PatTool Responses tools may be more limited than on GPT‑4o / GPT‑5 tiers.'
};

const GENERIC_OPENAI_GPT35: AssistantToolsHelpModelRoleCopy = {
  fr: 'Modèle historique rapide et économique pour le chat texte ; pas le premier choix pour la vision ou les outils avancés.',
  en: 'Legacy fast, cost-efficient chat model; not the primary choice for advanced vision or tool-heavy workflows.'
};

const GENERIC_OPENAI_FALLBACK: AssistantToolsHelpModelRoleCopy = {
  fr: 'Modèle OpenAI exposé par l’API ; capacités exactes (vision, outils, contexte) selon la fiche « Models » OpenAI pour cet id.',
  en: 'OpenAI model returned by the API; exact capabilities (vision, tools, context) are described on OpenAI’s Models page for this id.'
};

const GENERIC_CLAUDE_OPUS: AssistantToolsHelpModelRoleCopy = {
  fr: 'Famille Opus : niveau de capacité maximal côté Claude pour tâches complexes et longues ; peut inclure plusieurs versions datées ou alias.',
  en: 'Opus family: Claude’s highest-capability tier for demanding, long-running tasks; ids may include dated snapshots or aliases.'
};

const GENERIC_CLAUDE_SONNET: AssistantToolsHelpModelRoleCopy = {
  fr: 'Famille Sonnet : équilibre performance / latence pour le travail quotidien, le code et les grands contextes.',
  en: 'Sonnet family: balanced capability and speed for everyday work, coding, and long contexts.'
};

const GENERIC_CLAUDE_HAIKU: AssistantToolsHelpModelRoleCopy = {
  fr: 'Famille Haiku : profil rapide et économique, adapté au chat et à l’automatisation à grande échelle.',
  en: 'Haiku family: fast, efficient tier suited to chat and large-scale automation.'
};

const GENERIC_CLAUDE_FALLBACK: AssistantToolsHelpModelRoleCopy = {
  fr: 'Modèle Claude listé par l’API Anthropic ; rôle précis (Opus / Sonnet / Haiku, date de snapshot) sur la page « Models » de Claude.',
  en: 'Claude model id from Anthropic’s API; see Claude’s Models documentation for the exact tier and snapshot.'
};

const GENERIC_GEMINI_FLASH: AssistantToolsHelpModelRoleCopy = {
  fr: 'Famille Flash : latence réduite et bon rapport coût / performance ; souvent multimodal (texte, image, etc. selon la variante).',
  en: 'Flash family: low-latency, cost-performance Gemini tier; typically multimodal (text, image, etc., per variant).'
};

const GENERIC_GEMINI_PRO: AssistantToolsHelpModelRoleCopy = {
  fr: 'Famille Pro : raisonnement et contexte renforcés pour tâches exigeantes ; préférer quand la qualité prime sur la vitesse.',
  en: 'Pro family: stronger reasoning and context for demanding tasks; prefer when quality beats latency.'
};

const GENERIC_GEMINI_IMAGE: AssistantToolsHelpModelRoleCopy = {
  fr: 'Variante orientée génération ou édition d’images (selon Google) ; PatTool peut aussi utiliser un modèle image serveur séparé pour certaines fonctions.',
  en: 'Image-focused Gemini variant per Google; PatTool may still use a separate server image model for some flows.'
};

const GENERIC_GEMINI_15: AssistantToolsHelpModelRoleCopy = {
  fr: 'Famille Gemini 1.5 : modèles aboutissants avec long contexte ; outils PatTool (ex. recherche web) peuvent utiliser des chemins « legacy » côté API.',
  en: 'Gemini 1.5 family: mature long-context models; PatTool web search may use legacy tool paths on the API.'
};

const GENERIC_GEMINI_FALLBACK: AssistantToolsHelpModelRoleCopy = {
  fr: 'Modèle Gemini renvoyé par l’API ; fiche détaillée sur la documentation « Gemini models » de Google AI.',
  en: 'Gemini model id from Google’s API; see Google AI Gemini model docs for details.'
};

/**
 * Texte descriptif pour la modale d’aide : correspondance exacte puis familles d’ids (API / versions datées).
 */
export function resolveAssistantToolsHelpModelRoleCopy(
  provider: ToolsHelpModelProvider,
  modelId: string
): AssistantToolsHelpModelRoleCopy {
  const id = (modelId ?? '').trim();
  const table = ASSISTANT_TOOLS_HELP_MODEL_ROLE_COPY[provider];
  const exact = id && table[id];
  if (exact) {
    return exact;
  }
  const s = id.toLowerCase();

  if (provider === 'openai') {
    if (/^o\d/.test(s) || s.startsWith('o1')) {
      return GENERIC_OPENAI_REASONING;
    }
    if (s.startsWith('gpt-5')) {
      return GENERIC_OPENAI_GPT5;
    }
    if (s.startsWith('gpt-3.5')) {
      return GENERIC_OPENAI_GPT35;
    }
    if (s.startsWith('gpt-4')) {
      return GENERIC_OPENAI_GPT4_CLASS;
    }
    if (s.startsWith('gpt-') || s.startsWith('chatgpt-')) {
      return GENERIC_OPENAI_FALLBACK;
    }
    return GENERIC_OPENAI_FALLBACK;
  }

  if (provider === 'anthropic') {
    if (s.includes('opus')) {
      return GENERIC_CLAUDE_OPUS;
    }
    if (s.includes('sonnet')) {
      return GENERIC_CLAUDE_SONNET;
    }
    if (s.includes('haiku')) {
      return GENERIC_CLAUDE_HAIKU;
    }
    if (s.startsWith('claude-')) {
      return GENERIC_CLAUDE_FALLBACK;
    }
    return GENERIC_CLAUDE_FALLBACK;
  }

  if (provider === 'gemini') {
    if (s.includes('image')) {
      return GENERIC_GEMINI_IMAGE;
    }
    if (s.includes('gemini-1.') || s.includes('gemini-exp')) {
      return GENERIC_GEMINI_15;
    }
    if (s.includes('flash')) {
      return GENERIC_GEMINI_FLASH;
    }
    if (s.includes('pro')) {
      return GENERIC_GEMINI_PRO;
    }
    if (s.startsWith('gemini')) {
      return GENERIC_GEMINI_FALLBACK;
    }
    return GENERIC_GEMINI_FALLBACK;
  }

  return GENERIC_OPENAI_FALLBACK;
}

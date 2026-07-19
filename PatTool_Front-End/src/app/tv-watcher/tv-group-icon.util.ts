/**
 * Icons + i18n keys for IPTV {@code group-title} categories (iptv-org + FR overlays).
 * Native {@code <option>} cannot host Font Awesome — use {@link groupIconEmoji} there.
 */

export interface TvGroupIcon {
  /** Font Awesome 4 class, e.g. {@code fa-newspaper-o} */
  fa: string;
  /** Emoji shown in {@code <select>} options */
  emoji: string;
  /** ngx-translate key under {@code TV.CAT.*}, or null to keep the raw API name */
  i18nKey: string | null;
}

const DEFAULT_ICON: TvGroupIcon = {
  fa: 'fa-television',
  emoji: '📺',
  i18nKey: null
};

/** Ordered rules: first keyword match wins (lowercase, accent-stripped haystack). */
const RULES: { match: RegExp; icon: TvGroupIcon }[] = [
  { match: /\b(news|info|information|actualite|journal)\b/, icon: { fa: 'fa-newspaper-o', emoji: '📰', i18nKey: 'TV.CAT.NEWS' } },
  { match: /\b(sport|sports|football|soccer)\b/, icon: { fa: 'fa-futbol-o', emoji: '⚽', i18nKey: 'TV.CAT.SPORTS' } },
  { match: /\b(kid|kids|children|child|jeunesse|youth|cartoon|animation|anime)\b/, icon: { fa: 'fa-child', emoji: '🧒', i18nKey: 'TV.CAT.KIDS' } },
  { match: /\b(radio)\b/, icon: { fa: 'fa-headphones', emoji: '📻', i18nKey: 'TV.CAT.RADIO' } },
  { match: /\b(music|musique)\b/, icon: { fa: 'fa-music', emoji: '🎵', i18nKey: 'TV.CAT.MUSIC' } },
  { match: /\b(movie|movies|film|films|cinema)\b/, icon: { fa: 'fa-film', emoji: '🎬', i18nKey: 'TV.CAT.MOVIES' } },
  { match: /\b(serie|series|drama)\b/, icon: { fa: 'fa-clone', emoji: '🎞️', i18nKey: 'TV.CAT.SERIES' } },
  { match: /\b(documentar|docu|discovery|science)\b/, icon: { fa: 'fa-graduation-cap', emoji: '🎓', i18nKey: 'TV.CAT.DOCUMENTARY' } },
  { match: /\b(educat|learning|ecole)\b/, icon: { fa: 'fa-book', emoji: '📚', i18nKey: 'TV.CAT.EDUCATION' } },
  { match: /\b(entertain|divertissement|variety|spectacle)\b/, icon: { fa: 'fa-star', emoji: '✨', i18nKey: 'TV.CAT.ENTERTAINMENT' } },
  { match: /\b(culture|cultural|art|theatre)\b/, icon: { fa: 'fa-university', emoji: '🎭', i18nKey: 'TV.CAT.CULTURE' } },
  { match: /\b(religio|faith|church|islam|christian)\b/, icon: { fa: 'fa-bell', emoji: '🕊️', i18nKey: 'TV.CAT.RELIGIOUS' } },
  { match: /\b(shop|shopping|teleshop)\b/, icon: { fa: 'fa-shopping-cart', emoji: '🛒', i18nKey: 'TV.CAT.SHOPPING' } },
  { match: /\b(cook|cuisine|food|gastronom)\b/, icon: { fa: 'fa-cutlery', emoji: '🍳', i18nKey: 'TV.CAT.COOKING' } },
  { match: /\b(business|finance|econom)\b/, icon: { fa: 'fa-line-chart', emoji: '📈', i18nKey: 'TV.CAT.BUSINESS' } },
  { match: /\b(weather|meteo)\b/, icon: { fa: 'fa-cloud', emoji: '🌤️', i18nKey: 'TV.CAT.WEATHER' } },
  { match: /\b(travel|voyage|touris)\b/, icon: { fa: 'fa-plane', emoji: '✈️', i18nKey: 'TV.CAT.TRAVEL' } },
  { match: /\b(lifestyle|life style|wellness|sante)\b/, icon: { fa: 'fa-heart', emoji: '💖', i18nKey: 'TV.CAT.LIFESTYLE' } },
  { match: /\b(local|regional|region)\b/, icon: { fa: 'fa-map-marker', emoji: '📍', i18nKey: 'TV.CAT.LOCAL' } },
  { match: /\b(comedy|humour|humor)\b/, icon: { fa: 'fa-smile-o', emoji: '😄', i18nKey: 'TV.CAT.COMEDY' } },
  { match: /\b(legislat|parlement|politic|gouvernement)\b/, icon: { fa: 'fa-institution', emoji: '🏛️', i18nKey: 'TV.CAT.LEGISLATIVE' } },
  { match: /\b(outdoor|nature|hunt|fish)\b/, icon: { fa: 'fa-tree', emoji: '🌲', i18nKey: 'TV.CAT.OUTDOOR' } },
  { match: /\b(classic|nostalgie|retro)\b/, icon: { fa: 'fa-history', emoji: '📼', i18nKey: 'TV.CAT.CLASSIC' } },
  { match: /\b(family|famille)\b/, icon: { fa: 'fa-users', emoji: '👨‍👩‍👧', i18nKey: 'TV.CAT.FAMILY' } },
  { match: /\b(general|generaliste|undefined|other|autre)\b/, icon: { fa: 'fa-television', emoji: '📡', i18nKey: 'TV.CAT.GENERAL' } }
];

function normalizeGroup(group: string): string {
  return group
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function resolveTvGroupIcon(group: string | null | undefined): TvGroupIcon {
  const raw = (group || '').trim();
  if (!raw) {
    return { fa: 'fa-th-large', emoji: '🗂️', i18nKey: 'TV.CAT.ALL' };
  }
  const hay = normalizeGroup(raw);
  for (const rule of RULES) {
    if (rule.match.test(hay)) {
      return rule.icon;
    }
  }
  return DEFAULT_ICON;
}

export function groupIconFaClass(group: string | null | undefined): string {
  return resolveTvGroupIcon(group).fa;
}

export function groupIconEmoji(group: string | null | undefined): string {
  return resolveTvGroupIcon(group).emoji;
}

/** i18n key for a known category, or null to display the raw API label. */
export function groupI18nKey(group: string | null | undefined): string | null {
  return resolveTvGroupIcon(group).i18nKey;
}

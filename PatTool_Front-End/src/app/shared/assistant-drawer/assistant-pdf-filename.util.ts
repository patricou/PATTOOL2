/** Nombre de mots du résumé question dans le nom de fichier PDF assistant. */
const PDF_QUESTION_SUMMARY_WORDS = 8;

const PDF_SLUG_MAX_LEN = 80;

function formatPdfTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}`;
}

/** Retire le Markdown léger pour extraire un libellé fichier. */
export function plainTextForPdfFilename(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_~>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Slug ASCII (jusqu’à 8 mots) à partir d’un texte question utilisateur. */
export function questionSummarySlug(
  text: string | null | undefined,
  maxWords = PDF_QUESTION_SUMMARY_WORDS
): string {
  const plain = plainTextForPdfFilename(text ?? '');
  if (!plain) {
    return '';
  }
  const words = plain.split(/\s+/).filter(Boolean).slice(0, maxWords);
  if (words.length === 0) {
    return '';
  }
  return words
    .join('-')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, PDF_SLUG_MAX_LEN);
}

export function firstUserMessagePlainText(
  messages: ReadonlyArray<{ role: string; content?: string | null }>
): string {
  const turn = messages.find(
    (m) => m.role === 'user' && (m.content?.trim() ?? '').length > 0
  );
  return turn?.content?.trim() ?? '';
}

/** ex. {@code pat-assistant-quelle-meteo-paris-aujourd-hui-20260619-1853.pdf} */
export function buildAssistantPdfDownloadFilename(
  messages: ReadonlyArray<{ role: string; content?: string | null }>,
  exportedAt: Date = new Date()
): string {
  const slug = questionSummarySlug(firstUserMessagePlainText(messages));
  const ts = formatPdfTimestamp(exportedAt);
  return slug ? `pat-assistant-${slug}-${ts}.pdf` : `pat-assistant-${ts}.pdf`;
}

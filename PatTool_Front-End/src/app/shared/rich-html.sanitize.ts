/**
 * Drops active content from rich text before it is marked as trusted HTML.
 * Quill markup (paragraphs, spans, links, images) is kept.
 */
const DROP_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
  'frame',
  'frameset',
  'style'
]);

export function sanitizeRichHtml(html: string | null | undefined): string {
  if (!html) {
    return '';
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase();
    if (DROP_TAGS.has(tag)) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'target' && /^_?(top|parent)$/i.test(value.trim())) {
        el.setAttribute('target', '_blank');
        continue;
      }
      if (name === 'href' || name === 'src' || name === 'xlink:href' || name === 'action') {
        if (!isSafeUrl(value, name === 'src' || name === 'xlink:href')) {
          el.removeAttribute(attr.name);
        }
        continue;
      }
      if (name === 'style') {
        const cleaned = value
          .replace(/expression\s*\([^)]*\)/gi, '')
          .replace(/javascript\s*:/gi, '')
          .replace(/url\s*\(\s*(['"]?)\s*(?!https?:|data:image\/)[^)]*\)/gi, '');
        if (!cleaned.trim()) {
          el.removeAttribute('style');
        } else {
          el.setAttribute('style', cleaned);
        }
      }
    }
  }
  return doc.body.innerHTML;
}

function isSafeUrl(value: string, allowDataImage: boolean): boolean {
  const compact = value.replace(/[\u0000-\u001F\s]+/g, '');
  const lower = compact.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('vbscript:') || lower.startsWith('data:text')) {
    return false;
  }
  if (lower.startsWith('data:')) {
    return allowDataImage && /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(compact);
  }
  if (
    lower.startsWith('http:') ||
    lower.startsWith('https:') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('#') ||
    lower.startsWith('/')
  ) {
    return true;
  }
  return !/^[a-z][a-z0-9+.-]*:/i.test(compact);
}
